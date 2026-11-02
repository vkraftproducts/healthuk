-- M8: retention rules, legal holds, subject requests, disclosures and breach records
-- (SECURITY_COMPLIANCE §4, UK GDPR). Forward-only.

CREATE TABLE retention_rule (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  category        text NOT NULL CHECK (category IN ('PATIENT_CONTACT', 'JOB_RECORDS', 'STAFF_HR_RECORDS', 'DBS_RECORDS',
                    'EVENT_RECORDS', 'COMPLAINTS', 'SAFEGUARDING', 'AUDIT_RECORDS', 'AUDIT_LOG')),
  retain_months   int NOT NULL CHECK (retain_months BETWEEN 1 AND 1200),
  trigger_desc    text NOT NULL CHECK (length(trigger_desc) BETWEEN 3 AND 200),
  basis           text NOT NULL CHECK (length(basis) BETWEEN 3 AND 500),
  -- Only patient contact details can be anonymised automatically; everything else is listed for review.
  action          text NOT NULL CHECK (action IN ('REVIEW', 'ANONYMISE')),
  status          text NOT NULL DEFAULT 'REQUIRES_APPROVAL' CHECK (status IN ('REQUIRES_APPROVAL', 'APPROVED')),
  approved_by     uuid,
  approved_at     timestamptz,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, category),
  CHECK (action = 'REVIEW' OR category = 'PATIENT_CONTACT'),
  CHECK (status = 'REQUIRES_APPROVAL' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE TRIGGER retention_rule_version BEFORE UPDATE ON retention_rule FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE legal_hold (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  scope_type      text NOT NULL CHECK (scope_type IN ('ORGANISATION', 'STAFF', 'JOB', 'EVENT', 'VEHICLE')),
  scope_id        uuid,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  placed_by       uuid NOT NULL,
  placed_at       timestamptz NOT NULL DEFAULT now(),
  released_by     uuid,
  released_at     timestamptz,
  release_reason  text CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 10 AND 500),
  version         int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'ORGANISATION') = (scope_id IS NULL)),
  CHECK ((released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX legal_hold_active_idx ON legal_hold (organisation_id, scope_type, scope_id) WHERE released_at IS NULL;
CREATE TRIGGER legal_hold_version BEFORE UPDATE ON legal_hold FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Every retention action, appended by the worker; never changed (deletion is logged).
CREATE TABLE retention_log (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  rule_id         uuid NOT NULL REFERENCES retention_rule(id),
  category        text NOT NULL,
  action          text NOT NULL,
  cutoff          date NOT NULL,
  candidates      int NOT NULL,
  affected        int NOT NULL,
  held            int NOT NULL,
  run_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retention_log_idx ON retention_log (organisation_id, run_at DESC);
CREATE TRIGGER retention_log_immutable BEFORE UPDATE OR DELETE ON retention_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE subject_request (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  code            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'OBJECTION')),
  subject_type    text NOT NULL CHECK (subject_type IN ('STAFF', 'PATIENT', 'OTHER')),
  staff_id        uuid,
  patient_ref     text CHECK (patient_ref IS NULL OR patient_ref ~ '^[A-Za-z0-9\-]{2,30}$'),
  description     text NOT NULL CHECK (length(description) BETWEEN 3 AND 1000),
  received_on     date NOT NULL,
  due_on          date NOT NULL,
  extended_to     date,
  status          text NOT NULL DEFAULT 'RECEIVED'
                  CHECK (status IN ('RECEIVED', 'IDENTITY_VERIFIED', 'IN_PROGRESS', 'COMPLETED', 'REFUSED')),
  outcome         text CHECK (outcome IS NULL OR length(outcome) <= 2000),
  export_job_id   uuid,
  handled_by      uuid NOT NULL,
  completed_at    timestamptz,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (subject_type <> 'STAFF' OR staff_id IS NOT NULL),
  CHECK (subject_type <> 'PATIENT' OR patient_ref IS NOT NULL),
  CHECK (extended_to IS NULL OR extended_to > due_on),
  CHECK (status NOT IN ('COMPLETED', 'REFUSED') OR (outcome IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX subject_request_idx ON subject_request (organisation_id, status, due_on);
CREATE TRIGGER subject_request_version BEFORE UPDATE ON subject_request FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE disclosure (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  subject_request_id uuid REFERENCES subject_request(id),
  disclosed_to    text NOT NULL CHECK (length(disclosed_to) BETWEEN 2 AND 200),
  purpose         text NOT NULL CHECK (length(purpose) BETWEEN 3 AND 500),
  lawful_basis    text NOT NULL CHECK (length(lawful_basis) BETWEEN 3 AND 300),
  data_description text NOT NULL CHECK (length(data_description) BETWEEN 3 AND 1000),
  disclosed_on    date NOT NULL,
  recorded_by     uuid NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disclosure_idx ON disclosure (organisation_id, disclosed_on DESC);
CREATE TRIGGER disclosure_immutable BEFORE UPDATE OR DELETE ON disclosure FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Personal data breach record; the ICO must be told within 72 hours of discovery when reportable.
CREATE TABLE breach_record (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  code            text NOT NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description     text NOT NULL CHECK (length(description) BETWEEN 3 AND 4000),
  discovered_at   timestamptz NOT NULL,
  occurred_at     timestamptz,
  data_categories text[] NOT NULL DEFAULT '{}',
  subjects_estimate int CHECK (subjects_estimate IS NULL OR subjects_estimate >= 0),
  containment     text CHECK (containment IS NULL OR length(containment) <= 2000),
  risk            text CHECK (risk IN ('UNLIKELY', 'RISK', 'HIGH_RISK')),
  ico_reportable  boolean,
  decision_reason text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 2000),
  decided_by      uuid,
  decided_at      timestamptz,
  ico_reported_at timestamptz,
  ico_reference   text CHECK (ico_reference IS NULL OR length(ico_reference) <= 60),
  late_reason     text CHECK (late_reason IS NULL OR length(late_reason) BETWEEN 10 AND 2000),
  subjects_notified_at timestamptz,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ASSESSED', 'REPORTED', 'CLOSED')),
  recorded_by     uuid NOT NULL,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (occurred_at IS NULL OR occurred_at <= discovered_at),
  -- The reportability decision is recorded with its reasons (and who decided).
  CHECK ((ico_reportable IS NULL) = (decided_by IS NULL) AND (ico_reportable IS NULL OR (risk IS NOT NULL AND decision_reason IS NOT NULL))),
  -- High risk to people means telling the ICO (UK GDPR Art 33/34).
  CHECK (risk IS DISTINCT FROM 'HIGH_RISK' OR ico_reportable IS NOT FALSE),
  CHECK (ico_reported_at IS NULL OR ico_reportable),
  -- Reported after the 72 hours: the reasons for the delay are required.
  CHECK (ico_reported_at IS NULL OR ico_reported_at <= discovered_at + interval '72 hours' OR late_reason IS NOT NULL),
  CHECK (status <> 'REPORTED' OR ico_reported_at IS NOT NULL),
  CHECK (status <> 'CLOSED' OR (ico_reportable IS NOT NULL AND (NOT ico_reportable OR ico_reported_at IS NOT NULL)))
);
CREATE INDEX breach_record_idx ON breach_record (organisation_id, status, discovered_at DESC);
CREATE TRIGGER breach_record_version BEFORE UPDATE ON breach_record FOR EACH ROW EXECUTE FUNCTION bump_version();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retention_rule', 'legal_hold', 'retention_log', 'subject_request', 'disclosure', 'breach_record'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
  -- Subject requests, disclosures and breaches name people: privacy permission only.
  FOREACH t IN ARRAY ARRAY['subject_request', 'disclosure', 'breach_record', 'legal_hold'] LOOP
    EXECUTE format('CREATE POLICY privacy_restricted ON %I AS RESTRICTIVE USING (app_has_permission(''privacy.manage'')) WITH CHECK (app_has_permission(''privacy.manage''))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON retention_rule, legal_hold, subject_request, breach_record TO hub_app;
GRANT SELECT, INSERT ON retention_log, disclosure TO hub_app;

-- Retention anonymises patient contact details (the only automatic action). patient_contact is
-- insert-only for the app role, so this narrowly scoped function does the update: it only blanks
-- name and phone, only for the caller's organisation, only for journeys before the cutoff, and
-- never for a job or organisation under legal hold.
CREATE FUNCTION retention_anonymise_patient_contacts(p_cutoff date) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  IF app_org_id() IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF EXISTS (SELECT 1 FROM legal_hold h WHERE h.organisation_id = app_org_id()
               AND h.released_at IS NULL AND h.scope_type = 'ORGANISATION') THEN
    RETURN 0;
  END IF;
  UPDATE patient_contact pc SET name = '[removed under retention]', phone = NULL
    FROM job j
   WHERE j.id = pc.job_id AND j.organisation_id = app_org_id() AND pc.organisation_id = app_org_id()
     AND j.journey_date < p_cutoff
     AND pc.name <> '[removed under retention]'
     AND NOT EXISTS (SELECT 1 FROM legal_hold h WHERE h.organisation_id = app_org_id()
                      AND h.released_at IS NULL AND h.scope_type = 'JOB' AND h.scope_id = j.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION retention_anonymise_patient_contacts(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retention_anonymise_patient_contacts(date) TO hub_app;

-- Privacy work is never for roles derived from dispatcher or crew (kept identical to @hub/contracts).
CREATE OR REPLACE FUNCTION restricted_for_dispatch_and_crew() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'staff.sensitive.view','staff.approve_role','staff.profile.manage','staff.lifecycle.transition',
    'events.safeguarding.view','admin.users.manage','admin.roles.manage','admin.export.full',
    'privacy.manage','allocation.exception.approve','admin.audit.view','admin.audit.verify'
  ]
$$;
