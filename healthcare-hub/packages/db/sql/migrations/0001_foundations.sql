-- 0001 Foundations: tenancy, identity, idempotency, hash-chained audit log, RLS.
-- Forward-only. Never edit after it has been applied anywhere (checksum enforced by the runner).
-- Runs as hub_migrator (table owner). The app connects as hub_app (not owner, FORCE RLS).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- UUID v7 (time-ordered) generator; Postgres 16 has no built-in uuidv7().
CREATE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid
$$;

-- Request context set by withTenant()/withIdentity() with set_config(..., true) (transaction local).
CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Append-only guard: applies to every role, including the table owner.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only (% not permitted)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE user_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'LEAVER');
CREATE TYPE location_type AS ENUM ('PATIENT_FACING', 'ADMIN_ONLY');
CREATE TYPE device_platform AS ENUM ('IOS', 'ANDROID');
CREATE TYPE actor_type AS ENUM ('USER', 'SYSTEM', 'SUPPORT');

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE organisation (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  sector_packs  text[] NOT NULL DEFAULT '{}',
  regulator     text NOT NULL DEFAULT 'CQC',
  timezone      text NOT NULL DEFAULT 'Europe/London',
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid
);

CREATE TABLE location (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  address          jsonb NOT NULL DEFAULT '{}'::jsonb,
  type             location_type NOT NULL DEFAULT 'PATIENT_FACING',
  registered       boolean NOT NULL DEFAULT false,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid
);
CREATE INDEX location_org_idx ON location (organisation_id, name);

-- ---------------------------------------------------------------------------
-- Identity (users are global; access is granted per organisation via membership)
-- NOTE: app_user is deliberately NOT a tenant table (a person can belong to several
-- organisations). It uses ENABLE (not FORCE) RLS so that the owner-owned SECURITY DEFINER
-- login functions below can resolve a user before any organisation context exists.
-- ---------------------------------------------------------------------------
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  idp_subject    text NOT NULL UNIQUE,
  email          text NOT NULL CHECK (email = lower(email)),
  display_name   text NOT NULL,
  status         user_status NOT NULL DEFAULT 'INVITED',
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid
);
CREATE UNIQUE INDEX app_user_email_idx ON app_user (email);

CREATE TABLE permission (
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+(\.[a-z_]+){1,3}$'),
  description  text NOT NULL DEFAULT ''
);

CREATE TABLE role (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid REFERENCES organisation(id),   -- NULL = system role
  key              text NOT NULL,
  name             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid
);
CREATE UNIQUE INDEX role_key_idx ON role (coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

CREATE TABLE role_permission (
  role_id         uuid NOT NULL REFERENCES role(id),
  permission_key  text NOT NULL REFERENCES permission(key),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE membership (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  location_id      uuid REFERENCES location(id),        -- NULL = all locations in the organisation
  role_id          uuid NOT NULL REFERENCES role(id),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX membership_user_idx ON membership (user_id, organisation_id);
CREATE INDEX membership_org_idx ON membership (organisation_id, role_id);

CREATE TABLE device_session (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  device_id     text NOT NULL,
  platform      device_platform NOT NULL,
  push_token    text,
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

CREATE TABLE support_access_grant (               -- [immutable]
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  support_user_id  uuid NOT NULL REFERENCES app_user(id),
  approved_by      uuid NOT NULL REFERENCES app_user(id),
  reason           text NOT NULL CHECK (length(reason) >= 10),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '8 hours')
);
CREATE INDEX support_access_grant_org_idx ON support_access_grant (organisation_id, support_user_id, ends_at);
CREATE TRIGGER support_access_grant_immutable
  BEFORE UPDATE OR DELETE ON support_access_grant FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Idempotency (all POSTs from mobile)
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_key (
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash     text NOT NULL,
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id, key)
);

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained per organisation.
-- seq/prev_hash/hash are computed by the BEFORE INSERT trigger, so the application cannot
-- forge or skip them. hub_app has INSERT/SELECT only; triggers block UPDATE/DELETE/TRUNCATE
-- for every role.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  seq              bigint NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_id    uuid,
  actor_type       actor_type NOT NULL DEFAULT 'USER',
  action           text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+){1,3}$'),
  entity           text NOT NULL,
  entity_id        text NOT NULL,
  before_hash      text,
  after_summary    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- never contains PII
  ip_hash          text,
  prev_hash        text NOT NULL,
  hash             text NOT NULL,
  UNIQUE (organisation_id, seq)
);
CREATE INDEX audit_log_entity_idx ON audit_log (organisation_id, entity, entity_id);
CREATE INDEX audit_log_actor_idx ON audit_log (organisation_id, actor_user_id, occurred_at);

CREATE FUNCTION audit_canonical(r audit_log) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'seq', r.seq,
    'organisation_id', r.organisation_id,
    'occurred_at', to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_user_id', r.actor_user_id,
    'actor_type', r.actor_type,
    'action', r.action,
    'entity', r.entity,
    'entity_id', r.entity_id,
    'before_hash', r.before_hash,
    'after_summary', r.after_summary,
    'ip_hash', r.ip_hash
  )::text
$$;

CREATE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_seq  bigint;
  v_prev text;
