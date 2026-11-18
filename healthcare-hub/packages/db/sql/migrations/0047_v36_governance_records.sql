-- v36 batch 4 (17 Nov 2026): business continuity plans with a yearly test log, the statement of
-- purpose as versioned records, and the Data Security and Protection Toolkit tracker.
-- Forward-only and additive.

-- ---------------------------------------------------------------------------------------------
-- Business continuity plans and their tests (v36 screen 43).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE continuity_plan (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL,
  title            text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  steps            text NOT NULL CHECK (length(steps) BETWEEN 10 AND 4000),
  owner_user_id    uuid NOT NULL REFERENCES app_user(id),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RETIRED')),
  retired_by       uuid,
  retired_at       timestamptz,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL AND retired_by IS NOT NULL))
);
CREATE INDEX continuity_plan_idx ON continuity_plan (organisation_id, status);
CREATE TRIGGER continuity_plan_version BEFORE UPDATE ON continuity_plan
  FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE FUNCTION continuity_plan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'a retired plan cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER continuity_plan_guard BEFORE UPDATE ON continuity_plan
  FOR EACH ROW EXECUTE FUNCTION continuity_plan_guard();
CREATE TRIGGER continuity_plan_no_delete BEFORE DELETE ON continuity_plan
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE continuity_test (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  plan_id          uuid NOT NULL REFERENCES continuity_plan(id),
  tested_on        date NOT NULL,
  method           text NOT NULL CHECK (method IN ('TABLETOP', 'LIVE', 'REAL_EVENT')),
  result           text NOT NULL CHECK (result IN ('PASSED', 'PASSED_WITH_ISSUES', 'ACTIONS_RAISED', 'FAILED')),
  notes            text CHECK (notes IS NULL OR length(notes) BETWEEN 3 AND 2000),
  follow_up        text CHECK (follow_up IS NULL OR length(follow_up) BETWEEN 3 AND 2000),
  recorded_by      uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Anything short of a clean pass says what happens next.
  CHECK (result = 'PASSED' OR follow_up IS NOT NULL)
);
CREATE INDEX continuity_test_idx ON continuity_test (organisation_id, plan_id, tested_on);
CREATE TRIGGER continuity_test_immutable BEFORE UPDATE OR DELETE ON continuity_test
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Statement of purpose versions (v36 screen 40). A draft is published by a second person;
-- publishing supersedes the previous version and drafts the CQC notification.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE statement_of_purpose_version (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL REFERENCES organisation(id),
  version_no        int NOT NULL CHECK (version_no >= 1),
  summary           text NOT NULL CHECK (length(summary) BETWEEN 3 AND 2000),
  evidence_item_id  uuid,
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN')),
  drafted_by        uuid NOT NULL,
  drafted_at        timestamptz NOT NULL DEFAULT now(),
  published_by      uuid,
  published_at      timestamptz,
  notification_id   uuid REFERENCES cqc_notification(id),
  version           int NOT NULL DEFAULT 1,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, version_no),
  FOREIGN KEY (evidence_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id),
  CHECK ((published_by IS NULL) = (published_at IS NULL)),
  CHECK (status NOT IN ('PUBLISHED', 'SUPERSEDED') OR published_by IS NOT NULL),
  CHECK (published_by IS NULL OR published_by <> drafted_by)
);
CREATE UNIQUE INDEX sop_one_draft_key ON statement_of_purpose_version (organisation_id) WHERE status = 'DRAFT';
CREATE UNIQUE INDEX sop_one_published_key ON statement_of_purpose_version (organisation_id) WHERE status = 'PUBLISHED';
CREATE TRIGGER sop_version_version BEFORE UPDATE ON statement_of_purpose_version
  FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE FUNCTION sop_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SUPERSEDED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'this version is history' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'PUBLISHED' AND (NEW.status <> 'SUPERSEDED' OR (NEW.summary, NEW.evidence_item_id,
      NEW.published_by, NEW.published_at) IS DISTINCT FROM (OLD.summary, OLD.evidence_item_id,
      OLD.published_by, OLD.published_at)) THEN
    RAISE EXCEPTION 'a published version is only superseded' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version_no <> OLD.version_no OR NEW.drafted_by <> OLD.drafted_by THEN
    RAISE EXCEPTION 'version number and author cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sop_version_guard BEFORE UPDATE ON statement_of_purpose_version
  FOR EACH ROW EXECUTE FUNCTION sop_version_guard();
CREATE TRIGGER sop_version_no_delete BEFORE DELETE ON statement_of_purpose_version
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Data Security and Protection Toolkit (v36 screen 39): one assessment per year and the evidence
-- items tracked towards it. The hub does not submit to the toolkit; it records what was submitted.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE dspt_assessment (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  year             text NOT NULL CHECK (year ~ '^20[0-9]{2}-[0-9]{2}$'),
  due_on           date NOT NULL,
  status           text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'SUBMITTED')),
  submitted_on     date,
  outcome          text CHECK (outcome IS NULL OR outcome IN ('STANDARDS_EXCEEDED', 'STANDARDS_MET',
                     'APPROACHING_STANDARDS', 'STANDARDS_NOT_MET')),
  submitted_by     uuid,
  reference        text CHECK (reference IS NULL OR length(reference) BETWEEN 2 AND 60),
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, year),
  CHECK ((status = 'SUBMITTED') = (submitted_on IS NOT NULL AND outcome IS NOT NULL AND submitted_by IS NOT NULL))
);
CREATE TRIGGER dspt_assessment_version BEFORE UPDATE ON dspt_assessment
  FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE FUNCTION dspt_assessment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'SUBMITTED' THEN
    RAISE EXCEPTION 'a submitted assessment cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dspt_assessment_guard BEFORE UPDATE ON dspt_assessment
  FOR EACH ROW EXECUTE FUNCTION dspt_assessment_guard();
CREATE TRIGGER dspt_assessment_no_delete BEFORE DELETE ON dspt_assessment
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE dspt_item (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL REFERENCES organisation(id),
  assessment_id     uuid NOT NULL REFERENCES dspt_assessment(id),
  position          int NOT NULL CHECK (position BETWEEN 1 AND 200),
  title             text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  status            text NOT NULL DEFAULT 'NOT_YET' CHECK (status IN ('NOT_YET', 'IN_PLACE')),
  evidence_note     text CHECK (evidence_note IS NULL OR length(evidence_note) BETWEEN 3 AND 1000),
  evidence_item_id  uuid,
  marked_by         uuid,
  marked_at         timestamptz,
  version           int NOT NULL DEFAULT 1,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assessment_id, position),
  FOREIGN KEY (evidence_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id),
  CHECK ((status = 'IN_PLACE') = (marked_by IS NOT NULL AND marked_at IS NOT NULL AND evidence_note IS NOT NULL))
);
CREATE TRIGGER dspt_item_version BEFORE UPDATE ON dspt_item FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER dspt_item_no_delete BEFORE DELETE ON dspt_item FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['continuity_plan', 'continuity_test', 'statement_of_purpose_version',
                           'dspt_assessment', 'dspt_item'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON continuity_plan, statement_of_purpose_version, dspt_assessment, dspt_item TO hub_app;
GRANT SELECT, INSERT ON continuity_test TO hub_app;
