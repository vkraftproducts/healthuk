-- Workflow pass E (planning and dispatch), 6 Nov 2026. Forward-only.
-- E1: contract type and NHS eligibility on the booking; return journeys; blue-light jobs.

ALTER TABLE booking
  ADD COLUMN contract_type          text CHECK (contract_type IS NULL OR contract_type IN ('NHS', 'PRIVATE', 'INSURER')),
  ADD COLUMN nhs_eligibility_met    boolean,
  ADD COLUMN nhs_eligibility_criteria text CHECK (nhs_eligibility_criteria IS NULL OR length(nhs_eligibility_criteria) BETWEEN 3 AND 500),
  ADD COLUMN nhs_eligibility_assessed_by text CHECK (nhs_eligibility_assessed_by IS NULL OR length(nhs_eligibility_assessed_by) BETWEEN 2 AND 120),
  -- NHS-funded work records the eligibility decision and who assessed it.
  ADD CONSTRAINT booking_nhs_eligibility_check CHECK (
    contract_type IS DISTINCT FROM 'NHS'
    OR (nhs_eligibility_met IS NOT NULL AND nhs_eligibility_criteria IS NOT NULL
        AND nhs_eligibility_assessed_by IS NOT NULL));

ALTER TABLE job
  ADD COLUMN return_of_job_id uuid REFERENCES job(id),
  ADD COLUMN blue_lights      boolean NOT NULL DEFAULT false;
CREATE INDEX job_return_of_idx ON job (return_of_job_id) WHERE return_of_job_id IS NOT NULL;
