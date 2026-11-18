-- v36 Compliance › Audits & actions › CQC self-audit (18 Nov 2026).
-- One self-assessment at a time against the CQC key questions. Each statement is answered Pass,
-- Partial, Fail or not applicable; the person who submits it cannot also sign off the review.
CREATE TABLE cqc_self_audit (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  code           text NOT NULL,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SUBMITTED', 'REVIEWED')),
  started_by     uuid NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  submitted_by   uuid,
  submitted_at   timestamptz,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  review_note    text CHECK (review_note IS NULL OR length(review_note) BETWEEN 3 AND 2000),
  version        int NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK ((submitted_by IS NULL) = (submitted_at IS NULL)),
  CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL)),
  CHECK (status = 'OPEN' OR submitted_by IS NOT NULL),
  CHECK (status <> 'REVIEWED' OR reviewed_by IS NOT NULL),
  CHECK (reviewed_by IS NULL OR reviewed_by <> submitted_by)
);
CREATE UNIQUE INDEX cqc_self_audit_one_open ON cqc_self_audit (organisation_id) WHERE status = 'OPEN';
CREATE TRIGGER cqc_self_audit_version BEFORE UPDATE ON cqc_self_audit
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE cqc_self_audit_answer (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  self_audit_id   uuid NOT NULL REFERENCES cqc_self_audit(id),
  question_key    text NOT NULL CHECK (question_key ~ '^[A-Z]{2,12}-[0-9]{1,2}$'),
  answer          text NOT NULL CHECK (answer IN ('PASS', 'PARTIAL', 'FAIL', 'NA')),
  note            text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 1000),
  answered_by     uuid NOT NULL,
  answered_at     timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (self_audit_id, question_key)
);
CREATE TRIGGER cqc_self_audit_answer_version BEFORE UPDATE ON cqc_self_audit_answer
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Answers can only change while the self-audit is open.
CREATE FUNCTION cqc_self_audit_answer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM cqc_self_audit WHERE id = NEW.self_audit_id) <> 'OPEN' THEN
    RAISE EXCEPTION 'the self-audit has been submitted; answers cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cqc_self_audit_answer_open BEFORE INSERT OR UPDATE ON cqc_self_audit_answer
  FOR EACH ROW EXECUTE FUNCTION cqc_self_audit_answer_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cqc_self_audit', 'cqc_self_audit_answer'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON cqc_self_audit, cqc_self_audit_answer TO hub_app;
