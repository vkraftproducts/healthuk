-- M5: audits, actions, policies, risks, registration, events, premises, exports (COMP/AUD/EVT/HSE).
-- Forward-only. Responses, findings, histories, acknowledgements and candour decisions are immutable.

CREATE TYPE quality_domain AS ENUM ('SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE', 'WELL_LED');
CREATE TYPE audit_run_status AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'ACTIONS_OPEN', 'CLOSED');
CREATE TYPE audit_result AS ENUM ('COMPLIANT', 'PARTIAL', 'NON_COMPLIANT', 'NOT_ASSESSED', 'NOT_APPLICABLE');
CREATE TYPE audit_method AS ENUM ('RECORDS', 'OBSERVATION', 'INTERVIEW');
CREATE TYPE action_status AS ENUM ('OPEN', 'EVIDENCE_SUBMITTED', 'VERIFIED', 'REJECTED');
CREATE TYPE policy_status AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED');
CREATE TYPE event_status AS ENUM ('TRIAGE', 'PROTECT', 'ASSESS', 'INVESTIGATE', 'RESPOND', 'ACTIONS', 'LEARNING_VERIFIED', 'CLOSED');
CREATE TYPE event_severity AS ENUM ('NO_HARM', 'LOW', 'MODERATE', 'SEVERE', 'DEATH');
CREATE TYPE reporting_body AS ENUM ('CQC', 'SAFEGUARDING', 'RIDDOR', 'INSURER', 'COMMISSIONER', 'ICO', 'OTHER');
CREATE TYPE obligation_decision AS ENUM ('PENDING', 'REQUIRED', 'NOT_REQUIRED');
CREATE TYPE premises_area AS ENUM ('FIRE', 'WATER', 'ELECTRICAL_GAS', 'COSHH_INFECTION', 'OXYGEN', 'PEOPLE_WORKPLACE', 'BUILDING_EQUIPMENT');
CREATE TYPE export_status AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- Human-readable sequential codes per organisation (AUD-102, ACT-218, EVT-7, RSK-3).
CREATE TABLE org_counter (
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  prefix          text NOT NULL CHECK (prefix ~ '^[A-Z]{2,5}$'),
  value           int NOT NULL DEFAULT 0,
  PRIMARY KEY (organisation_id, prefix)
);
CREATE FUNCTION next_code(p_org uuid, p_prefix text, p_start int DEFAULT 1) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v int;
BEGIN
  INSERT INTO org_counter (organisation_id, prefix, value) VALUES (p_org, p_prefix, p_start)
  ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = org_counter.value + 1
  RETURNING value INTO v;
  RETURN p_prefix || '-' || v;
END $$;

-- ---------------------------------------------------------------------------
-- Audits (AUD-01/02)
-- ---------------------------------------------------------------------------
CREATE TABLE audit_template (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9\-]{1,19}$'),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  domain          quality_domain NOT NULL,
  source_ref      text CHECK (source_ref IS NULL OR length(source_ref) <= 300),
  -- Seeded starter controls are inactive until management approves them (A8).
  active          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (organisation_id, code)
);
CREATE UNIQUE INDEX audit_template_org_id_key ON audit_template (id, organisation_id);

CREATE TABLE audit_template_version (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  template_id     uuid NOT NULL,
  version         int NOT NULL CHECK (version >= 1),
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  controls        jsonb NOT NULL CHECK (jsonb_typeof(controls) = 'array' AND jsonb_array_length(controls) BETWEEN 1 AND 200),
  sample_method   text CHECK (sample_method IS NULL OR length(sample_method) <= 300),
  sample_size     int CHECK (sample_size IS NULL OR sample_size BETWEEN 1 AND 1000),
  methods         audit_method[] NOT NULL DEFAULT '{RECORDS}',
  approved_by     uuid,
  approved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (template_id, version),
  FOREIGN KEY (template_id, organisation_id) REFERENCES audit_template (id, organisation_id),
  CHECK (status = 'DRAFT' OR approved_by IS NOT NULL),
  CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by)
);
CREATE UNIQUE INDEX audit_template_version_org_id_key ON audit_template_version (id, organisation_id);
CREATE FUNCTION audit_template_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'published audit versions are kept' USING ERRCODE = 'insufficient_privilege'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'published audit versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_template_version_guard_trg BEFORE UPDATE OR DELETE ON audit_template_version
  FOR EACH ROW EXECUTE FUNCTION audit_template_version_guard();

