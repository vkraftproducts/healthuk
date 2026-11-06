-- Task 21: registration history, CQC rating display, directors' fit and proper person checks,
-- governance meetings and CQC notification drafts. Forward-only.

-- Every save of the registration record keeps a snapshot (the record itself stays one row).
CREATE TABLE registration_history (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  snapshot         jsonb NOT NULL,
  changed_fields   text[] NOT NULL DEFAULT '{}',
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  changed_by       uuid NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_history_idx ON registration_history (organisation_id, changed_at DESC);

-- The rating exactly as CQC published it, and where the provider displays it (reg 20A: within
-- 21 days of publication, at each premises and on the website). The hub never works out a rating.
CREATE TABLE cqc_rating_record (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id        uuid NOT NULL REFERENCES organisation(id),
  location_id            uuid REFERENCES location(id),
  overall                text NOT NULL CHECK (overall IN ('OUTSTANDING', 'GOOD', 'REQUIRES_IMPROVEMENT',
                           'INADEQUATE')),
  key_questions          jsonb NOT NULL DEFAULT '{}',
  published_on           date NOT NULL,
  report_url             text CHECK (report_url IS NULL OR report_url ~ '^https://'),
  display_due            date NOT NULL,
  displayed_premises_on  date,
  displayed_website_on   date,
  no_website             boolean NOT NULL DEFAULT false,
  recorded_by            uuid NOT NULL,
  version                int NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (displayed_premises_on IS NULL OR displayed_premises_on >= published_on),
  CHECK (displayed_website_on IS NULL OR displayed_website_on >= published_on)
);
CREATE INDEX cqc_rating_idx ON cqc_rating_record (organisation_id, published_on DESC);
CREATE TRIGGER cqc_rating_version BEFORE UPDATE ON cqc_rating_record
  FOR EACH ROW EXECUTE FUNCTION bump_version();
-- Only the display dates may change once recorded.
CREATE FUNCTION cqc_rating_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.location_id, NEW.overall, NEW.key_questions, NEW.published_on, NEW.report_url, NEW.display_due,
      NEW.recorded_by) IS DISTINCT FROM (OLD.location_id, OLD.overall, OLD.key_questions, OLD.published_on,
      OLD.report_url, OLD.display_due, OLD.recorded_by) THEN
    RAISE EXCEPTION 'a recorded rating cannot be changed; record the new rating instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cqc_rating_frozen BEFORE UPDATE ON cqc_rating_record
  FOR EACH ROW EXECUTE FUNCTION cqc_rating_frozen();

-- Fit and proper person checks for directors (reg 5). Append-only: each check is a new row.
CREATE TABLE director_fpp_check (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL REFERENCES organisation(id),
  director_name     text NOT NULL CHECK (length(director_name) BETWEEN 2 AND 120),
  director_role     text NOT NULL CHECK (length(director_role) BETWEEN 2 AND 120),
  user_id           uuid,
  checked_on        date NOT NULL,
  items             jsonb NOT NULL,
  declaration_on    date,
  outcome           text NOT NULL CHECK (outcome IN ('FIT', 'NOT_FIT', 'FURTHER_REVIEW')),
  next_review_due   date NOT NULL,
  notes             text CHECK (notes IS NULL OR length(notes) <= 2000),
  recorded_by       uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (next_review_due > checked_on),
  CHECK (user_id IS NULL OR user_id <> recorded_by)
);
CREATE INDEX director_fpp_idx ON director_fpp_check (organisation_id, lower(director_name), checked_on DESC);

-- Governance meetings. Minutes are frozen once approved by someone other than their author.
CREATE TABLE governance_meeting (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('BOARD', 'CLINICAL_GOVERNANCE', 'HEALTH_AND_SAFETY',
                     'QUALITY', 'INFECTION_CONTROL', 'OTHER')),
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  held_on          date NOT NULL,
  chair            text NOT NULL CHECK (length(chair) BETWEEN 2 AND 120),
  attendees        text[] NOT NULL DEFAULT '{}',
  apologies        text[] NOT NULL DEFAULT '{}',
  quorate          boolean NOT NULL,
  minutes          text NOT NULL CHECK (length(minutes) BETWEEN 3 AND 20000),
  decisions        text CHECK (decisions IS NULL OR length(decisions) <= 5000),
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED')),
  recorded_by      uuid NOT NULL,
  approved_by      uuid,
  approved_at      timestamptz,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK ((status = 'APPROVED') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> recorded_by)
);
CREATE INDEX governance_meeting_idx ON governance_meeting (organisation_id, held_on DESC);
CREATE TRIGGER governance_meeting_version BEFORE UPDATE ON governance_meeting
  FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE FUNCTION governance_meeting_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'approved minutes cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER governance_meeting_frozen BEFORE UPDATE ON governance_meeting
  FOR EACH ROW EXECUTE FUNCTION governance_meeting_frozen();

