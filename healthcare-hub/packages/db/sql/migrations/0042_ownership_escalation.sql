-- Batch 3: defect ownership and review dates; chase log for onboarding; overdue alert sources.
-- Synthetic demo / product improvements from the eight-workflow review.

ALTER TABLE defect
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES app_user(id),
  ADD COLUMN IF NOT EXISTS review_by date;

CREATE INDEX IF NOT EXISTS defect_owner_idx ON defect (organisation_id, owner_user_id)
  WHERE status <> 'RELEASED';

-- Dated chase log for references / DBS (requested → chased → received).
CREATE TABLE IF NOT EXISTS staff_chase_log (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  staff_id        uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('REFERENCE', 'DBS', 'RIGHT_TO_WORK', 'OTHER')),
  subject         text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  requested_on    date,
  chased_on       date,
  received_on     date,
  note            text CHECK (note IS NULL OR length(note) <= 1000),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS staff_chase_log_staff_idx
  ON staff_chase_log (organisation_id, staff_id, kind);
ALTER TABLE staff_chase_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_chase_log FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY tenant_isolation ON staff_chase_log
    USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT SELECT, INSERT, UPDATE ON staff_chase_log TO hub_app;

-- Backfill: open stop-use / open defects without an owner get the first Fleet lead membership.
UPDATE defect d
   SET owner_user_id = m.user_id,
       review_by = CASE
         WHEN d.severity = 'CRITICAL' THEN (d.discovered_at::date + 3)
         WHEN d.severity = 'MAJOR' THEN (d.discovered_at::date + 7)
         ELSE (d.discovered_at::date + 14)
       END
  FROM membership m
  JOIN role r ON r.id = m.role_id AND r.key = 'FLEET_LEAD'
 WHERE d.owner_user_id IS NULL
   AND d.status <> 'RELEASED'
   AND m.organisation_id = d.organisation_id
   AND m.valid_to IS NULL
   AND m.user_id = (
     SELECT m2.user_id FROM membership m2
       JOIN role r2 ON r2.id = m2.role_id AND r2.key = 'FLEET_LEAD'
      WHERE m2.organisation_id = d.organisation_id AND m2.valid_to IS NULL
      ORDER BY m2.valid_from ASC LIMIT 1
   );
