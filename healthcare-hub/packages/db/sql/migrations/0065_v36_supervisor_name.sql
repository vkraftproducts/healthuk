-- v36 supervisions (S.sup) name their supervisor. When the saved copy is moved in and that person
-- is not a member here, the name is kept as text (the importing manager stands in as the
-- supervisor of record, as for every other v36 name that is not a member).
ALTER TABLE supervision_booking ADD COLUMN IF NOT EXISTS supervisor_name text
  CHECK (supervisor_name IS NULL OR length(supervisor_name) BETWEEN 1 AND 120);
