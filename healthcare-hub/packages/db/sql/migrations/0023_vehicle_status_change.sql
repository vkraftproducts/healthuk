-- Task 26: vehicle and planner operations.
-- Taking a vehicle off the road or quarantining it, and returning it to service, now keeps a
-- reason and who did it. The log is append-only (history is immutable).

CREATE TABLE vehicle_status_change (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  vehicle_id       uuid NOT NULL REFERENCES vehicle(id),
  flag             text NOT NULL CHECK (flag IN ('OFF_ROAD', 'QUARANTINE')),
  set_on           boolean NOT NULL,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  jobs_released    int NOT NULL DEFAULT 0 CHECK (jobs_released >= 0),
  changed_by       uuid NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_status_change_idx
  ON vehicle_status_change (organisation_id, vehicle_id, changed_at DESC);
CREATE TRIGGER vehicle_status_change_immutable BEFORE UPDATE OR DELETE ON vehicle_status_change
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE vehicle_status_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_status_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vehicle_status_change
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON vehicle_status_change TO hub_app;   -- immutable
