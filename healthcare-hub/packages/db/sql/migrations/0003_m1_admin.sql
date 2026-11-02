-- 0003 (M1): optimistic concurrency, services/registered activities, invites, break-glass reads,
-- custom-role restrictions, organisation settings.

-- ---------------------------------------------------------------------------
-- Optimistic concurrency (API_SPEC: PATCH requires If-Match -> 409 STALE_VERSION)
-- ---------------------------------------------------------------------------
ALTER TABLE organisation ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE location     ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE role         ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE app_user     ADD COLUMN version int NOT NULL DEFAULT 1;
ALTER TABLE membership   ADD COLUMN version int NOT NULL DEFAULT 1;

CREATE FUNCTION bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

DROP TRIGGER organisation_updated ON organisation;
DROP TRIGGER location_updated ON location;
DROP TRIGGER app_user_updated ON app_user;
DROP TRIGGER role_updated ON role;
DROP TRIGGER membership_updated ON membership;
CREATE TRIGGER organisation_version BEFORE UPDATE ON organisation FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER location_version     BEFORE UPDATE ON location     FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER app_user_version     BEFORE UPDATE ON app_user     FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER role_version         BEFORE UPDATE ON role         FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER membership_version   BEFORE UPDATE ON membership   FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- Organisation settings (thresholds, notification rules). Defaults are product defaults,
-- labelled "not CQC rules" in the UI (RULES_ENGINE §2).
-- ---------------------------------------------------------------------------
ALTER TABLE organisation ADD COLUMN settings jsonb NOT NULL DEFAULT
  '{"warningDays":[90,60,30,14,7],"dueSoonDays":30,"emailReminders":true,"deputyEscalation":true}'::jsonb;

-- ---------------------------------------------------------------------------
-- Cross-tenant references must be impossible: child rows reference (id, organisation_id).
-- Pattern for every later milestone: UNIQUE (id, organisation_id) on the parent and a composite FK.
-- ---------------------------------------------------------------------------
ALTER TABLE location ADD CONSTRAINT location_id_org_key UNIQUE (id, organisation_id);
ALTER TABLE membership DROP CONSTRAINT membership_location_id_fkey;
ALTER TABLE membership ADD CONSTRAINT membership_location_org_fkey
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id);
CREATE FUNCTION membership_role_same_org() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM role r WHERE r.id = NEW.role_id
                 AND (r.organisation_id IS NULL OR r.organisation_id = NEW.organisation_id)) THEN
    RAISE EXCEPTION 'role does not belong to this organisation' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_role_same_org_trg BEFORE INSERT OR UPDATE OF role_id ON membership
  FOR EACH ROW EXECUTE FUNCTION membership_role_same_org();

