-- Workflow pass I1-I3 (6 Nov 2026): registered locations with their manager and start date,
-- insurance and business continuity dates, rating display evidence, and minutes approved at the
-- next meeting. Forward-only.

ALTER TABLE registration_record
  ADD COLUMN insurance_expires_on date,
  ADD COLUMN bcp_reviewed_on      date,
  ADD COLUMN bcp_next_review_on   date;

-- Each registered location's details as at an effective date. Append-only: the current entry is
-- the latest per location; earlier ones are the history (with who, when and why).
CREATE TABLE registration_location (
  id                         uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id            uuid NOT NULL REFERENCES organisation(id),
  location_id                uuid NOT NULL,
  cqc_location_id            text CHECK (cqc_location_id IS NULL OR length(cqc_location_id) <= 40),
  registered_manager_user_id uuid,
  manager_start_on           date,
  activities                 text[] NOT NULL DEFAULT '{}',
  conditions                 text CHECK (conditions IS NULL OR length(conditions) <= 4000),
  effective_from             date NOT NULL,
  reason                     text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  recorded_by                uuid NOT NULL,
  recorded_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (registered_manager_user_id IS NULL OR manager_start_on IS NOT NULL),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE INDEX registration_location_idx
  ON registration_location (organisation_id, location_id, effective_from DESC, recorded_at DESC);
CREATE TRIGGER registration_location_immutable BEFORE UPDATE OR DELETE ON registration_location
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Photo of the poster and the web page as evidence of display (I2).
ALTER TABLE cqc_rating_record
  ADD COLUMN premises_evidence_item_id uuid,
  ADD COLUMN website_evidence_item_id  uuid;

-- Minutes are approved at a later meeting (I3).
ALTER TABLE governance_meeting ADD COLUMN approved_at_meeting_id uuid REFERENCES governance_meeting(id);

ALTER TABLE registration_location ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_location FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON registration_location
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON registration_location TO hub_app;
