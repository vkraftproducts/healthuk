-- Workflow pass D (vehicles and equipment), 6 Nov 2026. Forward-only.
-- D1 register fields, D2 service records and odometer reviews, D3 equipment quarantine and
-- release history, D5 off-road reasons and move dates, D6 checklist drafts published by a
-- second person.

ALTER TYPE vehicle_type ADD VALUE IF NOT EXISTS 'HIGH_DEPENDENCY';

-- D1: what the vehicle is, what it may do, and when a lease or hire ends.
ALTER TABLE vehicle
  ADD COLUMN make                       text CHECK (make IS NULL OR length(make) BETWEEN 1 AND 60),
  ADD COLUMN model                      text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 60),
  ADD COLUMN model_year                 int CHECK (model_year IS NULL OR model_year BETWEEN 1980 AND 2100),
  ADD COLUMN first_registered_on        date,
  ADD COLUMN en1789_type                text CHECK (en1789_type IS NULL OR en1789_type IN ('A1', 'A2', 'B', 'C')),
  ADD COLUMN conversion_company         text CHECK (conversion_company IS NULL OR length(conversion_company) <= 120),
  ADD COLUMN conversion_certificate_ref text CHECK (conversion_certificate_ref IS NULL OR length(conversion_certificate_ref) <= 80),
  ADD COLUMN ownership_ends_on          date,
  ADD COLUMN service_ids                uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN blue_light_authorised      boolean NOT NULL DEFAULT false,
  ADD COLUMN bariatric_limit_kg         int CHECK (bariatric_limit_kg IS NULL OR bariatric_limit_kg BETWEEN 50 AND 1000),
  -- D5: why it is off the road or quarantined, and when it is expected back.
  ADD COLUMN off_road_reason            text CHECK (off_road_reason IS NULL OR length(off_road_reason) <= 500),
  ADD COLUMN quarantine_reason          text CHECK (quarantine_reason IS NULL OR length(quarantine_reason) <= 500),
  ADD COLUMN expected_return_on         date;

ALTER TABLE vehicle_status_change
  ADD COLUMN reason_code text CHECK (reason_code IS NULL OR reason_code IN
    ('ACCIDENT', 'AWAITING_PARTS', 'REPAIR', 'SERVICE', 'SOLD', 'OTHER')),
  ADD COLUMN expected_return_on date;

-- D5: a move takes effect on a stated date (today or earlier).
ALTER TABLE vehicle_location_history ADD COLUMN effective_on date;

-- D2: a service is recorded with the garage and its job sheet.
ALTER TABLE maintenance_event
  ADD COLUMN garage text CHECK (garage IS NULL OR length(garage) BETWEEN 2 AND 120),
  ADD COLUMN job_sheet_evidence_item_id uuid;

-- D2: the Fleet lead confirms or corrects a flagged odometer reading, with a reason. The reading
-- itself never changes; the review is a separate, append-only record.
CREATE TABLE odometer_review (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL REFERENCES organisation(id),
  reading_id        uuid NOT NULL UNIQUE REFERENCES odometer_reading(id),
  vehicle_id        uuid NOT NULL REFERENCES vehicle(id),
  decision          text NOT NULL CHECK (decision IN ('CONFIRMED', 'CORRECTED')),
  corrected_reading int CHECK (corrected_reading IS NULL OR corrected_reading BETWEEN 0 AND 2000000),
  reason            text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  reviewed_by       uuid NOT NULL,
  reviewed_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'CORRECTED') = (corrected_reading IS NOT NULL))
);
CREATE INDEX odometer_review_idx ON odometer_review (organisation_id, vehicle_id);
CREATE TRIGGER odometer_review_immutable BEFORE UPDATE OR DELETE ON odometer_review
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE odometer_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE odometer_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON odometer_review
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON odometer_review TO hub_app;   -- immutable

-- D3: instructions for use, and who quarantined it (release must be by someone else).
ALTER TABLE equipment_asset
  ADD COLUMN instructions   text CHECK (instructions IS NULL OR length(instructions) <= 2000),
  ADD COLUMN quarantined_by uuid;
-- Bariatric equipment gives the vehicle bariatric capability.
ALTER TABLE equipment_asset DROP CONSTRAINT IF EXISTS equipment_asset_capability_check;
ALTER TABLE equipment_asset ADD CONSTRAINT equipment_asset_capability_check
  CHECK (capability IS NULL OR capability IN ('STRETCHER', 'WHEELCHAIR', 'CLINICAL', 'BARIATRIC'));

CREATE TABLE equipment_status_change (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  asset_id         uuid NOT NULL REFERENCES equipment_asset(id),
  action           text NOT NULL CHECK (action IN ('QUARANTINE', 'RELEASE')),
  reason           text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  evidence_item_id uuid,
  changed_by       uuid NOT NULL,
  changed_at       timestamptz NOT NULL DEFAULT now(),
  -- A release always carries the evidence it relied on.
  CHECK (action <> 'RELEASE' OR evidence_item_id IS NOT NULL)
);
CREATE INDEX equipment_status_change_idx
  ON equipment_status_change (organisation_id, asset_id, changed_at DESC);
CREATE TRIGGER equipment_status_change_immutable BEFORE UPDATE OR DELETE ON equipment_status_change
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE equipment_status_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_status_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON equipment_status_change
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON equipment_status_change TO hub_app;   -- immutable

-- D4: the repair record can carry the job sheet.
ALTER TABLE defect ADD COLUMN repair_job_sheet_evidence_item_id uuid;

-- D6: a checklist is drafted, then published by a different person; publishing retires the old
-- version. Existing templates (and seeded ones) keep working as published; the API always
-- inserts new versions as DRAFT.
ALTER TABLE vdi_template
  ADD COLUMN status       text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  ADD COLUMN published_by uuid,
  ADD COLUMN published_at timestamptz;
ALTER TABLE vdi_template DISABLE TRIGGER vdi_template_guard_trg;
UPDATE vdi_template SET status = CASE WHEN active THEN 'PUBLISHED' ELSE 'RETIRED' END,
  published_at = CASE WHEN active THEN created_at END;
ALTER TABLE vdi_template ENABLE TRIGGER vdi_template_guard_trg;
ALTER TABLE vdi_template ADD CONSTRAINT vdi_template_publisher_check
  CHECK (published_by IS NULL OR created_by IS NULL OR published_by <> created_by);

CREATE OR REPLACE FUNCTION vdi_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'VDI templates are retired, not deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (to_jsonb(NEW) - 'active' - 'status' - 'published_by' - 'published_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'active' - 'status' - 'published_by' - 'published_at') THEN
    RAISE EXCEPTION 'publish a new VDI template version instead of editing' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PUBLISHED', 'RETIRED'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'a checklist goes draft, published, retired' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.published_by IS NOT NULL AND NEW.published_by IS DISTINCT FROM OLD.published_by THEN
    RAISE EXCEPTION 'the publisher is recorded once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
