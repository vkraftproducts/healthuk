-- M4: fleet and equipment (FLT-01..08). Forward-only.
-- Inspections, cleaning records, odometer readings and releases are immutable (non-negotiable 5).

CREATE TYPE vehicle_type AS ENUM ('AMBULANCE', 'PTS_VEHICLE', 'WAV', 'CAR', 'MINIBUS', 'OTHER');
CREATE TYPE vehicle_ownership AS ENUM ('OWNED', 'LEASED', 'HIRED');
CREATE TYPE vehicle_status AS ENUM ('AVAILABLE', 'BLOCKED', 'QUARANTINED', 'OFF_ROAD');
CREATE TYPE odometer_source AS ENUM ('MANUAL', 'VDI', 'FUEL', 'SERVICE');
CREATE TYPE asset_status AS ENUM ('AVAILABLE', 'QUARANTINED', 'RETIRED');
CREATE TYPE inspection_regime_kind AS ENUM ('LOLER_THOROUGH', 'SERVICE', 'CALIBRATION', 'PRE_USE', 'PAT');
CREATE TYPE check_result AS ENUM ('PASS', 'FAIL', 'NA');
CREATE TYPE cleaning_type AS ENUM ('PRE_SHIFT', 'BETWEEN_PATIENT', 'ENHANCED');
CREATE TYPE defect_severity AS ENUM ('CRITICAL', 'MAJOR', 'MINOR');
CREATE TYPE defect_status AS ENUM ('OPEN', 'REPAIRING', 'REPAIRED', 'RELEASED');
CREATE TYPE expense_category AS ENUM ('FUEL', 'CHARGING', 'PARKING', 'TOLL', 'WASH', 'OTHER');
CREATE TYPE expense_status AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- ---------------------------------------------------------------------------
CREATE TABLE vehicle (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  registration        text NOT NULL CHECK (registration ~ '^[A-Z0-9]{2,8}$'),
  callsign            text NOT NULL CHECK (callsign ~ '^[A-Z0-9][A-Z0-9\-]{1,15}$'),
  vin                 text CHECK (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  type                vehicle_type NOT NULL,
  ownership           vehicle_ownership NOT NULL DEFAULT 'OWNED',
  base_location_id    uuid NOT NULL,
  seats               int NOT NULL DEFAULT 0 CHECK (seats BETWEEN 0 AND 60),
  wheelchair_capacity int NOT NULL DEFAULT 0 CHECK (wheelchair_capacity BETWEEN 0 AND 10),
  stretcher           boolean NOT NULL DEFAULT false,
  permitted_loads     text[] NOT NULL DEFAULT '{}',
  licence_category    text NOT NULL DEFAULT 'B' CHECK (licence_category ~ '^(B|BE|C1|C1E|C|CE|D1|D1E|D|DE)$'),
  -- Derived by the domain layer: BLOCKED while a stop-use defect is open; QUARANTINED / OFF_ROAD set by fleet.
  status              vehicle_status NOT NULL DEFAULT 'AVAILABLE',
  status_reason       text,
  quarantined         boolean NOT NULL DEFAULT false,
  off_road            boolean NOT NULL DEFAULT false,
  current_odometer    int CHECK (current_odometer IS NULL OR current_odometer >= 0),
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  UNIQUE (organisation_id, registration),
  UNIQUE (organisation_id, callsign),
  FOREIGN KEY (base_location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE UNIQUE INDEX vehicle_org_id_key ON vehicle (id, organisation_id);
CREATE INDEX vehicle_status_idx ON vehicle (organisation_id, status, callsign);
CREATE TRIGGER vehicle_version BEFORE UPDATE ON vehicle FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE vehicle_location_history (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  vehicle_id      uuid NOT NULL,
  location_id     uuid NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 300),
  moved_by        uuid NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE INDEX vehicle_location_history_idx ON vehicle_location_history (organisation_id, vehicle_id, at);
CREATE TRIGGER vehicle_location_history_immutable BEFORE UPDATE OR DELETE ON vehicle_location_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE odometer_reading (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  vehicle_id      uuid NOT NULL,
  reading         int NOT NULL CHECK (reading BETWEEN 0 AND 2000000),
  read_on         date NOT NULL,
  source          odometer_source NOT NULL,
  flags           text[] NOT NULL DEFAULT '{}',
  recorded_by     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id)
);
CREATE INDEX odometer_idx ON odometer_reading (organisation_id, vehicle_id, read_on, created_at);
CREATE TRIGGER odometer_reading_immutable BEFORE UPDATE OR DELETE ON odometer_reading
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Maintenance: date AND mileage, whichever first (FLT-02, T12).
CREATE TABLE maintenance_plan (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL,
  vehicle_id          uuid NOT NULL,
  title               text NOT NULL CHECK (length(title) BETWEEN 2 AND 120),
  interval_days       int CHECK (interval_days IS NULL OR interval_days BETWEEN 1 AND 1100),
  interval_miles      int CHECK (interval_miles IS NULL OR interval_miles BETWEEN 100 AND 100000),
  due_soon_miles      int NOT NULL DEFAULT 500,
  due_soon_days       int NOT NULL DEFAULT 30,
  last_done_on        date,
  last_done_odometer  int,
  active              boolean NOT NULL DEFAULT true,
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  CHECK (interval_days IS NOT NULL OR interval_miles IS NOT NULL),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id)
);
CREATE UNIQUE INDEX maintenance_plan_org_id_key ON maintenance_plan (id, organisation_id);
CREATE INDEX maintenance_plan_idx ON maintenance_plan (organisation_id, vehicle_id);
CREATE TRIGGER maintenance_plan_version BEFORE UPDATE ON maintenance_plan FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE maintenance_event (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  plan_id         uuid NOT NULL,
  done_on         date NOT NULL,
  odometer        int,
  notes           text CHECK (notes IS NULL OR length(notes) <= 1000),
  recorded_by     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (plan_id, organisation_id) REFERENCES maintenance_plan (id, organisation_id)
);
CREATE TRIGGER maintenance_event_immutable BEFORE UPDATE OR DELETE ON maintenance_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
CREATE TABLE equipment_asset (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL REFERENCES organisation(id),
  asset_tag         text NOT NULL CHECK (asset_tag ~ '^[A-Z0-9][A-Z0-9\-]{1,23}$'),
  category          text NOT NULL CHECK (category ~ '^[A-Z_]{2,30}$'),
  model             text CHECK (model IS NULL OR length(model) <= 120),
  serial            text CHECK (serial IS NULL OR length(serial) <= 60),
  manufacturer      text CHECK (manufacturer IS NULL OR length(manufacturer) <= 120),
  swl_kg            numeric(8, 2) CHECK (swl_kg IS NULL OR swl_kg > 0),
  vehicle_id        uuid,
  location_id       uuid,
  -- Needed for the vehicle's capability (e.g. stretcher, ramp): quarantine changes it (FLT-08).
  capability        text CHECK (capability IS NULL OR capability IN ('STRETCHER', 'WHEELCHAIR', 'CLINICAL')),
  status            asset_status NOT NULL DEFAULT 'AVAILABLE',
  quarantine_reason text,
  version           int NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  UNIQUE (organisation_id, asset_tag),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id),
  CHECK ((status = 'QUARANTINED') = (quarantine_reason IS NOT NULL))
);
CREATE UNIQUE INDEX equipment_asset_org_id_key ON equipment_asset (id, organisation_id);
CREATE INDEX equipment_asset_vehicle_idx ON equipment_asset (organisation_id, vehicle_id);
CREATE TRIGGER equipment_asset_version BEFORE UPDATE ON equipment_asset FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Each regime is a separate schedule (LOLER, service, calibration are never merged, FLT-03).
CREATE TABLE inspection_regime (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id         uuid NOT NULL,
  asset_id                uuid NOT NULL,
  regime                  inspection_regime_kind NOT NULL,
  requirement_instance_id uuid NOT NULL,
  source                  text CHECK (source IS NULL OR length(source) <= 300),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  UNIQUE (asset_id, regime),
  FOREIGN KEY (asset_id, organisation_id) REFERENCES equipment_asset (id, organisation_id),
  FOREIGN KEY (requirement_instance_id, organisation_id) REFERENCES requirement_instance (id, organisation_id)
);