CREATE TABLE audit_run (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL,
  code                text NOT NULL,
  template_version_id uuid NOT NULL,
  location_id         uuid,
  title               text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  period_from         date,
  period_to           date,
  auditor_user_id     uuid NOT NULL,
  owner_user_id       uuid NOT NULL,
  due_date            date NOT NULL,
  status              audit_run_status NOT NULL DEFAULT 'SCHEDULED',
  outcome             rag_status,
  outcome_reason      text,
  submitted_at        timestamptz,
  reaudit_of          uuid,
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (period_to IS NULL OR period_from IS NULL OR period_to >= period_from),
  FOREIGN KEY (template_version_id, organisation_id) REFERENCES audit_template_version (id, organisation_id),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE UNIQUE INDEX audit_run_org_id_key ON audit_run (id, organisation_id);
CREATE INDEX audit_run_status_idx ON audit_run (organisation_id, status, due_date);
CREATE TRIGGER audit_run_version BEFORE UPDATE ON audit_run FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE audit_sample (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL,
  run_id            uuid NOT NULL,
  population_desc   text NOT NULL CHECK (length(population_desc) BETWEEN 3 AND 500),
  selection_method  text NOT NULL CHECK (length(selection_method) BETWEEN 3 AND 300),
  date_from         date NOT NULL,
  date_to           date NOT NULL,
  subject_type      requirement_subject_type NOT NULL,
  subject_ids       uuid[] NOT NULL CHECK (cardinality(subject_ids) BETWEEN 1 AND 500),
  reviewer_user_id  uuid NOT NULL,
  repeat_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from),
  FOREIGN KEY (run_id, organisation_id) REFERENCES audit_run (id, organisation_id)
);
CREATE TRIGGER audit_sample_immutable BEFORE UPDATE OR DELETE ON audit_sample FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE audit_response (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  run_id           uuid NOT NULL,
  control_code     text NOT NULL,
  subject_id       uuid,
  result           audit_result NOT NULL,
  method           audit_method NOT NULL,
  note             text CHECK (note IS NULL OR length(note) <= 2000),
  evidence_item_id uuid,
  recorded_by      uuid NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (result NOT IN ('PARTIAL', 'NON_COMPLIANT', 'NOT_APPLICABLE') OR note IS NOT NULL),
  FOREIGN KEY (run_id, organisation_id) REFERENCES audit_run (id, organisation_id),
  FOREIGN KEY (evidence_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id)
);
CREATE INDEX audit_response_idx ON audit_response (organisation_id, run_id, control_code);
CREATE TRIGGER audit_response_immutable BEFORE UPDATE OR DELETE ON audit_response FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- Responses can only be added while the run is open: after submit the audit is fixed (UI_SPEC 03).
CREATE FUNCTION audit_response_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM audit_run WHERE id = NEW.run_id) NOT IN ('SCHEDULED', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'the audit has been submitted; responses are fixed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_response_open_trg BEFORE INSERT ON audit_response FOR EACH ROW EXECUTE FUNCTION audit_response_open();

CREATE TABLE audit_finding (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  run_id          uuid NOT NULL,
  control_code    text NOT NULL,
  pass_count      int NOT NULL DEFAULT 0,
  partial_count   int NOT NULL DEFAULT 0,
  fail_count      int NOT NULL DEFAULT 0,
  na_count        int NOT NULL DEFAULT 0,
  result          audit_result NOT NULL,
  severity        alert_severity NOT NULL,
  summary         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  FOREIGN KEY (run_id, organisation_id) REFERENCES audit_run (id, organisation_id)
);
CREATE UNIQUE INDEX audit_finding_org_id_key ON audit_finding (id, organisation_id);
CREATE INDEX audit_finding_idx ON audit_finding (organisation_id, run_id);
CREATE TRIGGER audit_finding_immutable BEFORE UPDATE OR DELETE ON audit_finding FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Corrective actions: evidence alone never closes an action (UAT-04).
CREATE TABLE action (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL REFERENCES organisation(id),
  code              text NOT NULL,
  source_type       text NOT NULL CHECK (source_type IN ('FINDING', 'EVENT', 'RISK', 'CORRESPONDENCE')),
  source_id         uuid NOT NULL,
  kind              text NOT NULL DEFAULT 'ACTION' CHECK (kind IN ('ACTION', 'REAUDIT')),
  title             text NOT NULL CHECK (length(title) BETWEEN 3 AND 300),
  severity          alert_severity NOT NULL,
  owner_user_id     uuid NOT NULL,
  deadline          date NOT NULL,
  status            action_status NOT NULL DEFAULT 'OPEN',
  evidence_item_ids uuid[] NOT NULL DEFAULT '{}',
  evidence_by       uuid,
  verifier_user_id  uuid,
  verified_at       timestamptz,
  reaudit_run_id    uuid,
  version           int NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (status <> 'VERIFIED' OR (verifier_user_id IS NOT NULL AND verifier_user_id IS DISTINCT FROM evidence_by)),
  CHECK (status NOT IN ('EVIDENCE_SUBMITTED', 'VERIFIED') OR kind = 'REAUDIT' OR cardinality(evidence_item_ids) > 0)
);
CREATE UNIQUE INDEX action_org_id_key ON action (id, organisation_id);
CREATE INDEX action_status_idx ON action (organisation_id, status, deadline);
CREATE TRIGGER action_version BEFORE UPDATE ON action FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE action_history (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  action_id       uuid NOT NULL,
  from_status     action_status,
  to_status       action_status NOT NULL,
  note            text,
  by_user_id      uuid NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (action_id, organisation_id) REFERENCES action (id, organisation_id)
);
CREATE TRIGGER action_history_immutable BEFORE UPDATE OR DELETE ON action_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Policies (COMP-04)
-- ---------------------------------------------------------------------------
CREATE TABLE policy_document (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9\-]{1,19}$'),
  title           text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  category        text NOT NULL DEFAULT 'POLICY' CHECK (category IN ('POLICY', 'SOP', 'GUIDANCE')),
  owner_user_id   uuid NOT NULL,
  reader_roles    text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (organisation_id, code)
);
CREATE UNIQUE INDEX policy_document_org_id_key ON policy_document (id, organisation_id);

