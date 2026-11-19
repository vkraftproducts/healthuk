-- v36 front end ↔ real tables, governance registers (step 2, 19 Nov 2026): governance meetings,
-- compliments, contractors and visitors, speak up, safeguarding referrals.

-- Governance meetings: v36 records a meeting even when the minutes box is left empty.
ALTER TABLE governance_meeting DROP CONSTRAINT governance_meeting_minutes_check;
ALTER TABLE governance_meeting ADD CONSTRAINT governance_meeting_minutes_check
  CHECK (length(minutes) <= 20000);
-- Each decision line and the action it became (v36 meet[].dec: [{t, act}]).
ALTER TABLE governance_meeting ADD COLUMN decision_links jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(decision_links) = 'array');

-- Compliments keep v36's reference (CPL-12).
ALTER TABLE feedback_item ADD COLUMN code text CHECK (code IS NULL OR length(code) BETWEEN 2 AND 20);
CREATE UNIQUE INDEX feedback_item_org_code_uidx ON feedback_item (organisation_id, code) WHERE code IS NOT NULL;

-- Speak up: a named concern can come from someone without a login (recorded by the guardian).
ALTER TABLE speak_up_concern ADD COLUMN raised_by_name text
  CHECK (raised_by_name IS NULL OR length(raised_by_name) BETWEEN 2 AND 120);
ALTER TABLE speak_up_concern DROP CONSTRAINT speak_up_concern_check;
ALTER TABLE speak_up_concern ADD CONSTRAINT speak_up_concern_check
  CHECK (anonymous = (raised_by IS NULL AND raised_by_name IS NULL));

-- Safeguarding: v36 names the staff member who raised it, who may have no login.
ALTER TABLE safeguarding_referral ADD COLUMN raised_by_name text
  CHECK (raised_by_name IS NULL OR length(raised_by_name) BETWEEN 2 AND 120);

-- Contractors (S.ctr): insurance and competence checked by a second person.
CREATE TABLE contractor (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL CHECK (length(code) BETWEEN 2 AND 20),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  work             text CHECK (work IS NULL OR length(work) <= 300),
  insurance_valid_to date,
  competence_note  text CHECK (competence_note IS NULL OR length(competence_note) <= 500),
  status           text NOT NULL DEFAULT 'Approved' CHECK (length(status) BETWEEN 2 AND 40),
  recorded_by      uuid REFERENCES app_user(id),
  recorded_by_name text,
  checked_by       uuid REFERENCES app_user(id),
  checked_by_name  text,
  checked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (checked_by IS NULL OR recorded_by IS NULL OR checked_by <> recorded_by)
);
CREATE TRIGGER contractor_version BEFORE UPDATE ON contractor FOR EACH ROW EXECUTE FUNCTION bump_version();
ALTER TABLE contractor ENABLE ROW LEVEL SECURITY;
ALTER TABLE contractor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contractor
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON contractor TO hub_app;

-- Visitors signed in and out (S.vis).
CREATE TABLE visitor_log (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  code            text NOT NULL CHECK (length(code) BETWEEN 2 AND 20),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  from_text       text CHECK (from_text IS NULL OR length(from_text) <= 200),
  purpose         text CHECK (purpose IS NULL OR length(purpose) <= 300),
  host            text CHECK (host IS NULL OR length(host) <= 120),
  visit_on        date NOT NULL,
  signed_in       text NOT NULL CHECK (signed_in ~ '^\d{2}:\d{2}$'),
  signed_out      text CHECK (signed_out IS NULL OR signed_out ~ '^\d{2}:\d{2}$'),
  recorded_by     uuid NOT NULL REFERENCES app_user(id),
  signed_out_by   uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code)
);
CREATE TRIGGER visitor_log_version BEFORE UPDATE ON visitor_log FOR EACH ROW EXECUTE FUNCTION bump_version();
ALTER TABLE visitor_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE visitor_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visitor_log
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON visitor_log TO hub_app;
