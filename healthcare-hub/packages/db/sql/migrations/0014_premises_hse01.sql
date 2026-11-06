-- HSE-01: a premises item also needs the contractor, an assessment reference/date and a named action
-- owner (separate from the responsible person). All optional so existing rows stay valid.
ALTER TABLE premises_item
  ADD COLUMN contractor_name       text CHECK (contractor_name IS NULL OR length(contractor_name) BETWEEN 2 AND 200),
  ADD COLUMN assessment_ref        text CHECK (assessment_ref IS NULL OR length(assessment_ref) BETWEEN 2 AND 200),
  ADD COLUMN assessed_on           date,
  ADD COLUMN action_owner_user_id  uuid;