-- ---------------------------------------------------------------------------
-- Services and registered activities
-- ---------------------------------------------------------------------------
CREATE TABLE service_type (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL CHECK (code ~ '^[A-Z0-9_\-]{2,40}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  archived_at      timestamptz,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  UNIQUE (organisation_id, code)
);
CREATE TABLE registered_activity (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  location_id      uuid NOT NULL,
  code             text NOT NULL CHECK (code ~ '^[A-Z0-9_\-]{2,40}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  archived_at      timestamptz,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  UNIQUE (organisation_id, location_id, code),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE INDEX registered_activity_loc_idx ON registered_activity (organisation_id, location_id);
CREATE TRIGGER service_type_version BEFORE UPDATE ON service_type FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER registered_activity_version BEFORE UPDATE ON registered_activity FOR EACH ROW EXECUTE FUNCTION bump_version();
ALTER TABLE service_type ENABLE ROW LEVEL SECURITY;        ALTER TABLE service_type FORCE ROW LEVEL SECURITY;
ALTER TABLE registered_activity ENABLE ROW LEVEL SECURITY; ALTER TABLE registered_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_type
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON registered_activity
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON service_type, registered_activity TO hub_app;

-- ---------------------------------------------------------------------------
-- Identity: users can be invited before they have an IdP subject.
-- ---------------------------------------------------------------------------
ALTER TABLE app_user ALTER COLUMN idp_subject DROP NOT NULL;
-- Platform support staff (supplier) have no membership anywhere; they act only through
-- time-limited, org-approved support_access_grant rows.
ALTER TABLE app_user ADD COLUMN is_platform_support boolean NOT NULL DEFAULT false;

-- Lets an organisation approver name a support user by email without being able to see the user
-- table. Returns an id only for ACTIVE platform-support accounts.
CREATE FUNCTION find_support_user(p_email text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM app_user WHERE email = lower(trim(p_email)) AND is_platform_support AND status = 'ACTIVE'
$$;
REVOKE ALL ON FUNCTION find_support_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_support_user(text) TO hub_app;

-- hub_app cannot INSERT into app_user directly. Invites go through this function, which reads the
-- organisation/user from the request context (never from parameters) and returns the same result
-- whether or not the email already belongs to another organisation (no cross-tenant enumeration).
CREATE FUNCTION invite_user(p_email text, p_display_name text, p_role_id uuid, p_location_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := app_org_id();
  v_actor uuid := app_user_id();
  v_email text := lower(trim(p_email));
  v_user uuid;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'organisation context required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM role r WHERE r.id = p_role_id AND (r.organisation_id IS NULL OR r.organisation_id = v_org)) THEN
    RAISE EXCEPTION 'role not available' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM location l WHERE l.id = p_location_id AND l.organisation_id = v_org) THEN
    RAISE EXCEPTION 'location not available' USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT id INTO v_user FROM app_user WHERE email = v_email;
  IF v_user IS NULL THEN
    INSERT INTO app_user (email, display_name, status, created_by)
    VALUES (v_email, p_display_name, 'INVITED', v_actor) RETURNING id INTO v_user;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM membership m
    WHERE m.organisation_id = v_org AND m.user_id = v_user AND m.role_id = p_role_id
      AND m.location_id IS NOT DISTINCT FROM p_location_id
      AND (m.valid_to IS NULL OR m.valid_to > now())
  ) THEN
    INSERT INTO membership (organisation_id, user_id, location_id, role_id, created_by)
    VALUES (v_org, v_user, p_location_id, p_role_id, v_actor);
  END IF;
  RETURN v_user;
END $$;
REVOKE ALL ON FUNCTION invite_user(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_user(text, text, uuid, uuid) TO hub_app;

-- First sign-in of an invited user: link the verified IdP subject (email must be verified by the IdP).
CREATE FUNCTION auth_link_invited(p_subject text, p_email text)
RETURNS TABLE (id uuid, email text, display_name text, status user_status)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE app_user u
     SET idp_subject = p_subject, status = 'ACTIVE', last_login_at = now()
   WHERE u.email = lower(p_email) AND u.status = 'INVITED' AND u.idp_subject IS NULL
  RETURNING u.id, u.email, u.display_name, u.status
$$;
REVOKE ALL ON FUNCTION auth_link_invited(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_link_invited(text, text) TO hub_app;

-- Policies: org admins may see users they invited (before any membership is visible) and
-- may revoke devices of members of their organisation.
CREATE POLICY user_inviter_read ON app_user FOR SELECT
  USING (created_by = app_user_id() AND status = 'INVITED');
CREATE POLICY org_revoke_devices ON device_session FOR UPDATE
  USING (user_id IN (SELECT m.user_id FROM membership m WHERE m.organisation_id = app_org_id()))
  WITH CHECK (user_id IN (SELECT m.user_id FROM membership m WHERE m.organisation_id = app_org_id()));
CREATE POLICY org_read_devices ON device_session FOR SELECT
  USING (user_id IN (SELECT m.user_id FROM membership m WHERE m.organisation_id = app_org_id()));
-- A support user can read the grants issued to them (before an organisation context exists).
CREATE POLICY support_user_read ON support_access_grant FOR SELECT
  USING (support_user_id = app_user_id());

-- ---------------------------------------------------------------------------
-- Custom roles: restricted permissions can never be granted to dispatch/crew-derived roles
-- (SECURITY_COMPLIANCE §2). Enforced in the database as well as the API.
-- ---------------------------------------------------------------------------
ALTER TABLE role ADD COLUMN derived_from text;
ALTER TABLE role ADD COLUMN is_system boolean NOT NULL DEFAULT false;
UPDATE role SET is_system = true WHERE organisation_id IS NULL;

CREATE FUNCTION restricted_for_dispatch_and_crew() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'staff.sensitive.view','staff.approve_role','staff.profile.manage','staff.lifecycle.transition',
    'events.safeguarding.view','admin.users.manage','admin.roles.manage','admin.export.full',
    'allocation.exception.approve','admin.audit.view','admin.audit.verify'
  ]
$$;
GRANT EXECUTE ON FUNCTION restricted_for_dispatch_and_crew() TO hub_app;

CREATE FUNCTION enforce_role_permission_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r role;
BEGIN
  SELECT * INTO r FROM role WHERE id = NEW.role_id;
  IF NOT r.is_system AND (r.derived_from IN ('DISPATCHER','CREW') OR r.key IN ('DISPATCHER','CREW'))
     AND NEW.permission_key = ANY (restricted_for_dispatch_and_crew()) THEN
    RAISE EXCEPTION 'permission % cannot be granted to a role derived from %', NEW.permission_key, coalesce(r.derived_from, r.key)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_permission_rules BEFORE INSERT ON role_permission
  FOR EACH ROW EXECUTE FUNCTION enforce_role_permission_rules();

-- System roles are never writable through the application role.
DROP POLICY role_write ON role;
CREATE POLICY role_write ON role FOR ALL
  USING (organisation_id = app_org_id() AND NOT is_system)
  WITH CHECK (organisation_id = app_org_id() AND NOT is_system);
DROP POLICY role_permission_write ON role_permission;
CREATE POLICY role_permission_write ON role_permission FOR ALL
  USING (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id AND r.organisation_id = app_org_id() AND NOT r.is_system))
  WITH CHECK (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id AND r.organisation_id = app_org_id() AND NOT r.is_system));

GRANT SELECT, INSERT, UPDATE ON role TO hub_app;
