-- Workflows K1-K5 and H6 (6 Nov 2026). Forward-only.

-- K1: containment time, the guided assessment answers, people affected, lessons on closing.
ALTER TABLE breach_record
  ADD COLUMN contained_at     timestamptz,
  ADD COLUMN assessment       jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN people_affected  int CHECK (people_affected IS NULL OR people_affected >= 0),
  ADD COLUMN lessons          text CHECK (lessons IS NULL OR length(lessons) BETWEEN 3 AND 2000),
  ADD COLUMN closed_by        uuid,
  ADD COLUMN closed_at        timestamptz,
  ADD CONSTRAINT breach_contained_after_discovery
    CHECK (contained_at IS NULL OR contained_at >= coalesce(occurred_at, discovered_at - interval '3650 days'));

-- K2: the one-month clock pauses while identity is awaited; an exemption is named on refusal.
ALTER TABLE subject_request
  ADD COLUMN identity_requested_on date,
  ADD COLUMN identity_verified_on  date,
  ADD COLUMN paused_days           int NOT NULL DEFAULT 0 CHECK (paused_days BETWEEN 0 AND 366),
  ADD COLUMN exemption             text CHECK (exemption IS NULL OR length(exemption) BETWEEN 3 AND 500),
  ADD CONSTRAINT subject_request_identity_order
    CHECK (identity_verified_on IS NULL OR identity_requested_on IS NULL OR identity_verified_on >= identity_requested_on);

-- K3: drafted acknowledgement and the ICO case reference when the ICO is involved.
ALTER TABLE dp_complaint
  ADD COLUMN draft_acknowledgement text CHECK (draft_acknowledgement IS NULL OR length(draft_acknowledgement) <= 4000),
  ADD COLUMN ico_case_ref          text CHECK (ico_case_ref IS NULL OR ico_case_ref ~ '^[A-Za-z0-9/-]{3,40}$');

-- K4: a hold over organisation records in a date range (scope ORGANISATION with a range). Holding
-- more than needed is the safe side: the retention job treats any organisation hold as blocking.
ALTER TABLE legal_hold
  ADD COLUMN range_from date,
  ADD COLUMN range_to   date,
  ADD CONSTRAINT legal_hold_range
    CHECK ((range_from IS NULL) = (range_to IS NULL)
           AND (range_from IS NULL OR (scope_type = 'ORGANISATION' AND range_to >= range_from)));

-- K4: monthly retention review batches, and the decision on each record (keep with a reason, or act).
CREATE TABLE retention_review (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  rule_id         uuid NOT NULL REFERENCES retention_rule(id),
  period          text NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  cutoff          date NOT NULL,
  candidates      int NOT NULL CHECK (candidates >= 0),
  held            int NOT NULL CHECK (held >= 0),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_by       uuid,
  closed_at       timestamptz,
  version         int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, rule_id, period),
  CHECK ((status = 'CLOSED') = (closed_by IS NOT NULL AND closed_at IS NOT NULL))
);
CREATE TRIGGER retention_review_version BEFORE UPDATE ON retention_review
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE retention_decision (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  review_id       uuid NOT NULL REFERENCES retention_review(id),
  record_type     text NOT NULL CHECK (record_type ~ '^[A-Z_]{2,40}$'),
  record_id       uuid NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('KEEP', 'ACT')),
  reason          text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500),
  keep_until      date,
  decided_by      uuid NOT NULL,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, review_id, record_type, record_id),
  CHECK (decision <> 'KEEP' OR (reason IS NOT NULL AND keep_until IS NOT NULL))
);
CREATE INDEX retention_decision_idx ON retention_decision (organisation_id, review_id);
CREATE TRIGGER retention_decision_immutable
  BEFORE UPDATE OR DELETE ON retention_decision FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- K5: who asked, who approved, and how it was sent.
ALTER TABLE disclosure
  ADD COLUMN subject_description text CHECK (subject_description IS NULL OR length(subject_description) BETWEEN 2 AND 200),
  ADD COLUMN requested_by        text CHECK (requested_by IS NULL OR length(requested_by) BETWEEN 2 AND 200),
  ADD COLUMN approved_by         uuid,
  ADD COLUMN method              text CHECK (method IS NULL OR method IN ('SECURE_EMAIL', 'SECURE_PORTAL', 'POST', 'BY_HAND', 'PHONE', 'OTHER'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_review', 'retention_decision'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
    EXECUTE format('CREATE POLICY privacy_restricted ON %I AS RESTRICTIVE USING (app_has_permission(''privacy.manage'')) WITH CHECK (app_has_permission(''privacy.manage''))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON retention_review TO hub_app;
GRANT SELECT, INSERT ON retention_decision TO hub_app;

-- H6: progress an anonymous raiser can check with their code. Holds no identity and no summary:
-- only the code hash, the stage and feedback written for the raiser.
CREATE TABLE speak_up_progress (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  concern_id       uuid NOT NULL UNIQUE REFERENCES speak_up_concern(id),
  code_hash        text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  status           text NOT NULL CHECK (status IN ('RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'CLOSED')),
  feedback         text CHECK (feedback IS NULL OR length(feedback) BETWEEN 3 AND 2000),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code_hash)
);
ALTER TABLE speak_up_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE speak_up_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON speak_up_progress
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
-- Anyone in the organisation can look a code up; only handlers change the stage or feedback.
CREATE POLICY speak_up_progress_update ON speak_up_progress AS RESTRICTIVE FOR UPDATE
  USING (app_has_permission('speakup.manage')) WITH CHECK (app_has_permission('speakup.manage'));
GRANT SELECT, INSERT, UPDATE ON speak_up_progress TO hub_app;
