-- v36 Fleet care › Deep cleans: office-recorded deep cleans are checked by a second person.
-- Backfill existing rows: FORCE RLS would hide every organisation's rows from the migration role,
-- so it is lifted for this migration only (the app role never bypasses RLS), then restored.
ALTER TABLE cleaning_record NO FORCE ROW LEVEL SECURITY;
ALTER TABLE cleaning_record DISABLE TRIGGER cleaning_record_immutable;
ALTER TABLE cleaning_record
  ADD COLUMN IF NOT EXISTS checked_by uuid REFERENCES app_user(id);
-- Demo seed deep cleans (Mark Cox cleaned, Dr. Helen Price checked).
UPDATE cleaning_record cr
   SET checked_by = u.id
  FROM app_user u
 WHERE cr.type = 'ENHANCED'
   AND cr.checked_by IS NULL
   AND u.display_name = 'Dr. Helen Price';
ALTER TABLE cleaning_record ENABLE TRIGGER cleaning_record_immutable;

ALTER TABLE cleaning_record FORCE ROW LEVEL SECURITY;