-- ---------------------------------------------------------------------------
-- VDI templates are versioned; a submission keeps the exact version it used.
CREATE TABLE vdi_template (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  name            text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  version         int NOT NULL CHECK (version >= 1),
  vehicle_type    vehicle_type,
  items           jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 100),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (organisation_id, name, version)
);
CREATE UNIQUE INDEX vdi_template_org_id_key ON vdi_template (id, organisation_id);
-- Items are frozen once published; only `active` may change.
CREATE FUNCTION vdi_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'VDI templates are retired, not deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'publish a new VDI template version instead of editing' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vdi_template_guard_trg BEFORE UPDATE OR DELETE ON vdi_template FOR EACH ROW EXECUTE FUNCTION vdi_template_guard();

CREATE TABLE vdi (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id      uuid NOT NULL,
  vehicle_id           uuid NOT NULL,
  template_id          uuid NOT NULL,
  shift_id             uuid,
  checker_user_id      uuid NOT NULL,
  odometer             int NOT NULL CHECK (odometer >= 0),
  outcome              check_result NOT NULL CHECK (outcome IN ('PASS', 'FAIL')),
  client_submission_id uuid NOT NULL,
  captured_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  notes                text CHECK (notes IS NULL OR length(notes) <= 1000),
  UNIQUE (organisation_id, client_submission_id),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id),
  FOREIGN KEY (template_id, organisation_id) REFERENCES vdi_template (id, organisation_id)
);
CREATE UNIQUE INDEX vdi_org_id_key ON vdi (id, organisation_id);
CREATE INDEX vdi_vehicle_idx ON vdi (organisation_id, vehicle_id, captured_at DESC);
CREATE TRIGGER vdi_immutable BEFORE UPDATE OR DELETE ON vdi FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE vdi_item_result (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  vdi_id          uuid NOT NULL,
  item_code       text NOT NULL,
  critical        boolean NOT NULL,
  result          check_result NOT NULL,
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  photo_evidence_item_id uuid,
  UNIQUE (vdi_id, item_code),
  -- A failed or N/A item must say why.
  CHECK (result = 'PASS' OR reason IS NOT NULL),
  FOREIGN KEY (vdi_id, organisation_id) REFERENCES vdi (id, organisation_id),
  FOREIGN KEY (photo_evidence_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id)
);
CREATE TRIGGER vdi_item_result_immutable BEFORE UPDATE OR DELETE ON vdi_item_result FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE vdi_amendment (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  vdi_id          uuid NOT NULL,
  item_code       text NOT NULL,
  new_result      check_result NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  amended_by      uuid NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vdi_id, organisation_id) REFERENCES vdi (id, organisation_id)
);
CREATE TRIGGER vdi_amendment_immutable BEFORE UPDATE OR DELETE ON vdi_amendment FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE cleaning_record (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id      uuid NOT NULL,
  vehicle_id           uuid NOT NULL,
  shift_id             uuid,
  type                 cleaning_type NOT NULL,
  cleaned_by           uuid NOT NULL,
  client_submission_id uuid NOT NULL,
  captured_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  notes                text CHECK (notes IS NULL OR length(notes) <= 500),
  UNIQUE (organisation_id, client_submission_id),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id)
);
CREATE INDEX cleaning_vehicle_idx ON cleaning_record (organisation_id, vehicle_id, captured_at DESC);
CREATE TRIGGER cleaning_record_immutable BEFORE UPDATE OR DELETE ON cleaning_record FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
CREATE TABLE defect (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  vehicle_id       uuid,
  asset_id         uuid,
  severity         defect_severity NOT NULL,
  stop_use         boolean NOT NULL,
  description      text NOT NULL CHECK (length(description) BETWEEN 3 AND 1000),
  reported_by      uuid NOT NULL,
  discovered_at    timestamptz NOT NULL,
  source_vdi_id    uuid,
  status           defect_status NOT NULL DEFAULT 'OPEN',
  classified_by    uuid,
  repair_deadline  date,
  repair_notes     text CHECK (repair_notes IS NULL OR length(repair_notes) <= 2000),
  repaired_at      timestamptz,
  repaired_by      uuid,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((vehicle_id IS NULL) <> (asset_id IS NULL)),
  -- A critical defect is always stop-use.
  CHECK (severity <> 'CRITICAL' OR stop_use),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id),
  FOREIGN KEY (asset_id, organisation_id) REFERENCES equipment_asset (id, organisation_id),
  FOREIGN KEY (source_vdi_id, organisation_id) REFERENCES vdi (id, organisation_id)
);
CREATE UNIQUE INDEX defect_org_id_key ON defect (id, organisation_id);
CREATE INDEX defect_open_idx ON defect (organisation_id, status, vehicle_id);
CREATE TRIGGER defect_version BEFORE UPDATE ON defect FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Return to service is a separate, authorised, immutable act (FLT-06): RELEASED only with a release row,
-- and a stop-use defect can never be downgraded.
CREATE FUNCTION defect_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'defects are never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF OLD.status = 'RELEASED' THEN RAISE EXCEPTION 'released defects are closed' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.stop_use AND NOT NEW.stop_use THEN RAISE EXCEPTION 'a stop-use defect cannot be downgraded' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.reported_by <> OLD.reported_by OR NEW.discovered_at <> OLD.discovered_at THEN
    RAISE EXCEPTION 'defect identity fields are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'RELEASED' AND NOT EXISTS (
    SELECT 1 FROM defect_release r WHERE r.defect_id = NEW.id
       AND r.xmin::text = ((pg_current_xact_id()::text)::bigint % 4294967296)::text) THEN
    RAISE EXCEPTION 'release requires a defect_release record' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE defect_release (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  defect_id       uuid NOT NULL UNIQUE,
  released_by     uuid NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  evidence_item_id uuid,
  at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (defect_id, organisation_id) REFERENCES defect (id, organisation_id),
  FOREIGN KEY (evidence_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id)
);
CREATE TRIGGER defect_release_immutable BEFORE UPDATE OR DELETE ON defect_release FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER defect_guard_trg BEFORE UPDATE OR DELETE ON defect FOR EACH ROW EXECUTE FUNCTION defect_guard();

