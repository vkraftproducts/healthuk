-- Workflow A5 (6 Nov 2026). Forward-only.
-- A requirement (organisation copy) is retired with a reason, never deleted. Append-only: one row
-- per template. Library templates (organisation_id NULL) are retired by the platform, not here.
CREATE TABLE requirement_template_retirement (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  template_id     uuid NOT NULL UNIQUE REFERENCES requirement_template(id),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  retired_by      uuid NOT NULL,
  retired_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requirement_template_retirement_idx
  ON requirement_template_retirement (organisation_id, template_id);
CREATE TRIGGER requirement_template_retirement_immutable
  BEFORE UPDATE OR DELETE ON requirement_template_retirement
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE requirement_template_retirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirement_template_retirement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON requirement_template_retirement
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON requirement_template_retirement TO hub_app;
