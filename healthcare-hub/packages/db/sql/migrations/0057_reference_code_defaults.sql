-- v36 human reference codes for new rows (VDI-6001, DEF-085, SUP-303): 0055 filled in the rows that
-- already existed; from here a check, defect or supervision booking saved without a code gets the
-- next one for its organisation. Rows that arrive with a code (sample data) keep it.
-- Backfill existing rows: FORCE RLS would hide every organisation's rows from the migration role,
-- so it is lifted for this migration only (the app role never bypasses RLS), then restored.
ALTER TABLE vdi NO FORCE ROW LEVEL SECURITY;
ALTER TABLE defect NO FORCE ROW LEVEL SECURITY;
ALTER TABLE supervision_booking NO FORCE ROW LEVEL SECURITY;
ALTER TABLE org_counter NO FORCE ROW LEVEL SECURITY;

-- Start each organisation's counter after the highest code already used.
INSERT INTO org_counter (organisation_id, prefix, value)
SELECT organisation_id, 'VDI', greatest(5999, max(substring(code from '[0-9]+')::int))
  FROM vdi WHERE code ~ '^VDI-[0-9]+$' GROUP BY organisation_id
ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, EXCLUDED.value);
INSERT INTO org_counter (organisation_id, prefix, value)
SELECT organisation_id, 'DEF', max(substring(code from '[0-9]+')::int)
  FROM defect WHERE code ~ '^DEF-[0-9]+$' GROUP BY organisation_id
ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, EXCLUDED.value);
INSERT INTO org_counter (organisation_id, prefix, value)
SELECT organisation_id, 'SUP', greatest(199, max(substring(code from '[0-9]+')::int))
  FROM supervision_booking WHERE code ~ '^SUP-[0-9]+$' GROUP BY organisation_id
ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, EXCLUDED.value);

-- Trigger arguments: prefix, first number for a new organisation, zero-padding width.
CREATE FUNCTION assign_reference_code() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p   text := TG_ARGV[0];
  s   int  := TG_ARGV[1]::int;
  w   int  := TG_ARGV[2]::int;
  v   int;
  c   text;
  hit boolean;
BEGIN
  IF NEW.code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- A re-run of sample data inserts rows that already exist (ON CONFLICT DO NOTHING): spend no number.
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', TG_TABLE_NAME) INTO hit USING NEW.id;
  IF hit THEN
    RETURN NEW;
  END IF;
  LOOP
    INSERT INTO org_counter (organisation_id, prefix, value) VALUES (NEW.organisation_id, p, s)
    ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = org_counter.value + 1
    RETURNING value INTO v;
    c := p || '-' || CASE WHEN length(v::text) < w THEN lpad(v::text, w, '0') ELSE v::text END;
    -- Skip a number a sample row already uses.
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE organisation_id = $1 AND code = $2)', TG_TABLE_NAME)
      INTO hit USING NEW.organisation_id, c;
    EXIT WHEN NOT hit;
  END LOOP;
  NEW.code := c;
  RETURN NEW;
END $$;

CREATE TRIGGER vdi_code BEFORE INSERT ON vdi
  FOR EACH ROW EXECUTE FUNCTION assign_reference_code('VDI', '6000', '1');
CREATE TRIGGER defect_code BEFORE INSERT ON defect
  FOR EACH ROW EXECUTE FUNCTION assign_reference_code('DEF', '1', '3');
CREATE TRIGGER supervision_booking_code BEFORE INSERT ON supervision_booking
  FOR EACH ROW EXECUTE FUNCTION assign_reference_code('SUP', '200', '1');

ALTER TABLE vdi FORCE ROW LEVEL SECURITY;
ALTER TABLE defect FORCE ROW LEVEL SECURITY;
ALTER TABLE supervision_booking FORCE ROW LEVEL SECURITY;
ALTER TABLE org_counter FORCE ROW LEVEL SECURITY;
