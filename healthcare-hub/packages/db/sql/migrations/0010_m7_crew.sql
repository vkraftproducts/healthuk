-- M7: crew app support (APP-01, APP-02). Forward-only.
-- Offline submissions are idempotent on clientSubmissionId; devices and push carry no patient data.

-- Defects and expenses raised offline: one record per client submission (UAT-06).
ALTER TABLE defect ADD COLUMN client_submission_id uuid;
ALTER TABLE defect ADD COLUMN photo_evidence_item_ids uuid[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(photo_evidence_item_ids) <= 6);
CREATE UNIQUE INDEX defect_client_submission_key ON defect (organisation_id, client_submission_id)
  WHERE client_submission_id IS NOT NULL;
ALTER TABLE fuel_expense ADD COLUMN client_submission_id uuid;
CREATE UNIQUE INDEX fuel_expense_client_submission_key ON fuel_expense (organisation_id, client_submission_id)
  WHERE client_submission_id IS NOT NULL;

-- Crew see the patient contact for a job only while actively crewing the shift it is allocated
-- to, from one hour before the shift until it ends ("disappear after shift window").
CREATE FUNCTION app_crew_on_job(p_job uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM job_allocation a
      JOIN shift s ON s.id = a.shift_id
      JOIN crew_assignment c ON c.shift_id = s.id AND c.active
      JOIN staff st ON st.id = c.staff_id
     WHERE a.job_id = p_job
       AND a.active
       AND st.user_id = app_user_id()
       AND app_has_permission('crew.today.view')
       AND s.state IN ('PLANNED', 'STARTED')
       AND now() BETWEEN s.starts_at - interval '1 hour' AND s.ends_at
  )
$$;
GRANT EXECUTE ON FUNCTION app_crew_on_job(uuid) TO hub_app;
DROP POLICY patient_restricted ON patient_contact;
CREATE POLICY patient_restricted ON patient_contact AS RESTRICTIVE
  USING (app_has_permission('jobs.patient.view') OR app_crew_on_job(job_id))
  WITH CHECK (app_has_permission('jobs.patient.view') OR app_has_permission('jobs.booking.manage'));

-- Push registration reuses device_session (M0): one row per user and device, revoked never deleted.
ALTER TABLE device_session ADD COLUMN app_version text CHECK (app_version IS NULL OR length(app_version) <= 40);
ALTER TABLE device_session ADD CONSTRAINT device_session_push_token_len
  CHECK (push_token IS NULL OR length(push_token) BETWEEN 10 AND 300);

-- Generic push messages (type + opaque id only), sent by the worker.
CREATE TABLE push_message (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  user_id         uuid NOT NULL REFERENCES app_user(id),
  kind            text NOT NULL CHECK (kind IN ('JOB_OFFERED', 'JOB_CHANGED', 'POLICY_ACK', 'SHIFT_CHANGED')),
  ref_id          uuid NOT NULL,
  dedupe_key      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  dead            boolean NOT NULL DEFAULT false,
  last_error      text
);
CREATE UNIQUE INDEX push_message_dedupe ON push_message (organisation_id, dedupe_key);
CREATE INDEX push_message_due ON push_message (organisation_id, next_attempt_at) WHERE sent_at IS NULL AND NOT dead;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['push_message'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON push_message TO hub_app;

-- Critical instructions: policies that crew must explicitly confirm they have read and understood.
ALTER TABLE policy_document DROP CONSTRAINT policy_document_category_check;
ALTER TABLE policy_document ADD CONSTRAINT policy_document_category_check
  CHECK (category IN ('POLICY', 'SOP', 'GUIDANCE', 'CRITICAL_INSTRUCTION'));
