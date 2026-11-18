-- 17 Nov 2026: a business continuity test that is not a clean pass raises a tracked action.
-- Adds CONTINUITY to the action sources (keeping whatever list is current, as 0033 did) and links
-- each test to the action it raised.

DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'action_source_type_check' AND conrelid = 'action'::regclass;
  IF def IS NULL THEN
    ALTER TABLE action ADD CONSTRAINT action_source_type_check CHECK (source_type IN
      ('FINDING', 'EVENT', 'RISK', 'CORRESPONDENCE', 'FEEDBACK', 'MEETING', 'PREMISES', 'CONTINUITY'));
  ELSIF position('''CONTINUITY''' IN def) = 0 THEN
    ALTER TABLE action DROP CONSTRAINT action_source_type_check;
    EXECUTE 'ALTER TABLE action ADD CONSTRAINT action_source_type_check '
      || replace(def, 'ARRAY[', 'ARRAY[''CONTINUITY''::text, ');
  END IF;
END $$;

-- Set once, when the test is recorded (the test row is immutable afterwards).
ALTER TABLE continuity_test ADD COLUMN action_id uuid REFERENCES action(id);
ALTER TABLE continuity_test ADD CONSTRAINT continuity_test_action_check
  CHECK (result NOT IN ('ACTIONS_RAISED', 'FAILED') OR action_id IS NOT NULL) NOT VALID;
