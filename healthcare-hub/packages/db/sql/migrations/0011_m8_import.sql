-- M8: CSV import with preview, duplicate checks, per-row errors and rollback; compliance workbook
-- staging (INT-01, MIG-01..03). Forward-only.

CREATE TABLE import_batch (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  code            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('STAFF', 'VEHICLES', 'WORKBOOK')),
  filename        text NOT NULL CHECK (length(filename) BETWEEN 1 AND 200),
  sheet           text CHECK (sheet IS NULL OR length(sheet) BETWEEN 1 AND 100),
  status          text NOT NULL DEFAULT 'PREVIEWED'
                  CHECK (status IN ('PREVIEWED', 'COMMITTED', 'PARTIAL', 'ROLLED_BACK', 'DISCARDED')),
  row_count       int NOT NULL DEFAULT 0,
  valid_count     int NOT NULL DEFAULT 0,
  error_count     int NOT NULL DEFAULT 0,
  duplicate_count int NOT NULL DEFAULT 0,
  imported_count  int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL,
  committed_at    timestamptz,
  committed_by    uuid,
  rolled_back_at  timestamptz,
  rolled_back_by  uuid,
  version         int NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organisation_id),
  UNIQUE (organisation_id, code)
);
CREATE INDEX import_batch_org_idx ON import_batch (organisation_id, created_at DESC);
CREATE TRIGGER import_batch_version BEFORE UPDATE ON import_batch FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE import_row (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  batch_id        uuid NOT NULL,
  row_no          int NOT NULL CHECK (row_no >= 1),
  data            jsonb NOT NULL,
  errors          text[] NOT NULL DEFAULT '{}',
  duplicate_of    text,
  status          text NOT NULL CHECK (status IN ('VALID', 'ERROR', 'DUPLICATE', 'IMPORTED', 'FAILED', 'ROLLED_BACK', 'KEPT')),
  entity_id       uuid,
  result_detail   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id, organisation_id) REFERENCES import_batch (id, organisation_id),
  UNIQUE (batch_id, row_no)
);
CREATE INDEX import_row_batch_idx ON import_row (organisation_id, batch_id, row_no);

-- Compliance workbook staging: one row per source row, never published until approved.
CREATE TABLE workbook_item (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id    uuid NOT NULL REFERENCES organisation(id),
  batch_id           uuid NOT NULL,
  sheet              text NOT NULL,
  row_no             int NOT NULL,
  prompt_code        text,
  kind               text NOT NULL CHECK (kind IN ('HEADER', 'PROMPT')),
  text               text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  placeholders       text[] NOT NULL DEFAULT '{}',
  -- Imported statuses are the source's only; they never set a requirement status.
  source_status      text,
  legacy_kloe        text[] NOT NULL DEFAULT '{}',
  classification     text CHECK (classification IN ('SHARED', 'AMBULANCE', 'DENTAL', 'CARE_HOME', 'GP', 'OUT_OF_SCOPE')),
  mapping_status     text NOT NULL DEFAULT 'UNMAPPED'
                     CHECK (mapping_status IN ('UNMAPPED', 'PROPOSED', 'APPROVED', 'REJECTED', 'PUBLISHED')),
  proposed_code      text CHECK (proposed_code IS NULL OR proposed_code ~ '^[A-Z0-9][A-Z0-9_-]{1,59}$'),
  proposed_title     text CHECK (proposed_title IS NULL OR length(proposed_title) BETWEEN 1 AND 200),
  proposed_subject   text CHECK (proposed_subject IS NULL OR proposed_subject IN ('ORGANISATION', 'SERVICE', 'STAFF', 'VEHICLE', 'EQUIPMENT', 'PREMISES')),
  proposed_by        uuid,
  proposed_at        timestamptz,
  decided_by         uuid,
  decided_at         timestamptz,
  decision_note      text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  published_template_id uuid,
  version            int NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id, organisation_id) REFERENCES import_batch (id, organisation_id),
  UNIQUE (batch_id, sheet, row_no),
  -- Approval is a governance decision by someone other than the proposer.
  CHECK (mapping_status NOT IN ('APPROVED', 'PUBLISHED') OR (decided_by IS NOT NULL AND decided_by <> proposed_by)),
  CHECK (mapping_status NOT IN ('PROPOSED', 'APPROVED', 'PUBLISHED')
         OR (kind = 'PROMPT' AND classification IS NOT NULL AND classification <> 'OUT_OF_SCOPE'
             AND proposed_code IS NOT NULL AND proposed_title IS NOT NULL AND proposed_subject IS NOT NULL)),
  CHECK (mapping_status <> 'PUBLISHED' OR published_template_id IS NOT NULL)
);
CREATE INDEX workbook_item_org_idx ON workbook_item (organisation_id, mapping_status, sheet, row_no);
CREATE TRIGGER workbook_item_version BEFORE UPDATE ON workbook_item FOR EACH ROW EXECUTE FUNCTION bump_version();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_batch', 'import_row', 'workbook_item'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
-- Staged rows can hold personal data (names in a staff file): import permission only.
CREATE POLICY import_restricted ON import_row AS RESTRICTIVE
  USING (app_has_permission('admin.import.manage')) WITH CHECK (app_has_permission('admin.import.manage'));
CREATE POLICY import_restricted ON import_batch AS RESTRICTIVE
  USING (app_has_permission('admin.import.manage') OR app_has_permission('admin.requirements.publish'))
  WITH CHECK (app_has_permission('admin.import.manage'));
CREATE POLICY workbook_restricted ON workbook_item AS RESTRICTIVE
  USING (app_has_permission('admin.import.manage') OR app_has_permission('admin.requirements.publish'))
  WITH CHECK (app_has_permission('admin.import.manage') OR app_has_permission('admin.requirements.publish'));

GRANT SELECT, INSERT, UPDATE ON import_batch, import_row, workbook_item TO hub_app;
