-- Tasks 18 and 25: staff roles for the dental and care-home packs, and employment details on the
-- staff record (work email, start date, contract type). New enum values are not used in this
-- migration, so adding them inside the migration transaction is safe.

ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'DENTIST';
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'DENTAL_NURSE';
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'RECEPTIONIST';
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'SENIOR_CARER';
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'ACTIVITIES_COORDINATOR';

ALTER TABLE staff
  ADD COLUMN work_email    text CHECK (work_email IS NULL OR length(work_email) BETWEEN 3 AND 200),
  ADD COLUMN start_date    date,
  ADD COLUMN contract_type text CHECK (
    contract_type IS NULL
    OR contract_type IN ('PERMANENT', 'FIXED_TERM', 'BANK', 'AGENCY', 'VOLUNTEER')
  );