CREATE TABLE policy_version (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  document_id      uuid NOT NULL,
  version          int NOT NULL CHECK (version >= 1),
  status           policy_status NOT NULL DEFAULT 'DRAFT',
  summary          text NOT NULL CHECK (length(summary) BETWEEN 3 AND 2000),
  material         boolean NOT NULL DEFAULT true,
  evidence_item_id uuid,
  effective_from   date,
  review_date      date,
  approved_by      uuid,
  approved_at      timestamptz,
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version),
  FOREIGN KEY (document_id, organisation_id) REFERENCES policy_document (id, organisation_id),
  FOREIGN KEY (evidence_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id),
  CHECK (approved_by IS NULL OR approved_by <> created_by)
);
CREATE UNIQUE INDEX policy_version_org_id_key ON policy_version (id, organisation_id);
CREATE UNIQUE INDEX policy_version_one_published ON policy_version (document_id) WHERE status = 'PUBLISHED';

CREATE TABLE policy_acknowledgement (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  user_id           uuid NOT NULL,
  device            text CHECK (device IS NULL OR length(device) <= 120),
  at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_version_id, user_id),
  FOREIGN KEY (policy_version_id, organisation_id) REFERENCES policy_version (id, organisation_id)
);
CREATE TRIGGER policy_acknowledgement_immutable BEFORE UPDATE OR DELETE ON policy_acknowledgement FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Risk register, registration record, regulatory correspondence (COMP-03)
-- ---------------------------------------------------------------------------
CREATE TABLE risk (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  code                text NOT NULL,
  hazard              text NOT NULL CHECK (length(hazard) BETWEEN 3 AND 500),
  people_affected     text NOT NULL CHECK (length(people_affected) BETWEEN 2 AND 300),
  inherent_likelihood int NOT NULL CHECK (inherent_likelihood BETWEEN 1 AND 5),
  inherent_impact     int NOT NULL CHECK (inherent_impact BETWEEN 1 AND 5),
  controls            text NOT NULL CHECK (length(controls) BETWEEN 3 AND 4000),
  residual_likelihood int NOT NULL CHECK (residual_likelihood BETWEEN 1 AND 5),
  residual_impact     int NOT NULL CHECK (residual_impact BETWEEN 1 AND 5),
  owner_user_id       uuid NOT NULL,
  review_date         date NOT NULL,
  location_id         uuid,
  status              text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  linked_event_ids    uuid[] NOT NULL DEFAULT '{}',
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE TRIGGER risk_version BEFORE UPDATE ON risk FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE registration_record (
  organisation_id               uuid PRIMARY KEY REFERENCES organisation(id),
  provider_ref                  text CHECK (provider_ref IS NULL OR length(provider_ref) <= 40),
  registered_manager_user_id    uuid,
  nominated_individual          text CHECK (nominated_individual IS NULL OR length(nominated_individual) <= 120),
  conditions                    text CHECK (conditions IS NULL OR length(conditions) <= 4000),
  statement_of_purpose_item_id  uuid,
  insurance_item_id             uuid,
  bcp_item_id                   uuid,
  version                       int NOT NULL DEFAULT 1,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  updated_by                    uuid
);
CREATE TRIGGER registration_record_version BEFORE UPDATE ON registration_record FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE regulatory_correspondence (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  regulator        text NOT NULL CHECK (regulator IN ('CQC', 'ICO', 'HSE', 'COMMISSIONER', 'OTHER')),
  subject          text NOT NULL CHECK (length(subject) BETWEEN 3 AND 300),
  received_on      date NOT NULL,
  deadline         date,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESPONDED', 'CLOSED')),
  responded_on     date,
  owner_user_id    uuid NOT NULL,
  evidence_item_id uuid,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (evidence_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id)
);
CREATE TRIGGER regulatory_correspondence_version BEFORE UPDATE ON regulatory_correspondence FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- Events (EVT-01..04)
-- ---------------------------------------------------------------------------
CREATE TABLE event (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  code            text NOT NULL,
  types           text[] NOT NULL CHECK (cardinality(types) >= 1 AND types <@ ARRAY['INCIDENT', 'ACCIDENT', 'NEAR_MISS', 'SAFEGUARDING', 'COMPLAINT', 'COMPLIMENT', 'DEFECT']),
  title           text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description     text NOT NULL CHECK (length(description) BETWEEN 3 AND 4000),
  occurred_at     timestamptz NOT NULL,
  discovered_at   timestamptz NOT NULL,
  location_id     uuid,
  severity        event_severity NOT NULL,
  lead_user_id    uuid NOT NULL,
  status          event_status NOT NULL DEFAULT 'TRIAGE',
  themes          text[] NOT NULL DEFAULT '{}',
  links           jsonb NOT NULL DEFAULT '[]',
  -- Safeguarding events are visible only with events.safeguarding.view (SECURITY_COMPLIANCE §3).
  restricted      boolean GENERATED ALWAYS AS ('SAFEGUARDING' = ANY (types)) STORED,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (discovered_at >= occurred_at),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE UNIQUE INDEX event_org_id_key ON event (id, organisation_id);
CREATE INDEX event_status_idx ON event (organisation_id, status, occurred_at);
CREATE TRIGGER event_version BEFORE UPDATE ON event FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE event_transition (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  event_id        uuid NOT NULL,
  from_status     event_status,
  to_status       event_status NOT NULL,
  note            text NOT NULL,
  by_user_id      uuid NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organisation_id) REFERENCES event (id, organisation_id)
);
CREATE TRIGGER event_transition_immutable BEFORE UPDATE OR DELETE ON event_transition FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE reporting_obligation (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL,
  event_id          uuid NOT NULL,
  body              reporting_body NOT NULL,
  trigger_text      text NOT NULL CHECK (length(trigger_text) BETWEEN 3 AND 500),
  basis             text NOT NULL CHECK (length(basis) BETWEEN 3 AND 500),
  deadline_at       timestamptz,
  decision          obligation_decision NOT NULL DEFAULT 'PENDING',
  decision_reason   text,
  decided_by        uuid,
  submitted_at      timestamptz,
  reference         text CHECK (reference IS NULL OR length(reference) <= 120),
  receipt_item_id   uuid,
  version           int NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, body),
  CHECK (decision = 'PENDING' OR (decided_by IS NOT NULL AND decision_reason IS NOT NULL)),
  CHECK (submitted_at IS NULL OR decision = 'REQUIRED'),
  FOREIGN KEY (event_id, organisation_id) REFERENCES event (id, organisation_id),
  FOREIGN KEY (receipt_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id)
);
CREATE TRIGGER reporting_obligation_version BEFORE UPDATE ON reporting_obligation FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Duty of candour: the system flags, a person decides; decisions are immutable (a later
-- decision is a new row).
CREATE TABLE candour_assessment (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  event_id        uuid NOT NULL,
  notifiable      boolean NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  decided_by      uuid NOT NULL,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organisation_id) REFERENCES event (id, organisation_id)
);
CREATE TRIGGER candour_assessment_immutable BEFORE UPDATE OR DELETE ON candour_assessment FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE complaint_detail (
  event_id               uuid PRIMARY KEY,
  organisation_id        uuid NOT NULL,
  received_on            date NOT NULL,
  channel                text NOT NULL CHECK (channel IN ('PHONE', 'EMAIL', 'LETTER', 'IN_PERSON', 'WEB', 'OTHER')),
  acknowledge_by         date NOT NULL,
  respond_by             date NOT NULL,
  acknowledged_on        date,
  responded_on           date,
  consent_to_share       boolean NOT NULL DEFAULT false,
  preferences            text CHECK (preferences IS NULL OR length(preferences) <= 500),
  outcome                text CHECK (outcome IS NULL OR outcome IN ('UPHELD', 'PARTLY_UPHELD', 'NOT_UPHELD', 'WITHDRAWN')),
  escalation_rights_given boolean NOT NULL DEFAULT false,
  version                int NOT NULL DEFAULT 1,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organisation_id) REFERENCES event (id, organisation_id)
);
CREATE TRIGGER complaint_detail_version BEFORE UPDATE ON complaint_detail FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE safeguarding_case (
  event_id        uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  details         text NOT NULL CHECK (length(details) BETWEEN 3 AND 8000),
  agencies        text CHECK (agencies IS NULL OR length(agencies) <= 1000),
  referral_ref    text CHECK (referral_ref IS NULL OR length(referral_ref) <= 120),
  outcome         text CHECK (outcome IS NULL OR length(outcome) <= 2000),
  version         int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organisation_id) REFERENCES event (id, organisation_id)
);
CREATE TRIGGER safeguarding_case_version BEFORE UPDATE ON safeguarding_case FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- Premises (HSE-01)
-- ---------------------------------------------------------------------------
CREATE TABLE premises_item (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id         uuid NOT NULL REFERENCES organisation(id),
  location_id             uuid NOT NULL,
  control_area            premises_area NOT NULL,
  title                   text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  responsible_user_id     uuid NOT NULL,
  -- Intervals come from a named source (competent person, manufacturer, law), never a default.
  frequency_source        text NOT NULL CHECK (length(frequency_source) BETWEEN 3 AND 300),
  requirement_instance_id uuid,
  applicable              boolean NOT NULL DEFAULT true,
  applicability_reason    text,
  decided_by              uuid,
  version                 int NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (applicable OR (applicability_reason IS NOT NULL AND decided_by IS NOT NULL)),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id),
  FOREIGN KEY (requirement_instance_id, organisation_id) REFERENCES requirement_instance (id, organisation_id)
);
CREATE INDEX premises_item_idx ON premises_item (organisation_id, location_id, control_area);
CREATE TRIGGER premises_item_version BEFORE UPDATE ON premises_item FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- Exports (evidence packs, CSVs) produced by the worker and fetched via short-lived links.
-- ---------------------------------------------------------------------------
CREATE TABLE export_job (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  kind            text NOT NULL CHECK (kind IN ('EVIDENCE_PACK', 'MANAGEMENT_PACK', 'FULL_EXPORT', 'SAR')),
  params          jsonb NOT NULL DEFAULT '{}',
  status          export_status NOT NULL DEFAULT 'QUEUED',
  blob_key        text,
  bytes           bigint,
  error           text,
  requested_by    uuid NOT NULL,
  -- Permissions of the requester at request time: the worker never widens access.
  requester_permissions text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX export_job_idx ON export_job (organisation_id, status, created_at);

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_counter', 'audit_template', 'audit_template_version', 'audit_run', 'audit_sample',
    'audit_response', 'audit_finding', 'action', 'action_history', 'policy_document', 'policy_version',
    'policy_acknowledgement', 'risk', 'registration_record', 'regulatory_correspondence', 'event',
    'event_transition', 'reporting_obligation', 'candour_assessment', 'complaint_detail', 'safeguarding_case',
    'premises_item', 'export_job']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
CREATE POLICY safeguarding_restricted ON event AS RESTRICTIVE
  USING (NOT restricted OR app_has_permission('events.safeguarding.view') OR lead_user_id = app_user_id())
  WITH CHECK (true);
CREATE POLICY safeguarding_case_restricted ON safeguarding_case AS RESTRICTIVE
  USING (app_has_permission('events.safeguarding.view'))
  WITH CHECK (app_has_permission('events.safeguarding.view') OR app_has_permission('events.event.manage'));

GRANT SELECT, INSERT, UPDATE ON org_counter TO hub_app;
GRANT EXECUTE ON FUNCTION next_code(uuid, text, int) TO hub_app;
GRANT SELECT, INSERT, UPDATE ON audit_template, audit_run, action, policy_document, policy_version, risk,
  registration_record, regulatory_correspondence, event, reporting_obligation, complaint_detail,
  safeguarding_case, premises_item, export_job TO hub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_template_version TO hub_app;  -- drafts only (trigger)
GRANT SELECT, INSERT ON audit_sample, audit_response, audit_finding, action_history, policy_acknowledgement,
  event_transition, candour_assessment TO hub_app;  -- immutable