-- Actions can now come from a meeting.
ALTER TABLE action DROP CONSTRAINT IF EXISTS action_source_type_check;
ALTER TABLE action ADD CONSTRAINT action_source_type_check
  CHECK (source_type IN ('FINDING', 'EVENT', 'RISK', 'CORRESPONDENCE', 'FEEDBACK', 'MEETING'));

-- Drafts of CQC statutory notifications. The hub never sends them: someone submits through the
-- CQC portal and records the date and CQC's reference. A second person reviews before "ready".
CREATE TABLE cqc_notification (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('DEATH', 'SERIOUS_INJURY', 'ABUSE_ALLEGATION',
                     'POLICE_INCIDENT', 'SERVICE_DISRUPTION', 'MANAGER_ABSENCE', 'CHANGE_OF_DETAILS',
                     'OTHER')),
  event_id         uuid REFERENCES event(id),
  occurred_on      date NOT NULL,
  due_on           date NOT NULL,
  summary          text NOT NULL CHECK (length(summary) BETWEEN 10 AND 4000),
  actions_taken    text CHECK (actions_taken IS NULL OR length(actions_taken) <= 4000),
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'READY', 'SUBMITTED',
                     'NOT_REQUIRED')),
  prepared_by      uuid NOT NULL,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  submitted_on     date,
  cqc_reference    text CHECK (cqc_reference IS NULL OR length(cqc_reference) BETWEEN 2 AND 60),
  not_required_reason text CHECK (not_required_reason IS NULL OR length(not_required_reason) BETWEEN 3 AND 1000),
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (reviewed_by IS NULL OR reviewed_by <> prepared_by),
  CHECK (status IN ('DRAFT', 'NOT_REQUIRED') OR reviewed_by IS NOT NULL),
  CHECK ((status = 'SUBMITTED') = (submitted_on IS NOT NULL)),
  CHECK ((status = 'NOT_REQUIRED') = (not_required_reason IS NOT NULL)),
  -- A planned manager absence is notified before it starts, so only other kinds are checked.
  CHECK (submitted_on IS NULL OR kind = 'MANAGER_ABSENCE' OR submitted_on >= occurred_on)
);
CREATE INDEX cqc_notification_idx ON cqc_notification (organisation_id, status, due_on);
CREATE TRIGGER cqc_notification_version BEFORE UPDATE ON cqc_notification
  FOR EACH ROW EXECUTE FUNCTION bump_version();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['registration_history', 'cqc_rating_record', 'director_fpp_check',
                           'governance_meeting', 'cqc_notification'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
-- Fit and proper checks can record sensitive findings: their own permission only.
CREATE POLICY fpp_restricted ON director_fpp_check AS RESTRICTIVE
  USING (app_has_permission('governance.fit_proper.manage'))
  WITH CHECK (app_has_permission('governance.fit_proper.manage'));

GRANT SELECT, INSERT ON registration_history, director_fpp_check TO hub_app;   -- append-only
GRANT SELECT, INSERT, UPDATE ON cqc_rating_record, governance_meeting, cqc_notification TO hub_app;

CREATE OR REPLACE FUNCTION restricted_for_dispatch_and_crew() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'staff.sensitive.view','staff.approve_role','staff.profile.manage','staff.lifecycle.transition',
    'events.safeguarding.view','admin.users.manage','admin.roles.manage','admin.export.full',
    'privacy.manage','allocation.exception.approve','admin.audit.view','admin.audit.verify',
    'speakup.manage','governance.fit_proper.manage'
  ]
$$;