-- ---------------------------------------------------------------------------
CREATE TABLE fuel_expense (
  id                       uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id          uuid NOT NULL,
  vehicle_id               uuid NOT NULL,
  submitted_by             uuid NOT NULL,
  spent_on                 date NOT NULL,
  category                 expense_category NOT NULL,
  odometer                 int CHECK (odometer IS NULL OR odometer >= 0),
  quantity                 numeric(10, 2) CHECK (quantity IS NULL OR quantity > 0),
  unit                     text CHECK (unit IS NULL OR unit IN ('LITRES', 'KWH')),
  amount_pence             int NOT NULL CHECK (amount_pence BETWEEN 1 AND 10000000),
  currency                 text NOT NULL DEFAULT 'GBP' CHECK (currency = 'GBP'),
  supplier                 text CHECK (supplier IS NULL OR length(supplier) <= 120),
  receipt_evidence_item_id uuid,
  duplicate_of             uuid REFERENCES fuel_expense(id),
  status                   expense_status NOT NULL DEFAULT 'SUBMITTED',
  decided_by               uuid,
  decided_at               timestamptz,
  decision_note            text,
  version                  int NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'SUBMITTED') = (decided_by IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> submitted_by),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id),
  FOREIGN KEY (receipt_evidence_item_id, organisation_id) REFERENCES evidence_item (id, organisation_id)
);
CREATE INDEX fuel_expense_idx ON fuel_expense (organisation_id, spent_on, vehicle_id);
CREATE TRIGGER fuel_expense_version BEFORE UPDATE ON fuel_expense FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicle', 'vehicle_location_history', 'odometer_reading', 'maintenance_plan',
    'maintenance_event', 'equipment_asset', 'inspection_regime', 'vdi_template', 'vdi', 'vdi_item_result',
    'vdi_amendment', 'cleaning_record', 'defect', 'defect_release', 'fuel_expense']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
-- Location-scoped users see vehicles based at their locations.
CREATE POLICY location_scope ON vehicle AS RESTRICTIVE
  USING (app_location_ok(base_location_id)) WITH CHECK (app_location_ok(base_location_id));

GRANT SELECT, INSERT, UPDATE ON vehicle, maintenance_plan, equipment_asset, defect, fuel_expense TO hub_app;
GRANT SELECT, INSERT, UPDATE ON vdi_template TO hub_app;  -- `active` only (trigger)
GRANT SELECT, INSERT ON vehicle_location_history, odometer_reading, maintenance_event, inspection_regime,
  vdi, vdi_item_result, vdi_amendment, cleaning_record, defect_release TO hub_app;  -- immutable
