-- DEV/DEMO ONLY (18 Nov 2026): where the v36 sample records were last placed in time.
-- The v36 loader moves its own records forward by the days since then on every start, so the
-- demo always shows "today" the way the v36 prototype does. The app itself never reads this.
CREATE TABLE demo_seed_state (
  organisation_id uuid NOT NULL,
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 60),
  placed_on       date NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, key)
);
ALTER TABLE demo_seed_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_seed_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON demo_seed_state
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
