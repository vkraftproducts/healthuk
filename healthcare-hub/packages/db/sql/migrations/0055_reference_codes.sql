-- v36 human reference codes: VDI-5522, SUP-302, DEF-082.
-- Backfill existing rows: FORCE RLS would hide every organisation's rows from the migration role,
-- so it is lifted for this migration only (the app role never bypasses RLS), then restored.
ALTER TABLE vdi NO FORCE ROW LEVEL SECURITY;
ALTER TABLE defect NO FORCE ROW LEVEL SECURITY;
ALTER TABLE supervision_booking NO FORCE ROW LEVEL SECURITY;
ALTER TABLE vdi ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE supervision_booking ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE defect ADD COLUMN IF NOT EXISTS code text;

CREATE UNIQUE INDEX IF NOT EXISTS vdi_org_code_uidx
  ON vdi (organisation_id, code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supervision_booking_org_code_uidx
  ON supervision_booking (organisation_id, code) WHERE code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS defect_org_code_uidx
  ON defect (organisation_id, code) WHERE code IS NOT NULL;

-- The backfill below changes rows that are otherwise protected (checks are immutable; released
-- defects are closed). Only the new code column and the DEF- prefix of the description change, so
-- the guards are suspended for this migration alone.
ALTER TABLE vdi DISABLE TRIGGER vdi_immutable;
ALTER TABLE defect DISABLE TRIGGER defect_guard_trg;

-- v36 sample checks keep their v36 number (stored in notes when they were loaded).
UPDATE vdi SET code = substring(notes from '^VDI-[0-9]+')
 WHERE code IS NULL AND notes ~ '^VDI-[0-9]+';

-- Defects: take DEF-nnn from the start of the description and strip it.
UPDATE defect
   SET code = upper(substring(description from '^DEF-[0-9]+')),
       description = regexp_replace(description, '^DEF-[0-9]+[:\s]+', '', 'i')
 WHERE code IS NULL AND description ~* '^DEF-[0-9]+';

-- Remaining defects without a code get DEF-<n>.
DO $$
DECLARE
  org uuid;
  d record;
  n int;
BEGIN
  FOR org IN SELECT DISTINCT organisation_id FROM defect LOOP
    n := coalesce((
      SELECT max(substring(code from '[0-9]+')::int)
        FROM defect WHERE organisation_id = org AND code ~ '^DEF-[0-9]+'
    ), 0);
    FOR d IN
      SELECT id FROM defect WHERE organisation_id = org AND code IS NULL
      ORDER BY discovered_at, id
    LOOP
      n := n + 1;
      UPDATE defect SET code = 'DEF-' || lpad(n::text, 3, '0') WHERE id = d.id;
    END LOOP;
  END LOOP;
END $$;

-- VDIs without a code: VDI-<n> from 6000 per organisation.
DO $$
DECLARE
  org uuid;
  d record;
  n int;
BEGIN
  FOR org IN SELECT DISTINCT organisation_id FROM vdi LOOP
    n := greatest(5999, coalesce((
      SELECT max(substring(code from '[0-9]+')::int)
        FROM vdi WHERE organisation_id = org AND code ~ '^VDI-[0-9]+'
    ), 5999));
    FOR d IN
      SELECT id FROM vdi WHERE organisation_id = org AND code IS NULL
      ORDER BY captured_at, id
    LOOP
      n := n + 1;
      UPDATE vdi SET code = 'VDI-' || n::text WHERE id = d.id;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE vdi ENABLE TRIGGER vdi_immutable;
ALTER TABLE defect ENABLE TRIGGER defect_guard_trg;

-- Supervision bookings without a code: SUP-<n> from 200.
DO $$
DECLARE
  org uuid;
  d record;
  n int;
BEGIN
  FOR org IN SELECT DISTINCT organisation_id FROM supervision_booking LOOP
    n := greatest(199, coalesce((
      SELECT max(substring(code from '[0-9]+')::int)
        FROM supervision_booking WHERE organisation_id = org AND code ~ '^SUP-[0-9]+'
    ), 199));
    FOR d IN
      SELECT id FROM supervision_booking WHERE organisation_id = org AND code IS NULL
      ORDER BY scheduled_at, id
    LOOP
      n := n + 1;
      UPDATE supervision_booking SET code = 'SUP-' || n::text WHERE id = d.id;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE vdi FORCE ROW LEVEL SECURITY;
ALTER TABLE defect FORCE ROW LEVEL SECURITY;
ALTER TABLE supervision_booking FORCE ROW LEVEL SECURITY;
