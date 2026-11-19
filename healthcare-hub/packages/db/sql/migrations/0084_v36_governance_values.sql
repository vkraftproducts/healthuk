-- v36 front end ↔ real tables, governance area part 3 (step 2, 19 Nov 2026).
--  * v36_value: a v36 collection that is one value (S.dspt, S.cqSub, S.kpiT, S.guardian,
--    S.dcEvery), one row per organisation and S key (code).
--  * v36_cqc_answer: the CQC self-audit answers (S.cqA: '0-4' → 'P' | 'A' | 'F' | 'N' | '').
--  * v36_fft_month: Friends and Family Test results per month (S.fft: [month, responses, % good]).
--  * v36_kpi_month: NHS contract figures per month (S.kpi: [month, journeys, on time %, aborted,
--    average return wait]).
SELECT v36_register_create('v36_value', $c$
  value jsonb
$c$);
SELECT v36_register_create('v36_cqc_answer', $c$
  value jsonb CHECK (value IS NULL OR value IN ('"P"', '"A"', '"F"', '"N"', '""'))
$c$);
SELECT v36_register_create('v36_fft_month', $c$
  month text CHECK (month ~ '^\d{4}-\d{2}$'),
  responses numeric CHECK (responses >= 0),
  pct_good numeric CHECK (pct_good BETWEEN 0 AND 100)
$c$);
SELECT v36_register_create('v36_kpi_month', $c$
  month text CHECK (month ~ '^\d{4}-\d{2}$'),
  journeys numeric CHECK (journeys >= 0),
  on_time_pct numeric CHECK (on_time_pct BETWEEN 0 AND 100),
  aborted numeric CHECK (aborted >= 0),
  avg_wait numeric CHECK (avg_wait >= 0)
$c$);
