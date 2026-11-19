-- v36 front end ↔ real tables, governance part 2 (step 2, 19 Nov 2026): complaints, speak up,
-- governance meetings, fit and proper checks, CQC notifications, data breaches, subject access
-- requests, continuity plans and tests, locations, statement of purpose, visitors, retention,
-- escalation rules and log, deputies, compliments and safeguarding. Frame as in 0062/0072.

SELECT v36_register_create('v36_complaint', $c$
  on_date date,
  via text,
  patient_ref text,
  category text,
  summary text,
  state text,
  ack_on date,
  lead uuid REFERENCES app_user(id),
  lead_name text,
  consent boolean,
  contact_pref text,
  responded_on date,
  outcome text,
  findings text,
  learning text,
  share_learning boolean
$c$);
SELECT v36_register_create('v36_speak_up', $c$
  category text,
  concern text,
  anonymous boolean,
  track_code text,
  raised_on date,
  state text,
  ack_on date,
  handler uuid REFERENCES app_user(id),
  handler_name text,
  notes jsonb,
  feedback text,
  raised_by uuid REFERENCES app_user(id),
  raised_by_name text,
  about_third_party boolean,
  detriment_checked boolean
$c$);
SELECT v36_register_create('v36_meeting', $c$
  meeting_type text,
  title text,
  held_on date,
  chair uuid REFERENCES app_user(id),
  chair_name text,
  attendees text,
  apologies text,
  quorate boolean,
  minutes text,
  decisions jsonb
$c$);
SELECT v36_register_create('v36_fpp_check', $c$
  who uuid REFERENCES app_user(id),
  who_name text,
  role_title text,
  checked_on date,
  checked_by uuid REFERENCES app_user(id),
  checked_by_name text,
  items_done numeric,
  outcome text,
  next_due date,
  evidence jsonb
$c$);
SELECT v36_register_create('v36_cqc_notification', $c$
  kind text,
  regulation text,
  drafted_on date,
  about text,
  state text,
  submitted_on date,
  cqc_ref text,
  drafted_by uuid REFERENCES app_user(id),
  drafted_by_name text,
  due_on date
$c$);
SELECT v36_register_create('v36_breach', $c$
  aware_on date,
  aware_at text,
  what text,
  people_affected numeric,
  risk text,
  state text,
  decision text,
  logged_by uuid REFERENCES app_user(id),
  logged_by_name text,
  ico_ref text
$c$);
SELECT v36_register_create('v36_sar', $c$
  received_on date,
  requester text,
  id_verified boolean,
  state text,
  due_on date,
  extension_reason text,
  responded_on date
$c$);
SELECT v36_register_create('v36_bcp_plan', $c$
  title text,
  steps text,
  last_tested date,
  last_outcome text,
  owner uuid REFERENCES app_user(id),
  owner_name text
$c$);
SELECT v36_register_create('v36_bcp_test', $c$
  tested_on date,
  plan_code text,
  method text,
  outcome text,
  tested_by uuid REFERENCES app_user(id),
  tested_by_name text
$c$);
SELECT v36_register_create('v36_location', $c$
  name text,
  address text,
  regulated_activities text,
  registered_manager uuid REFERENCES app_user(id),
  registered_manager_name text
$c$);
SELECT v36_register_create('v36_sop_version', $c$
  drafted_on date,
  drafted_by uuid REFERENCES app_user(id),
  drafted_by_name text,
  published_by uuid REFERENCES app_user(id),
  published_by_name text,
  state text,
  summary text,
  notification_code text
$c$);
SELECT v36_register_create('v36_visitor', $c$
  name text,
  from_org text,
  purpose text,
  signed_in text,
  signed_out text,
  host uuid REFERENCES app_user(id),
  host_name text,
  visit_on date
$c$);
SELECT v36_register_create('v36_retention', $c$
  record_kind text,
  keep_for text,
  then_action text,
  state text,
  proposed_by uuid REFERENCES app_user(id),
  proposed_by_name text,
  approved_by uuid REFERENCES app_user(id),
  approved_by_name text,
  pending_keep text,
  reason text
$c$);
SELECT v36_register_create('v36_escalation_rule', $c$
  warn_days numeric,
  lead_days numeric,
  rm_days numeric,
  email boolean
$c$);
SELECT v36_register_create('v36_escalation_log', $c$
  note text
$c$);
SELECT v36_register_create('v36_deputy', $c$
  lead_role text,
  deputy_role text,
  from_on date,
  to_on date,
  covers text,
  set_by uuid REFERENCES app_user(id),
  set_by_name text,
  set_at text,
  ended jsonb
$c$);
SELECT v36_register_create('v36_compliment', $c$
  received_on date,
  about text,
  compliment text,
  theme text
$c$);
SELECT v36_register_create('v36_safeguarding', $c$
  raised_on date,
  subject text,
  category text,
  patient_ref text,
  raised_by uuid REFERENCES app_user(id),
  raised_by_name text,
  referred_to text,
  referral_ref text,
  state text,
  event_code text,
  cqc_notification jsonb,
  referred_on date,
  outcome text
$c$);

-- Contractors (S.ctr) keep using the contractor table of 0082; v36 fields it has no column for
-- go in extra, as in every register.
ALTER TABLE contractor ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE contractor ADD COLUMN created_by uuid REFERENCES app_user(id);
GRANT DELETE ON contractor TO hub_app;
