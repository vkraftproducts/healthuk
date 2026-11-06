-- Task 13: data protection complaints log and retention approval by a second person. Forward-only.

-- Who last changed a retention rule; the approver must be someone else.
ALTER TABLE retention_rule ADD COLUMN changed_by uuid;

-- Complaints about how personal data is handled (UK GDPR / Data (Use and Access) Act 2025:
-- acknowledge within 30 days, respond without undue delay). The summary must not name people.
CREATE TABLE dp_complaint (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id    uuid NOT NULL REFERENCES organisation(id),
  code               text NOT NULL,
  source             text NOT NULL CHECK (source IN ('DATA_SUBJECT', 'REPRESENTATIVE', 'ICO')),
  summary            text NOT NULL CHECK (length(summary) BETWEEN 3 AND 2000),
  received_on        date NOT NULL,
  acknowledge_due    date NOT NULL,
  acknowledged_on    date,
  subject_request_id uuid REFERENCES subject_request(id),
  breach_id          uuid REFERENCES breach_record(id),
  owner_user_id      uuid NOT NULL,
  status             text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'ACKNOWLEDGED', 'RESOLVED')),
  outcome            text CHECK (outcome IS NULL OR length(outcome) BETWEEN 3 AND 2000),
  resolved_on        date,
  resolved_by        uuid,
  recorded_by        uuid NOT NULL,
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (acknowledged_on IS NULL OR acknowledged_on >= received_on),
  CHECK (status = 'RECEIVED' OR acknowledged_on IS NOT NULL),
  CHECK ((status = 'RESOLVED') = (outcome IS NOT NULL AND resolved_on IS NOT NULL AND resolved_by IS NOT NULL)),
  CHECK (resolved_on IS NULL OR resolved_on >= received_on)
);
CREATE INDEX dp_complaint_idx ON dp_complaint (organisation_id, status, acknowledge_due);
CREATE TRIGGER dp_complaint_version BEFORE UPDATE ON dp_complaint FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE dp_complaint ENABLE ROW LEVEL SECURITY;
ALTER TABLE dp_complaint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dp_complaint
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY privacy_restricted ON dp_complaint AS RESTRICTIVE
  USING (app_has_permission('privacy.manage')) WITH CHECK (app_has_permission('privacy.manage'));

GRANT SELECT, INSERT, UPDATE ON dp_complaint TO hub_app;
