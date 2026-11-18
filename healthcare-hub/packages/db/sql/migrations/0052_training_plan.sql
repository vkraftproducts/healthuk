-- v36 Staff › Training › Matrix & groups › Planned sessions (18 Nov 2026).
CREATE TABLE training_plan (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id    uuid NOT NULL,
  code               text NOT NULL,
  course_code        text NOT NULL CHECK (length(course_code) BETWEEN 2 AND 40),
  planned_on         date NOT NULL,
  places             int NOT NULL CHECK (places BETWEEN 1 AND 200),
  invited_staff_ids  uuid[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'PLANNED'
                       CHECK (status IN ('PLANNED', 'HELD', 'CANCELLED')),
  created_by         uuid NOT NULL REFERENCES app_user(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES app_user(id),
  version            int NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)),
  CHECK (cardinality(invited_staff_ids) <= places)
);
CREATE INDEX training_plan_org_idx ON training_plan (organisation_id, planned_on DESC);
CREATE TRIGGER training_plan_version BEFORE UPDATE ON training_plan
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE training_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON training_plan
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON training_plan TO hub_app;
