-- Workflow pass J1 (premises safety), 6 Nov 2026. Forward-only.
-- The area within the location, the applicability reviewer and review date, an interval with
-- its source when no requirement is linked, an append-only edit history, and findings raised as
-- actions on the actions register.

ALTER TABLE premises_item
  ADD COLUMN area_name                text CHECK (area_name IS NULL OR length(area_name) BETWEEN 2 AND 120),
  ADD COLUMN interval_months          int CHECK (interval_months IS NULL OR interval_months BETWEEN 1 AND 120),
  ADD COLUMN applicability_reviewer_id uuid,
  ADD COLUMN applicability_review_on  date;

CREATE TABLE premises_item_history (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  item_id          uuid NOT NULL REFERENCES premises_item(id),
  change           text NOT NULL CHECK (change IN ('CREATED', 'EDITED', 'APPLICABILITY', 'SCHEDULE', 'FINDING')),
  summary          text NOT NULL CHECK (length(summary) BETWEEN 3 AND 1000),
  before           jsonb,
  after            jsonb,
  changed_by       uuid NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX premises_item_history_idx
  ON premises_item_history (organisation_id, item_id, changed_at DESC);
CREATE TRIGGER premises_item_history_immutable BEFORE UPDATE OR DELETE ON premises_item_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE premises_item_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE premises_item_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON premises_item_history
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON premises_item_history TO hub_app;   -- immutable

-- Actions can now come from a premises finding. Adds PREMISES to whatever list is current so a
-- source added by another migration is kept.
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'action_source_type_check' AND conrelid = 'action'::regclass;
  IF def IS NULL THEN
    ALTER TABLE action ADD CONSTRAINT action_source_type_check CHECK (source_type IN
      ('FINDING', 'EVENT', 'RISK', 'CORRESPONDENCE', 'FEEDBACK', 'MEETING', 'PREMISES'));
  ELSIF position('''PREMISES''' IN def) = 0 THEN
    ALTER TABLE action DROP CONSTRAINT action_source_type_check;
    EXECUTE 'ALTER TABLE action ADD CONSTRAINT action_source_type_check '
      || replace(def, 'ARRAY[', 'ARRAY[''PREMISES''::text, ');
  END IF;
END $$;
