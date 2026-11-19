-- v36 Vehicles (step 2, 18 Nov 2026): what the v36 screens record that the fleet tables did not
-- keep yet.
--  * Daily check › Amendments: a free-text correction added by the checker ("Odometer corrected
--    41,002 → 41,020 (typing error). Original kept."). The check itself stays immutable.
--  * Defects: the reporter's note for the repairer, the number of photos v36 counted, the work
--    recorded at sign-off (kept apart from the repair plan), and the last "sent back for repair"
--    (by whom, when, why), plus the reason given when the owner / review date was changed.

CREATE TABLE vdi_note (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  vdi_id          uuid NOT NULL,
  text            text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  by_user_id      uuid NOT NULL REFERENCES app_user(id),
  at              timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  FOREIGN KEY (vdi_id, organisation_id) REFERENCES vdi (id, organisation_id)
);
CREATE INDEX vdi_note_idx ON vdi_note (organisation_id, vdi_id, at);
CREATE TRIGGER vdi_note_version BEFORE UPDATE ON vdi_note
  FOR EACH ROW EXECUTE FUNCTION bump_version();
-- Corrections are a record: never changed or removed.
CREATE TRIGGER vdi_note_immutable BEFORE UPDATE OR DELETE ON vdi_note
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE vdi_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE vdi_note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vdi_note
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON vdi_note TO hub_app;
CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON vdi_note
  FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change();

ALTER TABLE defect
  ADD COLUMN IF NOT EXISTS report_note text CHECK (report_note IS NULL OR length(report_note) <= 1000),
  ADD COLUMN IF NOT EXISTS photo_count int CHECK (photo_count IS NULL OR photo_count BETWEEN 0 AND 50),
  ADD COLUMN IF NOT EXISTS repair_work text CHECK (repair_work IS NULL OR length(repair_work) <= 2000),
  ADD COLUMN IF NOT EXISTS sent_back_at timestamptz,
  ADD COLUMN IF NOT EXISTS sent_back_by uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS sent_back_reason text CHECK (sent_back_reason IS NULL OR length(sent_back_reason) <= 1000),
  ADD COLUMN IF NOT EXISTS owner_change_reason text CHECK (owner_change_reason IS NULL OR length(owner_change_reason) <= 1000);
