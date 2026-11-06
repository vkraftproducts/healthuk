-- Workflow pass G1-G4 (6 Nov 2026): audit template sector packs, cadence, retirement and specialist
-- validation; audit schedule with service, reviewer and recurrence; reviewer accept or return;
-- policy reader groups by location or everyone. Forward-only.

-- G1 templates.
ALTER TABLE audit_template
  ADD COLUMN sector_pack      text CHECK (sector_pack IS NULL OR sector_pack IN ('ambulance', 'dental', 'care_home')),
  ADD COLUMN proposed_cadence text CHECK (proposed_cadence IS NULL OR length(proposed_cadence) <= 40),
  ADD COLUMN purpose          text CHECK (purpose IS NULL OR length(purpose) <= 1000),
  ADD COLUMN cloned_from      uuid,
  ADD COLUMN retired_at       timestamptz,
  ADD COLUMN retired_by       uuid,
  ADD COLUMN retired_reason   text CHECK (retired_reason IS NULL OR length(retired_reason) BETWEEN 3 AND 500);
ALTER TABLE audit_template ADD CONSTRAINT audit_template_retired_complete CHECK (
  retired_at IS NULL OR (retired_by IS NOT NULL AND retired_reason IS NOT NULL AND NOT active)
);
-- Dental and care home content must name the specialist who validated it before it is published.
ALTER TABLE audit_template_version
  ADD COLUMN frequency        text CHECK (frequency IS NULL OR length(frequency) <= 40),
  ADD COLUMN specialist_name  text CHECK (specialist_name IS NULL OR length(specialist_name) BETWEEN 2 AND 120),
  ADD COLUMN specialist_role  text CHECK (specialist_role IS NULL OR length(specialist_role) BETWEEN 2 AND 120);

-- Mark the seeded sector drafts.
UPDATE audit_template SET sector_pack = 'dental' WHERE code LIKE 'DEN-%' AND sector_pack IS NULL;
UPDATE audit_template SET sector_pack = 'care_home' WHERE code LIKE 'CH-%' AND sector_pack IS NULL;

-- G2 schedule and review.
ALTER TABLE audit_run
  ADD COLUMN service_id        uuid,
  ADD COLUMN reviewer_user_id  uuid,
  ADD COLUMN recurrence_months int CHECK (recurrence_months IS NULL OR recurrence_months BETWEEN 1 AND 24),
  ADD COLUMN review_state      text CHECK (review_state IS NULL OR review_state IN ('RETURNED', 'ACCEPTED')),
  ADD COLUMN submission_no     int NOT NULL DEFAULT 0,
  ADD COLUMN next_run_id       uuid;
ALTER TABLE audit_run ADD CONSTRAINT audit_run_reviewer_not_auditor CHECK (
  reviewer_user_id IS NULL OR reviewer_user_id <> auditor_user_id
);
ALTER TABLE audit_finding ADD COLUMN submission_no int NOT NULL DEFAULT 1;

-- Reviewer decisions. Append-only: an accepted audit is locked; a returned one is answered again
-- and resubmitted (earlier answers and findings stay as history).
CREATE TABLE audit_review (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  run_id          uuid NOT NULL,
  submission_no   int NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('ACCEPTED', 'RETURNED')),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  reviewed_by     uuid NOT NULL,
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, organisation_id) REFERENCES audit_run (id, organisation_id)
);
CREATE INDEX audit_review_idx ON audit_review (organisation_id, run_id, reviewed_at);
CREATE TRIGGER audit_review_immutable BEFORE UPDATE OR DELETE ON audit_review
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Answers may be added while the audit is open, or after a reviewer returned it.
CREATE OR REPLACE FUNCTION audit_response_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM audit_run WHERE id = NEW.run_id) NOT IN ('SCHEDULED', 'IN_PROGRESS')
     AND (SELECT review_state FROM audit_run WHERE id = NEW.run_id) IS DISTINCT FROM 'RETURNED' THEN
    RAISE EXCEPTION 'the audit has been submitted; responses are fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- G4 reader groups: roles, locations or everyone.
ALTER TABLE policy_document
  ADD COLUMN reader_location_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN reader_everyone     boolean NOT NULL DEFAULT false;

ALTER TABLE audit_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_review
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON audit_review TO hub_app;