BEGIN
  -- Serialise appends per organisation so seq is gap-free and the chain is linear.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organisation_id::text, 0));
  SELECT a.seq, a.hash INTO v_seq, v_prev
    FROM audit_log a WHERE a.organisation_id = NEW.organisation_id
    ORDER BY a.seq DESC LIMIT 1;
  NEW.seq := coalesce(v_seq, 0) + 1;
  NEW.prev_hash := coalesce(v_prev, repeat('0', 64));
  NEW.occurred_at := date_trunc('milliseconds', coalesce(NEW.occurred_at, clock_timestamp()));
  NEW.hash := encode(sha256(convert_to(NEW.prev_hash || audit_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_chain_trg BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Recomputes the whole chain for one organisation (RLS applies: caller must have org context).
-- Returns the first broken sequence number, or no rows when intact.
CREATE FUNCTION audit_verify_chain(p_org uuid)
RETURNS TABLE (broken_seq bigint, reason text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log;
  v_prev text := repeat('0', 64);
  v_expected_seq bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_log WHERE organisation_id = p_org ORDER BY seq LOOP
    IF r.seq <> v_expected_seq THEN
      broken_seq := v_expected_seq; reason := 'sequence gap'; RETURN NEXT; RETURN;
    END IF;
    IF r.prev_hash <> v_prev THEN
      broken_seq := r.seq; reason := 'prev_hash mismatch'; RETURN NEXT; RETURN;
    END IF;
    IF r.hash <> encode(sha256(convert_to(r.prev_hash || audit_canonical(r), 'UTF8')), 'hex') THEN
      broken_seq := r.seq; reason := 'hash mismatch'; RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
    v_expected_seq := v_expected_seq + 1;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER organisation_updated BEFORE UPDATE ON organisation FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER location_updated     BEFORE UPDATE ON location     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER app_user_updated     BEFORE UPDATE ON app_user     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER role_updated         BEFORE UPDATE ON role         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER membership_updated   BEFORE UPDATE ON membership   FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security (second line of defence; all fail closed when no context is set)
-- ---------------------------------------------------------------------------
ALTER TABLE organisation        ENABLE ROW LEVEL SECURITY; ALTER TABLE organisation        FORCE ROW LEVEL SECURITY;
ALTER TABLE location            ENABLE ROW LEVEL SECURITY; ALTER TABLE location            FORCE ROW LEVEL SECURITY;
ALTER TABLE role                ENABLE ROW LEVEL SECURITY; ALTER TABLE role                FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permission     ENABLE ROW LEVEL SECURITY; ALTER TABLE role_permission     FORCE ROW LEVEL SECURITY;
ALTER TABLE membership          ENABLE ROW LEVEL SECURITY; ALTER TABLE membership          FORCE ROW LEVEL SECURITY;
ALTER TABLE device_session      ENABLE ROW LEVEL SECURITY; ALTER TABLE device_session      FORCE ROW LEVEL SECURITY;
ALTER TABLE support_access_grant ENABLE ROW LEVEL SECURITY; ALTER TABLE support_access_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key     ENABLE ROW LEVEL SECURITY; ALTER TABLE idempotency_key     FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log           ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_log           FORCE ROW LEVEL SECURITY;
ALTER TABLE app_user            ENABLE ROW LEVEL SECURITY;   -- not FORCE: see note above

CREATE POLICY org_isolation ON organisation
  USING (id = app_org_id()) WITH CHECK (id = app_org_id());
CREATE POLICY tenant_isolation ON location
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
-- System roles (organisation_id IS NULL) are readable by everyone but writable by no one via the app.
CREATE POLICY role_read ON role FOR SELECT
  USING (organisation_id IS NULL OR organisation_id = app_org_id());
CREATE POLICY role_write ON role FOR ALL
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY role_permission_read ON role_permission FOR SELECT
  USING (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id
                 AND (r.organisation_id IS NULL OR r.organisation_id = app_org_id())));
CREATE POLICY role_permission_write ON role_permission FOR ALL
  USING (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id AND r.organisation_id = app_org_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id AND r.organisation_id = app_org_id()));
-- A user may always read their own memberships (needed to validate X-Org-Id before an org is selected).
CREATE POLICY membership_select ON membership FOR SELECT
  USING (organisation_id = app_org_id() OR user_id = app_user_id());
CREATE POLICY membership_write ON membership FOR ALL
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY own_devices ON device_session
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY tenant_isolation ON support_access_grant
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON idempotency_key
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON audit_log
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
-- Users: self, or people with a membership in the current organisation.
CREATE POLICY user_visibility ON app_user FOR SELECT
  USING (id = app_user_id()
         OR id IN (SELECT m.user_id FROM membership m WHERE m.organisation_id = app_org_id()));
CREATE POLICY user_self_update ON app_user FOR UPDATE
  USING (id = app_user_id()) WITH CHECK (id = app_user_id());

-- ---------------------------------------------------------------------------
-- Login support: narrow SECURITY DEFINER lookup so the API can resolve the identity
-- behind a verified token before any context exists. Returns no password/PII beyond the row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth_resolve_user(p_subject text)
RETURNS TABLE (id uuid, email text, display_name text, status user_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.display_name, u.status FROM app_user u WHERE u.idp_subject = p_subject
$$;
REVOKE ALL ON FUNCTION auth_resolve_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_user(text) TO hub_app;

-- ---------------------------------------------------------------------------
-- Grants for the application role (least privilege; no DELETE on business tables)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO hub_app;
GRANT EXECUTE ON FUNCTION app_org_id(), app_user_id(), uuid_generate_v7(),
  audit_verify_chain(uuid), audit_canonical(audit_log) TO hub_app;
GRANT SELECT, INSERT, UPDATE ON organisation, location, role, membership TO hub_app;
GRANT SELECT, UPDATE ON app_user TO hub_app;                 -- user creation is via invite flow (M1)
GRANT SELECT ON permission TO hub_app;
GRANT SELECT, INSERT, DELETE ON role_permission TO hub_app;
GRANT SELECT, INSERT, UPDATE ON device_session TO hub_app;
GRANT SELECT, INSERT ON support_access_grant TO hub_app;      -- immutable
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_key TO hub_app;
GRANT SELECT, INSERT ON audit_log TO hub_app;                 -- append-only
