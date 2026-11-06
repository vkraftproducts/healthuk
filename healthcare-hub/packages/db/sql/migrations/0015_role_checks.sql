-- B1: checks for a role start before the role is approved. Starting them creates the role's
-- requirements for the person (each grey, awaiting evidence) and is recorded here, append-only.
-- Approval for the role is refused until every one of those requirements is verified.
CREATE TABLE staff_role_check (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  staff_id        uuid NOT NULL,
  role            staff_role NOT NULL,
  started_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (staff_id, role),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id)
);
CREATE TRIGGER staff_role_check_immutable BEFORE UPDATE OR DELETE ON staff_role_check
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE staff_role_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_role_check FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_role_check
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON staff_role_check
  FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change();
GRANT SELECT, INSERT ON staff_role_check TO hub_app;  -- immutable
