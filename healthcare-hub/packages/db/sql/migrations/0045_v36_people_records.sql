-- v36 batch 2 (17 Nov 2026): probation reviews and appraisals, sickness absence with
-- return-to-work interviews, and leavers with a leaving checklist. Forward-only and additive.

-- ---------------------------------------------------------------------------------------------
-- Reviews: probation (3 and 6 months), annual appraisals and other reviews. A review is
-- scheduled, then recorded once by someone other than the person reviewed.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE staff_review (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  code             text NOT NULL,
  staff_id         uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('PROBATION_3M', 'PROBATION_6M', 'APPRAISAL', 'OTHER')),
  due_on           date NOT NULL,
  status           text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'DONE', 'CANCELLED')),
  outcome          text CHECK (outcome IS NULL OR outcome IN ('PASSED', 'EXTENDED', 'NOT_PASSED',
                     'MEETS', 'EXCEEDS', 'NEEDS_SUPPORT', 'RECORDED')),
  notes            text CHECK (notes IS NULL OR length(notes) BETWEEN 3 AND 4000),
  objectives       text CHECK (objectives IS NULL OR length(objectives) BETWEEN 3 AND 4000),
  reviewed_on      date,
  reviewer_user_id uuid REFERENCES app_user(id),
  recorded_by      uuid,
  cancel_reason    text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 3 AND 500),
  follows_id       uuid REFERENCES staff_review(id),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK ((status = 'DONE') = (outcome IS NOT NULL AND reviewed_on IS NOT NULL
                              AND reviewer_user_id IS NOT NULL AND recorded_by IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  CHECK (kind NOT IN ('PROBATION_3M', 'PROBATION_6M') OR outcome IS NULL
         OR outcome IN ('PASSED', 'EXTENDED', 'NOT_PASSED')),
  CHECK (kind <> 'APPRAISAL' OR outcome IS NULL OR outcome IN ('MEETS', 'EXCEEDS', 'NEEDS_SUPPORT')),
  CHECK (kind <> 'OTHER' OR outcome IS NULL OR outcome = 'RECORDED')
);
CREATE INDEX staff_review_idx ON staff_review (organisation_id, status, due_on);
CREATE INDEX staff_review_staff_idx ON staff_review (organisation_id, staff_id);
CREATE TRIGGER staff_review_version BEFORE UPDATE ON staff_review
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- A recorded or cancelled review is history.
CREATE FUNCTION staff_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'SCHEDULED' THEN
    RAISE EXCEPTION 'a recorded or cancelled review cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.staff_id <> OLD.staff_id OR NEW.kind <> OLD.kind OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'who and what is reviewed cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_review_guard BEFORE UPDATE ON staff_review
  FOR EACH ROW EXECUTE FUNCTION staff_review_guard();
CREATE TRIGGER staff_review_no_delete BEFORE DELETE ON staff_review
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Sickness absence. Only a broad category: medical details stay with occupational health.
-- While someone is off, an "OTHER" restriction marks them unavailable; a phased return adds
-- its own time-limited restriction the planner shows.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE staff_absence (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id          uuid NOT NULL,
  code                     text NOT NULL,
  staff_id                 uuid NOT NULL,
  first_day                date NOT NULL,
  last_day                 date,
  category                 text NOT NULL CHECK (category IN ('MUSCULOSKELETAL', 'RESPIRATORY',
                             'GASTROINTESTINAL', 'MENTAL_HEALTH', 'INJURY_AT_WORK', 'INFECTION',
                             'OTHER')),
  off_restriction_id       uuid,
  rtw_on                   date,
  rtw_by_user_id           uuid REFERENCES app_user(id),
  rtw_recorded_by          uuid,
  rtw_note                 text CHECK (rtw_note IS NULL OR length(rtw_note) BETWEEN 3 AND 1000),
  phased                   boolean NOT NULL DEFAULT false,
  phased_terms             text CHECK (phased_terms IS NULL OR length(phased_terms) BETWEEN 3 AND 200),
  phased_until             date,
  phased_restriction_id    uuid,
  recorded_by              uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  version                  int NOT NULL DEFAULT 1,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (last_day IS NULL OR last_day >= first_day),
  CHECK ((rtw_on IS NULL) = (rtw_by_user_id IS NULL) AND (rtw_on IS NULL) = (rtw_recorded_by IS NULL)),
  CHECK (rtw_on IS NULL OR (last_day IS NOT NULL AND rtw_on > last_day)),
  CHECK (phased = (phased_terms IS NOT NULL) AND phased = (phased_until IS NOT NULL)),
  CHECK (NOT phased OR rtw_on IS NOT NULL),
  CHECK (phased_until IS NULL OR phased_until > rtw_on)
);
CREATE INDEX staff_absence_idx ON staff_absence (organisation_id, staff_id, first_day);
-- One open absence per person at a time.
CREATE UNIQUE INDEX staff_absence_open_key ON staff_absence (organisation_id, staff_id) WHERE last_day IS NULL;
CREATE TRIGGER staff_absence_version BEFORE UPDATE ON staff_absence
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE FUNCTION staff_absence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.staff_id <> OLD.staff_id OR NEW.first_day <> OLD.first_day OR NEW.recorded_by <> OLD.recorded_by THEN
    RAISE EXCEPTION 'who and when cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.last_day IS NOT NULL AND NEW.last_day IS DISTINCT FROM OLD.last_day THEN
    RAISE EXCEPTION 'the return date is already recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.rtw_on IS NOT NULL THEN
    RAISE EXCEPTION 'the return-to-work interview is already recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_absence_guard BEFORE UPDATE ON staff_absence
  FOR EACH ROW EXECUTE FUNCTION staff_absence_guard();
CREATE TRIGGER staff_absence_no_delete BEFORE DELETE ON staff_absence
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Leavers: the leaving checklist. Access is ended by the existing lifecycle transition to LEAVER;
-- the record is complete only after that and every item is ticked. History keeps their name.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE leaver_record (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id      uuid NOT NULL,
  code                 text NOT NULL,
  staff_id             uuid NOT NULL,
  last_day             date NOT NULL,
  reason               text NOT NULL CHECK (reason IN ('RESIGNED', 'RETIRED', 'END_OF_CONTRACT',
                         'DISMISSED', 'REDUNDANCY', 'OTHER')),
  reason_note          text CHECK (reason_note IS NULL OR length(reason_note) BETWEEN 3 AND 500),
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELLED')),
  badge_returned_at    timestamptz,
  badge_returned_by    uuid,
  kit_returned_at      timestamptz,
  kit_returned_by      uuid,
  payroll_told_at      timestamptz,
  payroll_told_by      uuid,
  exit_interview       text CHECK (exit_interview IS NULL OR exit_interview IN ('DONE', 'DECLINED')),
  exit_interview_at    timestamptz,
  exit_interview_by    uuid,
  keep_until           date,
  completed_at         timestamptz,
  completed_by         uuid,
  cancel_reason        text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 3 AND 500),
  started_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK ((badge_returned_at IS NULL) = (badge_returned_by IS NULL)),
  CHECK ((kit_returned_at IS NULL) = (kit_returned_by IS NULL)),
  CHECK ((payroll_told_at IS NULL) = (payroll_told_by IS NULL)),
  CHECK ((exit_interview IS NULL) = (exit_interview_at IS NULL) AND (exit_interview IS NULL) = (exit_interview_by IS NULL)),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL AND completed_by IS NOT NULL AND keep_until IS NOT NULL)),
  CHECK (status <> 'COMPLETED' OR (badge_returned_at IS NOT NULL AND kit_returned_at IS NOT NULL
                                   AND payroll_told_at IS NOT NULL AND exit_interview IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE UNIQUE INDEX leaver_record_open_key ON leaver_record (organisation_id, staff_id) WHERE status = 'OPEN';
CREATE INDEX leaver_record_idx ON leaver_record (organisation_id, status, last_day);
CREATE TRIGGER leaver_record_version BEFORE UPDATE ON leaver_record
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE FUNCTION leaver_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'a completed or cancelled leaver record cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.staff_id <> OLD.staff_id OR NEW.started_by <> OLD.started_by THEN
    RAISE EXCEPTION 'who is leaving cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  -- A ticked item stays ticked.
  IF (OLD.badge_returned_at IS NOT NULL AND NEW.badge_returned_at IS DISTINCT FROM OLD.badge_returned_at)
     OR (OLD.kit_returned_at IS NOT NULL AND NEW.kit_returned_at IS DISTINCT FROM OLD.kit_returned_at)
     OR (OLD.payroll_told_at IS NOT NULL AND NEW.payroll_told_at IS DISTINCT FROM OLD.payroll_told_at)
     OR (OLD.exit_interview IS NOT NULL AND NEW.exit_interview IS DISTINCT FROM OLD.exit_interview) THEN
    RAISE EXCEPTION 'a ticked item cannot be unticked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leaver_record_guard BEFORE UPDATE ON leaver_record
  FOR EACH ROW EXECUTE FUNCTION leaver_record_guard();
CREATE TRIGGER leaver_record_no_delete BEFORE DELETE ON leaver_record
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_review', 'staff_absence', 'leaver_record'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;

-- Absence is health-related: HR (sensitive staff data) or the person themselves.
CREATE POLICY staff_absence_restricted ON staff_absence AS RESTRICTIVE
  USING (app_has_permission('staff.sensitive.view')
         OR staff_id IN (SELECT s.id FROM staff s WHERE s.user_id = app_user_id()))
  WITH CHECK (app_has_permission('staff.sensitive.view'));

GRANT SELECT, INSERT, UPDATE ON staff_review, staff_absence, leaver_record TO hub_app;
