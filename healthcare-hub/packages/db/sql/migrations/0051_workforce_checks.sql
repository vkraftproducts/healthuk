-- v36 Staff › Training & reviews › Workforce checks (18 Nov 2026).
-- Bank/agency workers (four-eyes confirmation), DVLA licence checks (append-only) and HCPC
-- registrations for paramedics.
CREATE TABLE agency_worker (
  id                          uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id             uuid NOT NULL,
  code                        text NOT NULL,
  name                        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  agency                      text NOT NULL CHECK (length(agency) BETWEEN 2 AND 160),
  role                        staff_role NOT NULL,
  confirmation_items          text NOT NULL CHECK (length(confirmation_items) BETWEEN 3 AND 1000),
  confirmation_received_on    date NOT NULL,
  confirmation_recorded_by    uuid NOT NULL REFERENCES app_user(id),
  confirmation_verified_by    uuid REFERENCES app_user(id),
  confirmation_verified_at    timestamptz,
  confirmation_expires_on     date NOT NULL,
  local_induction_done        boolean NOT NULL DEFAULT false,
  id_checked_on_arrival       boolean NOT NULL DEFAULT false,
  version                     int NOT NULL DEFAULT 1,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK ((confirmation_verified_by IS NULL) = (confirmation_verified_at IS NULL)),
  CHECK (confirmation_verified_by IS NULL
         OR confirmation_verified_by <> confirmation_recorded_by),
  CHECK (confirmation_expires_on >= confirmation_received_on)
);
CREATE INDEX agency_worker_org_idx ON agency_worker (organisation_id, code);
CREATE TRIGGER agency_worker_version BEFORE UPDATE ON agency_worker
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE dvla_check (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  staff_id         uuid NOT NULL,
  check_code       text NOT NULL CHECK (length(check_code) BETWEEN 4 AND 40),
  categories       text NOT NULL CHECK (length(categories) BETWEEN 1 AND 80),
  points           int NOT NULL CHECK (points BETWEEN 0 AND 99),
  checked_on       date NOT NULL,
  next_check_on    date NOT NULL,
  recorded_by      uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (next_check_on >= checked_on)
);
CREATE INDEX dvla_check_staff_idx ON dvla_check (organisation_id, staff_id, checked_on DESC);
CREATE TRIGGER dvla_check_no_mutation BEFORE UPDATE OR DELETE ON dvla_check
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE hcpc_registration (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  staff_id         uuid NOT NULL,
  registration_no  text NOT NULL CHECK (length(registration_no) BETWEEN 4 AND 40),
  checked_on       date NOT NULL,
  expires_on       date NOT NULL,
  recorded_by      uuid NOT NULL REFERENCES app_user(id),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, staff_id),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (expires_on >= checked_on)
);
CREATE TRIGGER hcpc_registration_version BEFORE UPDATE ON hcpc_registration
  FOR EACH ROW EXECUTE FUNCTION bump_version();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agency_worker', 'dvla_check', 'hcpc_registration'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON agency_worker, hcpc_registration TO hub_app;
GRANT SELECT, INSERT ON dvla_check TO hub_app;
