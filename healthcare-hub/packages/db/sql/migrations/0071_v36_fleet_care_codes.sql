-- v36 Fleet care (step 2, 18 Nov 2026).
--  * Deep cleans carry v36's reference (DC-301). Sample rows have it at the start of their note;
--    new ones get the next number for the organisation (same trigger as VDI-/DEF- codes).
--  * An infectious-transfer block records the journey it came from (v36 "Journey (optional)").
ALTER TABLE cleaning_record NO FORCE ROW LEVEL SECURITY;
ALTER TABLE org_counter NO FORCE ROW LEVEL SECURITY;
ALTER TABLE cleaning_record ADD COLUMN IF NOT EXISTS code text;
CREATE UNIQUE INDEX IF NOT EXISTS cleaning_record_org_code_uidx
  ON cleaning_record (organisation_id, code) WHERE code IS NOT NULL;

-- Only the new code column changes on existing (immutable) records.
ALTER TABLE cleaning_record DISABLE TRIGGER cleaning_record_immutable;
UPDATE cleaning_record SET code = substring(notes from '^DC-[0-9]+')
 WHERE code IS NULL AND type = 'ENHANCED' AND notes ~ '^DC-[0-9]+';
ALTER TABLE cleaning_record ENABLE TRIGGER cleaning_record_immutable;

INSERT INTO org_counter (organisation_id, prefix, value)
SELECT organisation_id, 'DC', greatest(300, max(substring(code from '[0-9]+')::int))
  FROM cleaning_record WHERE code ~ '^DC-[0-9]+$' GROUP BY organisation_id
ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, EXCLUDED.value);

-- Deep cleans (ENHANCED) get DC-<n>; pre-shift and between-patient cleans keep no code.
CREATE FUNCTION assign_deep_clean_code() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v   int;
  c   text;
  hit boolean;
BEGIN
  IF NEW.code IS NOT NULL OR NEW.type <> 'ENHANCED' THEN
    RETURN NEW;
  END IF;
  LOOP
    INSERT INTO org_counter (organisation_id, prefix, value) VALUES (NEW.organisation_id, 'DC', 301)
    ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = org_counter.value + 1
    RETURNING value INTO v;
    c := 'DC-' || v::text;
    SELECT EXISTS (SELECT 1 FROM cleaning_record WHERE organisation_id = NEW.organisation_id AND code = c)
      INTO hit;
    EXIT WHEN NOT hit;
  END LOOP;
  NEW.code := c;
  RETURN NEW;
END $$;
CREATE TRIGGER cleaning_record_code BEFORE INSERT ON cleaning_record
  FOR EACH ROW EXECUTE FUNCTION assign_deep_clean_code();

ALTER TABLE cleaning_record FORCE ROW LEVEL SECURITY;
ALTER TABLE org_counter FORCE ROW LEVEL SECURITY;

ALTER TABLE vehicle_status_change
  ADD COLUMN IF NOT EXISTS journey_ref text CHECK (journey_ref IS NULL OR length(journey_ref) <= 40);
