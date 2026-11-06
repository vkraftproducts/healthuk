-- EVT-04: compliments, staff feedback and patient surveys, kept with themes so recurring themes
-- can be analysed and turned into actions. Free text is minimised: no names or patient identifiers.
CREATE TABLE feedback_item (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  location_id     uuid,
  kind            text NOT NULL CHECK (kind IN ('COMPLIMENT', 'STAFF_FEEDBACK', 'PATIENT_SURVEY')),
  received_on     date NOT NULL,
  source          text NOT NULL CHECK (length(source) BETWEEN 2 AND 200),
  summary         text NOT NULL CHECK (length(summary) BETWEEN 3 AND 2000),
  rating          smallint CHECK (rating BETWEEN 1 AND 5),
  themes          text[] NOT NULL DEFAULT '{}' CHECK (cardinality(themes) <= 10),
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE INDEX feedback_item_idx ON feedback_item (organisation_id, received_on, kind);

-- Actions can now come from feedback.
ALTER TABLE action DROP CONSTRAINT IF EXISTS action_source_type_check;
ALTER TABLE action ADD CONSTRAINT action_source_type_check
  CHECK (source_type IN ('FINDING', 'EVENT', 'RISK', 'CORRESPONDENCE', 'FEEDBACK'));

ALTER TABLE feedback_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON feedback_item
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON feedback_item TO hub_app;  -- immutable once recorded

-- Open screens refetch when feedback changes (see 0013; test/live.test.ts checks every table).
CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON feedback_item
  FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change();
