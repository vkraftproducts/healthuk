-- Workflows A1-A4 and B1 (6 Nov 2026). Forward-only.
-- New enum values are not used in this migration, so adding them inside the transaction is safe.

-- A2: provider details shown in the top bar, reports and evidence pack.
ALTER TABLE organisation
  ADD COLUMN legal_name      text CHECK (legal_name IS NULL OR length(legal_name) BETWEEN 2 AND 200),
  ADD COLUMN trading_name    text CHECK (trading_name IS NULL OR length(trading_name) BETWEEN 2 AND 200),
  ADD COLUMN cqc_provider_id text CHECK (cqc_provider_id IS NULL OR cqc_provider_id ~ '^[0-9A-Za-z-]{3,20}$'),
  ADD COLUMN address         jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN main_contact    jsonb NOT NULL DEFAULT '{}';

-- A2: location kind (ambulance base, office only, practice, home) and CQC location ID.
ALTER TABLE location
  ADD COLUMN kind            text CHECK (kind IS NULL OR kind IN ('AMBULANCE_BASE', 'OFFICE_ONLY', 'PRACTICE', 'HOME')),
  ADD COLUMN cqc_location_id text CHECK (cqc_location_id IS NULL OR cqc_location_id ~ '^[0-9A-Za-z-]{3,20}$'),
  ADD COLUMN archive_reason  text CHECK (archive_reason IS NULL OR length(archive_reason) BETWEEN 3 AND 500);

-- A2: which locations run each service.
CREATE TABLE service_location (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  service_id      uuid NOT NULL REFERENCES service_type(id),
  location_id     uuid NOT NULL REFERENCES location(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (organisation_id, service_id, location_id)
);
CREATE INDEX service_location_idx ON service_location (organisation_id, location_id);
ALTER TABLE service_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_location FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_location
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, DELETE ON service_location TO hub_app;

-- A4: ending support access early. Grants are immutable, so the end is a separate append-only row.
CREATE TABLE support_access_end (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  grant_id        uuid NOT NULL UNIQUE REFERENCES support_access_grant(id),
  ended_by        uuid NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  ended_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_access_end_idx ON support_access_end (organisation_id, grant_id);
CREATE TRIGGER support_access_end_immutable
  BEFORE UPDATE OR DELETE ON support_access_end FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE support_access_end ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_end FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_access_end
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
-- The support user's own requests run before any organisation context exists.
CREATE POLICY support_user_read ON support_access_end FOR SELECT
  USING (grant_id IN (SELECT g.id FROM support_access_grant g WHERE g.support_user_id = app_user_id()));
GRANT SELECT, INSERT ON support_access_end TO hub_app;

-- A1: "Last signed in" for the users list. hub_app cannot update app_user directly.
CREATE FUNCTION record_sign_in() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE app_user SET last_login_at = now() WHERE id = app_user_id()
$$;
REVOKE ALL ON FUNCTION record_sign_in() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_sign_in() TO hub_app;

-- B1: identity check as its own staff record (document type, last 4, expiry, photo match).
ALTER TYPE staff_record_kind ADD VALUE IF NOT EXISTS 'IDENTITY';

-- L2: why an alert was snoozed and by whom. Snoozing never changes status or due dates.
ALTER TABLE alert
  ADD COLUMN snooze_reason text CHECK (snooze_reason IS NULL OR length(snooze_reason) BETWEEN 3 AND 500),
  ADD COLUMN snoozed_by    uuid;
