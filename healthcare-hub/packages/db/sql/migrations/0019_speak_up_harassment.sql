-- Task 20: speaking up (Freedom to Speak Up) and the duty to take reasonable steps to prevent
-- sexual harassment (Equality Act 2010 s40A). Forward-only.

-- A concern raised by anyone in the organisation. Anonymous concerns hold no raiser and, when
-- raised in the hub, no recorder either: nothing in the row can identify the person.
CREATE TABLE speak_up_concern (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id       uuid NOT NULL REFERENCES organisation(id),
  code                  text NOT NULL,
  category              text NOT NULL CHECK (category IN ('SEXUAL_HARASSMENT', 'HARASSMENT', 'BULLYING',
                          'DISCRIMINATION', 'PATIENT_SAFETY', 'WORKER_SAFETY', 'FRAUD', 'OTHER')),
  channel               text NOT NULL CHECK (channel IN ('IN_APP', 'IN_PERSON', 'PHONE', 'EMAIL', 'LETTER')),
  anonymous             boolean NOT NULL,
  third_party           boolean NOT NULL DEFAULT false,
  raised_by             uuid,
  recorded_by           uuid,
  summary               text NOT NULL CHECK (length(summary) BETWEEN 10 AND 4000),
  raised_on             date NOT NULL,
  acknowledge_due       date NOT NULL,
  acknowledged_on       date,
  handler_user_id       uuid,
  status                text NOT NULL DEFAULT 'RECEIVED'
                          CHECK (status IN ('RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'CLOSED')),
  feedback_given_on     date,
  outcome               text CHECK (outcome IS NULL OR outcome IN ('UPHELD', 'PARTLY_UPHELD', 'NOT_UPHELD',
                          'NO_FURTHER_ACTION', 'REFERRED_ELSEWHERE')),
  outcome_text          text CHECK (outcome_text IS NULL OR length(outcome_text) BETWEEN 3 AND 2000),
  lessons               text CHECK (lessons IS NULL OR length(lessons) <= 2000),
  closed_on             date,
  closed_by             uuid,
  detriment_check_due   date,
  detriment_checked_on  date,
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (anonymous = (raised_by IS NULL)),
  CHECK (channel <> 'IN_APP' OR anonymous OR recorded_by = raised_by),
  CHECK (channel <> 'IN_APP' OR NOT anonymous OR recorded_by IS NULL),
  CHECK (channel = 'IN_APP' OR recorded_by IS NOT NULL),
  CHECK (status = 'RECEIVED' OR (acknowledged_on IS NOT NULL AND handler_user_id IS NOT NULL)),
  CHECK (acknowledged_on IS NULL OR acknowledged_on >= raised_on),
  CHECK ((status = 'CLOSED') = (closed_on IS NOT NULL AND closed_by IS NOT NULL AND outcome IS NOT NULL
                                AND outcome_text IS NOT NULL)),
  CHECK (status <> 'CLOSED' OR anonymous OR feedback_given_on IS NOT NULL),
  CHECK (closed_on IS NULL OR closed_on >= raised_on)
);
CREATE INDEX speak_up_concern_idx ON speak_up_concern (organisation_id, status, acknowledge_due);
CREATE INDEX speak_up_concern_raiser_idx ON speak_up_concern (organisation_id, raised_by);
CREATE TRIGGER speak_up_concern_version BEFORE UPDATE ON speak_up_concern
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE speak_up_concern ENABLE ROW LEVEL SECURITY;
ALTER TABLE speak_up_concern FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON speak_up_concern
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
-- Handlers see every concern; the person who raised a named concern sees only their own.
-- Inserts are open to members (the API checks speakup.raise) and return no row to the raiser.
CREATE POLICY speak_up_read ON speak_up_concern AS RESTRICTIVE FOR SELECT
  USING (app_has_permission('speakup.manage') OR (raised_by IS NOT NULL AND raised_by = app_user_id()));
CREATE POLICY speak_up_update ON speak_up_concern AS RESTRICTIVE FOR UPDATE
  USING (app_has_permission('speakup.manage')) WITH CHECK (app_has_permission('speakup.manage'));
GRANT SELECT, INSERT, UPDATE ON speak_up_concern TO hub_app;

-- Append-only history of what was done: notes, feedback to the person, detriment checks.
CREATE TABLE speak_up_note (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  concern_id          uuid NOT NULL REFERENCES speak_up_concern(id),
  kind                text NOT NULL CHECK (kind IN ('NOTE', 'FEEDBACK', 'DETRIMENT_CHECK', 'STATUS')),
  note                text NOT NULL CHECK (length(note) BETWEEN 3 AND 2000),
  on_date             date NOT NULL,
  detriment_reported  boolean,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'DETRIMENT_CHECK') = (detriment_reported IS NOT NULL))
);
CREATE INDEX speak_up_note_idx ON speak_up_note (organisation_id, concern_id, created_at);
ALTER TABLE speak_up_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE speak_up_note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON speak_up_note
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY speak_up_restricted ON speak_up_note AS RESTRICTIVE
  USING (app_has_permission('speakup.manage')) WITH CHECK (app_has_permission('speakup.manage'));
GRANT SELECT, INSERT ON speak_up_note TO hub_app;

-- The organisation's sexual harassment risk assessment. A draft is edited in place; approval by
-- a second person freezes it, and a new draft supersedes it.
CREATE TABLE harassment_risk_assessment (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  assessed_on      date NOT NULL,
  review_due       date NOT NULL,
  risks            jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'SUPERSEDED')),
  prepared_by      uuid NOT NULL,
  approved_by      uuid,
  approved_at      timestamptz,
  supersedes_id    uuid REFERENCES harassment_risk_assessment(id),
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (review_due > assessed_on),
  CHECK ((status = 'DRAFT') = (approved_by IS NULL)),
  CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);
CREATE INDEX harassment_ra_idx ON harassment_risk_assessment (organisation_id, status, review_due);
CREATE TRIGGER harassment_ra_version BEFORE UPDATE ON harassment_risk_assessment
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Approved assessments are history: only the status may move on (to SUPERSEDED).
CREATE FUNCTION harassment_ra_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (NEW.title, NEW.assessed_on, NEW.review_due, NEW.risks, NEW.prepared_by,
      NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.title, OLD.assessed_on, OLD.review_due,
      OLD.risks, OLD.prepared_by, OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'an approved harassment risk assessment cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER harassment_ra_frozen BEFORE UPDATE ON harassment_risk_assessment
  FOR EACH ROW EXECUTE FUNCTION harassment_ra_frozen();

ALTER TABLE harassment_risk_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE harassment_risk_assessment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON harassment_risk_assessment
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON harassment_risk_assessment TO hub_app;

-- speakup.manage reveals who raised named concerns: never for dispatcher- or crew-derived roles.
CREATE OR REPLACE FUNCTION restricted_for_dispatch_and_crew() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'staff.sensitive.view','staff.approve_role','staff.profile.manage','staff.lifecycle.transition',
    'events.safeguarding.view','admin.users.manage','admin.roles.manage','admin.export.full',
    'privacy.manage','allocation.exception.approve','admin.audit.view','admin.audit.verify',
    'speakup.manage'
  ]
$$;
