-- v36 front end ↔ real tables, governance area (step 2, 18 Nov 2026).
-- Columns for what v36's incident, audit, action and policy screens record and the tables had no
-- place for, plus the audit programme (S.prog) and policy acknowledgements by staff without a
-- login (S.pol[].ack is keyed by staff number). Prisma-modelled NOT NULL columns stay NOT NULL.

-- ---- incidents (S.inc) ------------------------------------------------------------------------
ALTER TABLE event
  ADD COLUMN terms_of_reference   text CHECK (terms_of_reference IS NULL OR length(terms_of_reference) <= 4000),
  ADD COLUMN investigation_due_on date,
  ADD COLUMN root_cause           text CHECK (root_cause IS NULL OR length(root_cause) <= 4000),
  -- Root-cause method: {m:'whys'|'fish', whys:[...], fish:{People:..}} exactly as v36 records it.
  ADD COLUMN rca                  jsonb CHECK (rca IS NULL OR jsonb_typeof(rca) = 'object'),
  ADD COLUMN share_learning       boolean,
  ADD COLUMN learning_on          date,
  ADD COLUMN reporter_feedback    text CHECK (reporter_feedback IS NULL OR length(reporter_feedback) <= 2000),
  -- Duty of candour step due dates, keyed by v36's step text (done steps are event_candour_step).
  ADD COLUMN candour_due          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(candour_due) = 'object'),
  -- Remaining v36 notes with no business meaning of their own (PSIRF choice text, RIDDOR note).
  ADD COLUMN v36_extra            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(v36_extra) = 'object');

-- CQC notifications: v36 lets the Registered Manager or Director record the portal submission
-- directly. Who recorded it is kept; the review step stays for notifications that use it.
ALTER TABLE cqc_notification ADD COLUMN submitted_by uuid REFERENCES app_user(id);
ALTER TABLE cqc_notification DROP CONSTRAINT cqc_notification_check1;
ALTER TABLE cqc_notification ADD CONSTRAINT cqc_notification_check1
  CHECK (status IN ('DRAFT', 'NOT_REQUIRED') OR reviewed_by IS NOT NULL OR submitted_by IS NOT NULL);

-- ---- audits (S.aud) -----------------------------------------------------------------------------
ALTER TABLE audit_run
  ADD COLUMN method_note  text CHECK (method_note IS NULL OR length(method_note) <= 500),
  ADD COLUMN submitted_by uuid REFERENCES app_user(id);

-- ---- actions (S.act) ----------------------------------------------------------------------------
-- v36 raises actions from audits (whole run), from a free source ('Governance meeting', 'Risk
-- register' …) and records the evidence file name with a note. MANUAL actions point at the
-- organisation itself (source_id stays NOT NULL).
ALTER TABLE action DROP CONSTRAINT action_source_type_check;
ALTER TABLE action ADD CONSTRAINT action_source_type_check CHECK (source_type IN
  ('CONTINUITY', 'PREMISES', 'FINDING', 'EVENT', 'RISK', 'CORRESPONDENCE', 'FEEDBACK', 'MEETING',
   'AUDIT', 'MANUAL', 'SELF_AUDIT'));
ALTER TABLE action
  ADD COLUMN source_label    text CHECK (source_label IS NULL OR length(source_label) <= 200),
  ADD COLUMN next_step       text CHECK (next_step IS NULL OR length(next_step) <= 500),
  ADD COLUMN evidence_file   text CHECK (evidence_file IS NULL OR length(evidence_file) BETWEEN 1 AND 255),
  ADD COLUMN evidence_note   text CHECK (evidence_note IS NULL OR length(evidence_note) <= 2000),
  ADD COLUMN evidence_at     timestamptz,
  ADD COLUMN rejected_reason text CHECK (rejected_reason IS NULL OR length(rejected_reason) <= 2000);
ALTER TABLE action DROP CONSTRAINT action_check1;
ALTER TABLE action ADD CONSTRAINT action_check1 CHECK (
  status NOT IN ('EVIDENCE_SUBMITTED', 'VERIFIED') OR kind = 'REAUDIT'
  OR cardinality(evidence_item_ids) > 0 OR evidence_file IS NOT NULL);

-- ---- policies (S.pol) ---------------------------------------------------------------------------
-- v36's own reference (POL-01) next to the document code (SG-01).
ALTER TABLE policy_document ADD COLUMN ref text CHECK (ref IS NULL OR length(ref) BETWEEN 2 AND 20);
CREATE UNIQUE INDEX policy_document_org_ref_uidx ON policy_document (organisation_id, ref)
  WHERE ref IS NOT NULL;
-- v36 allows a version with no summary text.
ALTER TABLE policy_version DROP CONSTRAINT policy_version_summary_check;
ALTER TABLE policy_version ADD CONSTRAINT policy_version_summary_check CHECK (length(summary) <= 2000);

-- Acknowledgements recorded for staff who have no login (moved in from the saved v36 copy).
CREATE TABLE policy_staff_ack (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL REFERENCES organisation(id),
  policy_version_id uuid NOT NULL REFERENCES policy_version(id),
  staff_id          uuid NOT NULL REFERENCES staff(id),
  acknowledged_on   date NOT NULL,
  recorded_by       uuid NOT NULL REFERENCES app_user(id),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_version_id, staff_id)
);
CREATE TRIGGER policy_staff_ack_immutable BEFORE UPDATE OR DELETE ON policy_staff_ack
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE policy_staff_ack ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_staff_ack FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON policy_staff_ack
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON policy_staff_ack TO hub_app;

-- ---- audit programme (S.prog): planned months per template ------------------------------------
CREATE TABLE audit_plan_month (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  template_id     uuid NOT NULL REFERENCES audit_template(id),
  month           text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  position        int NOT NULL DEFAULT 0,
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, month)
);
CREATE INDEX audit_plan_month_org_idx ON audit_plan_month (organisation_id, position, month);
CREATE TRIGGER audit_plan_month_version BEFORE UPDATE ON audit_plan_month
  FOR EACH ROW EXECUTE FUNCTION bump_version();
ALTER TABLE audit_plan_month ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_plan_month FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_plan_month
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_plan_month TO hub_app;
