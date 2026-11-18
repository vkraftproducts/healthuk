-- v36 Vehicles › Defects › detail: the repair plan is kept apart from the sign-off, with when the
-- repair started and by whom, and the garage job sheet reference (JS-2231) given at sign-off.
ALTER TABLE defect
  ADD COLUMN IF NOT EXISTS repair_plan text CHECK (repair_plan IS NULL OR length(repair_plan) <= 2000),
  ADD COLUMN IF NOT EXISTS repair_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS repair_started_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS job_sheet_ref text CHECK (job_sheet_ref IS NULL OR length(job_sheet_ref) BETWEEN 1 AND 40);
