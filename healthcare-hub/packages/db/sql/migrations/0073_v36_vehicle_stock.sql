-- v36 front end ↔ real tables, fleet area part 3 (step 2, 19 Nov 2026): medicines and gases kept
-- on each vehicle (S.med: { 'AMB-01': [[item, expected, found, expires], …] }). One row per
-- vehicle, its code the call sign, the item list as v36 keeps it. Future days' journeys (S.fjobs)
-- are rows of v36_job (0072) with a later job_date; S.dcEvery is a row of v36_value (0084).
SELECT v36_register_create('v36_vehicle_stock', $c$
  value jsonb CHECK (value IS NULL OR jsonb_typeof(value) IN ('array', 'null'))
$c$);
