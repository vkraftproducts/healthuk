-- Workflow pass H1-H5 (6 Nov 2026): incident reporting by any staff member, triage, duty of
-- candour steps, PSIRF learning response, harassment reports restricted to HR and the registered
-- manager, sector event types (IR(ME)R, DoLS), LFPSE as a reporting body, and risk register
-- category, links, review history and closing reason. Forward-only.

ALTER TYPE reporting_body ADD VALUE IF NOT EXISTS 'LFPSE';

ALTER TABLE event DROP CONSTRAINT IF EXISTS event_types_check;
ALTER TABLE event ADD CONSTRAINT event_types_check CHECK (
  cardinality(types) >= 1 AND types <@ ARRAY['INCIDENT', 'ACCIDENT', 'NEAR_MISS', 'SAFEGUARDING',
    'COMPLAINT', 'COMPLIMENT', 'DEFECT', 'HARASSMENT', 'IRMER', 'DOLS']
);

-- People are referenced by job or booking reference only (people_refs), never by name.
ALTER TABLE event
  ADD COLUMN reported_by          uuid,
  ADD COLUMN place                text CHECK (place IS NULL OR length(place) <= 200),
  ADD COLUMN people_refs          text[] NOT NULL DEFAULT '{}',
  ADD COLUMN immediate_actions    text CHECK (immediate_actions IS NULL OR length(immediate_actions) <= 2000),
  ADD COLUMN still_at_risk        boolean NOT NULL DEFAULT false,
  ADD COLUMN nhs_funded           boolean NOT NULL DEFAULT false,
  ADD COLUMN category             text CHECK (category IS NULL OR category IN ('PATIENT_CARE',
    'MEDICATION', 'MOVING_AND_HANDLING', 'VEHICLE_COLLISION', 'EQUIPMENT', 'STAFF_INJURY',
    'VIOLENCE_AGGRESSION', 'DATA_BREACH', 'INFECTION', 'SAFEGUARDING', 'HARASSMENT', 'RADIATION',
    'DOLS', 'OTHER')),
  ADD COLUMN priority             text CHECK (priority IS NULL OR priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  ADD COLUMN protection_steps     text CHECK (protection_steps IS NULL OR length(protection_steps) <= 2000),
  ADD COLUMN triage_due_at        timestamptz,
  ADD COLUMN triaged_at           timestamptz,
  ADD COLUMN triaged_by           uuid,
  ADD COLUMN learning_response    text CHECK (learning_response IS NULL OR learning_response IN (
    'AFTER_ACTION_REVIEW', 'SWARM_HUDDLE', 'MDT_REVIEW', 'THEMATIC_REVIEW', 'PSII', 'NO_FURTHER_RESPONSE')),
  ADD COLUMN learning_notes       text CHECK (learning_notes IS NULL OR length(learning_notes) <= 4000),
  ADD COLUMN contributory_factors text CHECK (contributory_factors IS NULL OR length(contributory_factors) <= 4000),
  ADD COLUMN hr_restricted        boolean GENERATED ALWAYS AS ('HARASSMENT' = ANY (types)) STORED;
ALTER TABLE event ADD CONSTRAINT event_triage_complete CHECK (
  triaged_at IS NULL OR (triaged_by IS NOT NULL AND priority IS NOT NULL AND category IS NOT NULL)
);
ALTER TABLE event ADD CONSTRAINT event_people_refs_size CHECK (cardinality(people_refs) <= 20);
CREATE INDEX event_reported_by_idx ON event (organisation_id, reported_by, created_at DESC);
CREATE INDEX event_triage_due_idx ON event (organisation_id, triage_due_at) WHERE triaged_at IS NULL;

-- The person who reported a restricted event can still see their own report.
DROP POLICY safeguarding_restricted ON event;
CREATE POLICY safeguarding_restricted ON event AS RESTRICTIVE
  USING (NOT restricted OR app_has_permission('events.safeguarding.view')
         OR lead_user_id = app_user_id() OR reported_by = app_user_id())
  WITH CHECK (true);
-- Harassment reports: HR and the registered manager only (harassment.manage), plus the lead and
-- the reporter. Dispatchers, crew and other leads never see them (WORKFLOWS H5).
CREATE POLICY harassment_restricted ON event AS RESTRICTIVE
  USING (NOT hr_restricted OR app_has_permission('harassment.manage')
         OR lead_user_id = app_user_id() OR reported_by = app_user_id())
  WITH CHECK (true);

-- Duty of candour steps (regulation 20), recorded one by one. Append-only.
CREATE TABLE event_candour_step (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  event_id        uuid NOT NULL,
  step            text NOT NULL CHECK (step IN ('TOLD_IN_PERSON', 'APOLOGY', 'WRITTEN_NOTICE',
                    'SUPPORT_OFFERED', 'FINDINGS_SHARED')),
  done_on         date NOT NULL,
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  recorded_by     uuid NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organisation_id) REFERENCES event (id, organisation_id)
);
CREATE INDEX event_candour_step_idx ON event_candour_step (organisation_id, event_id, recorded_at);
CREATE TRIGGER event_candour_step_immutable BEFORE UPDATE OR DELETE ON event_candour_step
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Risk register (H4).
ALTER TABLE risk
  ADD COLUMN title                text CHECK (title IS NULL OR length(title) BETWEEN 3 AND 200),
  ADD COLUMN category             text CHECK (category IS NULL OR category IN ('CLINICAL',
    'OPERATIONAL', 'WORKFORCE', 'FLEET', 'PREMISES', 'INFORMATION', 'FINANCIAL', 'REGULATORY',
    'HARASSMENT', 'OTHER')),
  ADD COLUMN linked_audit_run_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN closed_reason        text CHECK (closed_reason IS NULL OR length(closed_reason) BETWEEN 3 AND 1000),
  ADD COLUMN closed_at            timestamptz,
  ADD COLUMN closed_by            uuid;
ALTER TABLE risk DROP CONSTRAINT IF EXISTS risk_status_check;
ALTER TABLE risk ADD CONSTRAINT risk_status_check CHECK (status IN ('OPEN', 'CLOSED', 'ARCHIVED'));

-- Every review of a risk is kept as a snapshot. Append-only.
CREATE TABLE risk_review (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  risk_id             uuid NOT NULL REFERENCES risk(id),
  residual_likelihood int NOT NULL CHECK (residual_likelihood BETWEEN 1 AND 5),
  residual_impact     int NOT NULL CHECK (residual_impact BETWEEN 1 AND 5),
  controls            text NOT NULL,
  note                text CHECK (note IS NULL OR length(note) <= 1000),
  next_review_on      date NOT NULL,
  reviewed_by         uuid NOT NULL,
  reviewed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_review_idx ON risk_review (organisation_id, risk_id, reviewed_at DESC);
CREATE TRIGGER risk_review_immutable BEFORE UPDATE OR DELETE ON risk_review
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_candour_step', 'risk_review']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON event_candour_step, risk_review TO hub_app;
