-- v36 front end hosted in the web app (18 Nov 2026). v36 keeps its working data as one document
-- split into numbered chunks (demo/s0.., the activity log demo/l0..) plus demo/meta, the version
-- marker. Each organisation has its own copy; RLS keeps it to the organisation.
CREATE TABLE v36_workspace_doc (
  organisation_id uuid NOT NULL,
  path            text NOT NULL CHECK (path ~ '^demo/(meta|s[0-9]{1,3}|l[0-9]{1,3})$'),
  data            jsonb NOT NULL CHECK (octet_length(data::text) <= 400000),
  updated_by      uuid NOT NULL REFERENCES app_user(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  PRIMARY KEY (organisation_id, path)
);
CREATE TRIGGER v36_workspace_doc_version BEFORE UPDATE ON v36_workspace_doc
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE v36_workspace_doc ENABLE ROW LEVEL SECURITY;
ALTER TABLE v36_workspace_doc FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON v36_workspace_doc
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON v36_workspace_doc TO hub_app;
