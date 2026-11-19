-- v36 people file connected to the real tables (step 2, 19 Nov 2026). What v36 keeps about a person
-- and their checks that had no column yet:
--  * the line manager (a member of the organisation, or a name when they are not one);
--  * the 48-hour working-week opt-out (S.optOut);
--  * a v36 reference for restrictions (R-14) kept when the saved copy is moved in;
--  * per check: the follow-up date and every chase date of a document request;
--  * per received document: its file name, who supplied it when that was not a member (e.g. the
--    occupational health provider) and the note made when it was received;
--  * comments on a check;
--  * the COR- reference of a correction request.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS line_manager_user_id uuid REFERENCES app_user(id);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS line_manager_name text
  CHECK (line_manager_name IS NULL OR length(line_manager_name) BETWEEN 1 AND 120);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS wtd_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS wtd_opt_out_on date;

ALTER TABLE staff_restriction ADD COLUMN IF NOT EXISTS code text
  CHECK (code IS NULL OR length(code) BETWEEN 1 AND 40);

ALTER TABLE staff_chase_log ADD COLUMN IF NOT EXISTS check_code text
  CHECK (check_code IS NULL OR check_code ~ '^[A-Z0-9]{1,12}$');
ALTER TABLE staff_chase_log ADD COLUMN IF NOT EXISTS due_on date;
ALTER TABLE staff_chase_log ADD COLUMN IF NOT EXISTS chased_dates date[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS staff_chase_log_check_idx
  ON staff_chase_log (organisation_id, staff_id, check_code, created_at DESC);

-- One row per received document version (evidence versions themselves are immutable).
CREATE TABLE staff_check_receipt (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  staff_id            uuid NOT NULL REFERENCES staff(id),
  check_code          text NOT NULL CHECK (check_code ~ '^[A-Z0-9]{1,12}$'),
  evidence_version_id uuid NOT NULL UNIQUE REFERENCES evidence_version(id),
  file_name           text CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 200),
  supplied_by         text CHECK (supplied_by IS NULL OR length(supplied_by) BETWEEN 1 AND 120),
  note                text CHECK (note IS NULL OR length(note) <= 2000),
  session_code        text CHECK (session_code IS NULL OR length(session_code) <= 40),
  created_by          uuid NOT NULL REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_check_receipt_staff_idx ON staff_check_receipt (organisation_id, staff_id);
ALTER TABLE staff_check_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_check_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_check_receipt
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE TRIGGER staff_check_receipt_immutable BEFORE UPDATE OR DELETE ON staff_check_receipt
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT, INSERT ON staff_check_receipt TO hub_app;

CREATE TABLE staff_check_comment (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  staff_id        uuid NOT NULL REFERENCES staff(id),
  check_code      text NOT NULL CHECK (check_code ~ '^[A-Z0-9]{1,12}$'),
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  -- A name kept from the saved v36 copy when the author is not a member.
  author_name     text CHECK (author_name IS NULL OR length(author_name) <= 120),
  created_by      uuid NOT NULL REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_check_comment_staff_idx ON staff_check_comment (organisation_id, staff_id, created_at);
ALTER TABLE staff_check_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_check_comment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_check_comment
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE TRIGGER staff_check_comment_immutable BEFORE UPDATE OR DELETE ON staff_check_comment
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
GRANT SELECT, INSERT ON staff_check_comment TO hub_app;

ALTER TABLE staff_correction_request ADD COLUMN IF NOT EXISTS code text;
CREATE UNIQUE INDEX IF NOT EXISTS staff_correction_request_org_code_uidx
  ON staff_correction_request (organisation_id, code) WHERE code IS NOT NULL;
