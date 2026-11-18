-- UK-36: HR verifies training records against the register (four-eyes, append-only).

CREATE TABLE staff_record_verification (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  record_id       uuid NOT NULL UNIQUE REFERENCES staff_record(id),
  verified_by     uuid NOT NULL,
  register_ref    text CHECK (register_ref IS NULL OR length(register_ref) BETWEEN 1 AND 60),
  reason          text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500),
  verified_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX staff_record_verification_org_idx ON staff_record_verification (organisation_id, verified_at);
CREATE TRIGGER staff_record_verification_immutable
  BEFORE UPDATE OR DELETE ON staff_record_verification FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE staff_record_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_record_verification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_record_verification
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON staff_record_verification TO hub_app;