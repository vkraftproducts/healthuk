-- INT-01: integration framework. Only MOCK connections exist for now: API access and licences for
-- FleetX, payroll, training and telematics are unconfirmed (spec section 10), so every adapter runs
-- against deterministic synthetic feeds. Inbound data never becomes "verified" by itself.

-- Telematics odometer readings are stored with their own source (flagged like any other reading).
ALTER TYPE odometer_source ADD VALUE IF NOT EXISTS 'TELEMATICS';

CREATE TABLE integration_connection (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  adapter         text NOT NULL CHECK (adapter IN ('FLEETX', 'TELEMATICS', 'TRAINING', 'PAYROLL', 'CALENDAR')),
  mode            text NOT NULL DEFAULT 'MOCK' CHECK (mode = 'MOCK'),  -- LIVE is added when credentials exist
  enabled         boolean NOT NULL DEFAULT true,
  last_run_at     timestamptz,
  last_status     text CHECK (last_status IN ('SUCCEEDED', 'PARTIAL', 'FAILED')),
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, adapter)
);
CREATE UNIQUE INDEX integration_connection_org_id_key ON integration_connection (id, organisation_id);
CREATE TRIGGER integration_connection_version BEFORE UPDATE ON integration_connection FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE integration_run (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  connection_id    uuid NOT NULL,
  adapter          text NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  status           text NOT NULL CHECK (status IN ('SUCCEEDED', 'PARTIAL', 'FAILED')),
  scenario         text NOT NULL DEFAULT 'normal',
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz NOT NULL DEFAULT now(),
  records_seen     int NOT NULL DEFAULT 0,
  records_applied  int NOT NULL DEFAULT 0,
  records_flagged  int NOT NULL DEFAULT 0,
  records_skipped  int NOT NULL DEFAULT 0,
  notes            text[] NOT NULL DEFAULT '{}',
  error            text,
  requested_by     uuid NOT NULL,
  FOREIGN KEY (connection_id, organisation_id) REFERENCES integration_connection (id, organisation_id)
);
CREATE INDEX integration_run_idx ON integration_run (organisation_id, started_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integration_connection', 'integration_run']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
    EXECUTE format('CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change()', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON integration_connection TO hub_app;
GRANT SELECT, INSERT ON integration_run TO hub_app;  -- the run log is append-only
