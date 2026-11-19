-- v36 front end ↔ real tables, fleet area part 2 (step 2, 19 Nov 2026): today's journeys
-- (S.jobs), accidents (S.acc), equipment and its inspection regimes (S.eq), premises safety items
-- (S.prem), oxygen store readings (S.o2) and controlled drug balance checks (S.cd).
-- Each register has the frame of 0062 (code, extra, version, RLS forced).

CREATE OR REPLACE FUNCTION v36_register_create(t text, cols text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TABLE %I (
       id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
       organisation_id uuid NOT NULL REFERENCES organisation(id),
       code text NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
       %s,
       extra jsonb NOT NULL DEFAULT ''{}''::jsonb CHECK (jsonb_typeof(extra) = ''object''),
       created_by uuid REFERENCES app_user(id),
       created_at timestamptz NOT NULL DEFAULT now(),
       version int NOT NULL DEFAULT 1,
       updated_at timestamptz NOT NULL DEFAULT now())', t, cols);
  PERFORM v36_register_secure(t);
END $$;

-- Journeys: v36 allocates a vehicle and crew to each journey directly.
SELECT v36_register_create('v36_job', $c$
  job_date date NOT NULL,
  vehicle_id uuid REFERENCES vehicle(id),
  pickup_time text CHECK (pickup_time ~ '^\d{2}:\d{2}$'),
  minutes numeric CHECK (minutes BETWEEN 0 AND 1440),
  crew_staff_id uuid REFERENCES staff(id),
  crew2_staff_id uuid REFERENCES staff(id),
  patient_ref text CHECK (patient_ref ~ '^PT-\d+$'),
  mobility text,
  flag numeric,
  return_of text
$c$);
CREATE INDEX v36_job_day_idx ON v36_job (organisation_id, job_date);

SELECT v36_register_create('v36_accident', $c$
  vehicle_id uuid REFERENCES vehicle(id),
  occurred_on date,
  what text CHECK (length(what) <= 2000),
  third_party text CHECK (length(third_party) <= 500),
  police_ref text CHECK (length(police_ref) <= 100),
  photos numeric CHECK (photos >= 0),
  insurer_ref text CHECK (length(insurer_ref) <= 100),
  roadworthy boolean,
  state text CHECK (state IN ('Awaiting repair', 'Off the road', 'Repaired')),
  repair jsonb,
  reported_by uuid REFERENCES app_user(id),
  reported_by_name text
$c$);

SELECT v36_register_create('v36_equipment', $c$
  category text,
  location_label text,
  swl_kg numeric,
  gives text,
  regimes jsonb CHECK (regimes IS NULL OR jsonb_typeof(regimes) = 'array'),
  quarantine jsonb
$c$);

SELECT v36_register_create('v36_premises_item', $c$
  area text,
  item text CHECK (length(item) <= 300),
  every_days numeric CHECK (every_days > 0),
  last_done date,
  owner_user_id uuid REFERENCES app_user(id),
  owner_user_id_name text,
  evidence jsonb
$c$);

SELECT v36_register_create('v36_oxygen_reading', $c$
  read_on date,
  temperature_c numeric,
  full_cylinders numeric,
  in_use numeric,
  empty_cylinders numeric,
  signage_ok boolean,
  ventilation_ok boolean,
  read_by uuid REFERENCES app_user(id),
  read_by_name text
$c$);

SELECT v36_register_create('v36_cd_check', $c$
  checked_on date,
  drug text CHECK (length(drug) <= 200),
  store text,
  counted numeric,
  expected numeric,
  checked_by uuid REFERENCES app_user(id),
  checked_by_name text,
  witness uuid REFERENCES app_user(id),
  witness_name text,
  CHECK (witness IS NULL OR checked_by IS NULL OR witness <> checked_by)
$c$);
