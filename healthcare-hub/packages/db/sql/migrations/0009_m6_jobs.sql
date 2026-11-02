-- M6: bookings, jobs, shifts, crew, allocation (JOB-01..04). Forward-only.
-- Double booking is prevented by the database (exclusion constraints), not only by the API.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE job_state AS ENUM (
  'BOOKED', 'ASSESSED', 'ALLOCATED', 'OFFERED', 'ACKNOWLEDGED', 'EN_ROUTE', 'ARRIVED', 'PATIENT_ON_BOARD',
  'AT_DESTINATION', 'HANDOVER_COMPLETE', 'COMPLETED', 'CANCELLED', 'REFUSED', 'NO_ACCESS', 'ABORTED', 'REASSIGNED'
);
CREATE TYPE mobility AS ENUM ('WALKING', 'WHEELCHAIR', 'STRETCHER', 'CARRY_CHAIR');
CREATE TYPE shift_state AS ENUM ('PLANNED', 'STARTED', 'ENDED', 'CANCELLED');

CREATE TABLE booking (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  customer        text NOT NULL CHECK (length(customer) BETWEEN 2 AND 120),
  reference       text CHECK (reference IS NULL OR length(reference) <= 60),
  recurrence      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid
);
CREATE UNIQUE INDEX booking_org_id_key ON booking (id, organisation_id);

CREATE TABLE job (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id       uuid NOT NULL,
  code                  text NOT NULL,
  booking_id            uuid NOT NULL,
  series_index          int,
  detached              boolean NOT NULL DEFAULT false,
  location_id           uuid NOT NULL,
  journey_date          date NOT NULL,
  pickup_from           timestamptz NOT NULL,
  pickup_to             timestamptz NOT NULL,
  appointment_at        timestamptz,
  planned_start         timestamptz NOT NULL,
  planned_end           timestamptz NOT NULL,
  pickup_address        text NOT NULL CHECK (length(pickup_address) BETWEEN 3 AND 300),
  destination_address   text NOT NULL CHECK (length(destination_address) BETWEEN 3 AND 300),
  access_notes          text CHECK (access_notes IS NULL OR length(access_notes) <= 500),
  access_plan_reviewed  boolean NOT NULL DEFAULT false,
  -- Minimal identifier only (e.g. booking system reference); names and phone numbers live in patient_contact.
  patient_ref           text NOT NULL CHECK (patient_ref ~ '^[A-Za-z0-9\-]{2,30}$'),
  mobility              mobility NOT NULL,
  weight_kg             int CHECK (weight_kg IS NULL OR weight_kg BETWEEN 1 AND 500),
  stairs                boolean NOT NULL DEFAULT false,
  escorts               int NOT NULL DEFAULT 0 CHECK (escorts BETWEEN 0 AND 4),
  infection_precautions boolean NOT NULL DEFAULT false,
  comms_needs           text CHECK (comms_needs IS NULL OR length(comms_needs) <= 200),
  required_equipment    text[] NOT NULL DEFAULT '{}',
  required_skills       text[] NOT NULL DEFAULT '{}',
  crew_size             int NOT NULL DEFAULT 2 CHECK (crew_size BETWEEN 1 AND 4),
  state                 job_state NOT NULL DEFAULT 'BOOKED',
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK (pickup_to > pickup_from),
  CHECK (planned_end > planned_start),
  FOREIGN KEY (booking_id, organisation_id) REFERENCES booking (id, organisation_id),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE UNIQUE INDEX job_org_id_key ON job (id, organisation_id);
CREATE INDEX job_day_idx ON job (organisation_id, journey_date, state);
CREATE TRIGGER job_version BEFORE UPDATE ON job FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Restricted patient contact (jobs.patient.view); never in logs, push or URLs.
CREATE TABLE patient_contact (
  job_id          uuid PRIMARY KEY,
  organisation_id uuid NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  phone           text CHECK (phone IS NULL OR length(phone) <= 30),
  FOREIGN KEY (job_id, organisation_id) REFERENCES job (id, organisation_id)
);

CREATE TABLE shift (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  location_id     uuid NOT NULL,
  vehicle_id      uuid NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  state           shift_state NOT NULL DEFAULT 'PLANNED',
  started_at      timestamptz,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '16 hours'),
  FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id)
);
CREATE UNIQUE INDEX shift_org_id_key ON shift (id, organisation_id);
CREATE INDEX shift_day_idx ON shift (organisation_id, starts_at);
CREATE TRIGGER shift_version BEFORE UPDATE ON shift FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Time-bounded crew assignment; a vehicle is never permanently tied to a person.
CREATE TABLE crew_assignment (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  shift_id        uuid NOT NULL,
  staff_id        uuid NOT NULL,
  role            staff_role NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  period          tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  active          boolean NOT NULL DEFAULT true,
  ended_reason    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  FOREIGN KEY (shift_id, organisation_id) REFERENCES shift (id, organisation_id),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX crew_assignment_idx ON crew_assignment (organisation_id, shift_id);

-- One row per resource per period; overlapping rows for the same resource are impossible.
CREATE TABLE resource_booking (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  resource_type   text NOT NULL CHECK (resource_type IN ('VEHICLE', 'STAFF')),
  resource_id     uuid NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  period          tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  source_type     text NOT NULL CHECK (source_type IN ('SHIFT', 'CREW')),
  source_id       uuid NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CONSTRAINT resource_booking_no_overlap EXCLUDE USING gist
    (organisation_id WITH =, resource_type WITH =, resource_id WITH =, period WITH &&) WHERE (active)
);

CREATE TABLE job_allocation (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id   uuid NOT NULL,
  job_id            uuid NOT NULL,
  shift_id          uuid NOT NULL,
  -- Planned job window plus travel buffer: two jobs on one shift cannot overlap.
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  period            tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  active            boolean NOT NULL DEFAULT true,
  validated_at      timestamptz NOT NULL,
  validation_result jsonb NOT NULL,
  exception_ids     uuid[] NOT NULL DEFAULT '{}',
  allocated_by      uuid NOT NULL,
  released_at       timestamptz,
  release_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, organisation_id) REFERENCES job (id, organisation_id),
  FOREIGN KEY (shift_id, organisation_id) REFERENCES shift (id, organisation_id),
  CHECK (active OR released_at IS NOT NULL),
  CHECK (ends_at > starts_at),
  CONSTRAINT job_allocation_no_overlap EXCLUDE USING gist (shift_id WITH =, period WITH &&) WHERE (active)
);
CREATE UNIQUE INDEX job_allocation_one_active ON job_allocation (job_id) WHERE active;
CREATE INDEX job_allocation_shift_idx ON job_allocation (organisation_id, shift_id) WHERE active;

-- Policy-level exceptions only (no row can exist for a statutory/safety check: the API refuses).
CREATE TABLE allocation_exception (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  job_id          uuid NOT NULL,
  check_code      text NOT NULL CHECK (check_code = 'COMPETENCE'),
  approver_id     uuid NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, organisation_id) REFERENCES job (id, organisation_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);
CREATE TRIGGER allocation_exception_immutable BEFORE UPDATE OR DELETE ON allocation_exception FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE job_status_event (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id      uuid NOT NULL,
  job_id               uuid NOT NULL,
  from_state           job_state,
  to_state             job_state NOT NULL,
  actor_user_id        uuid NOT NULL,
  captured_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL DEFAULT now(),
  reason               text CHECK (reason IS NULL OR length(reason) <= 500),
  client_submission_id uuid,
  UNIQUE (organisation_id, client_submission_id),
  FOREIGN KEY (job_id, organisation_id) REFERENCES job (id, organisation_id)
);
CREATE INDEX job_status_event_idx ON job_status_event (organisation_id, job_id, received_at);
CREATE TRIGGER job_status_event_immutable BEFORE UPDATE OR DELETE ON job_status_event FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Shift history (vehicle swaps, crew changes) is append-only (UAT-07).
CREATE TABLE shift_change (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  shift_id        uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('CREATED', 'VEHICLE_SWAP', 'CREW_ADD', 'CREW_END', 'STARTED', 'ENDED', 'CANCELLED')),
  details         jsonb NOT NULL DEFAULT '{}',
  reason          text,
  by_user_id      uuid NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organisation_id) REFERENCES shift (id, organisation_id)
);
CREATE TRIGGER shift_change_immutable BEFORE UPDATE OR DELETE ON shift_change FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Link VDIs and cleaning records to shifts now that shifts exist.
ALTER TABLE vdi ADD CONSTRAINT vdi_shift_fk FOREIGN KEY (shift_id, organisation_id) REFERENCES shift (id, organisation_id);
ALTER TABLE cleaning_record ADD CONSTRAINT cleaning_shift_fk FOREIGN KEY (shift_id, organisation_id) REFERENCES shift (id, organisation_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['booking', 'job', 'patient_contact', 'shift', 'crew_assignment', 'resource_booking',
    'job_allocation', 'allocation_exception', 'job_status_event', 'shift_change']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
CREATE POLICY patient_restricted ON patient_contact AS RESTRICTIVE
  USING (app_has_permission('jobs.patient.view'))
  WITH CHECK (app_has_permission('jobs.patient.view') OR app_has_permission('jobs.booking.manage'));
CREATE POLICY location_scope ON job AS RESTRICTIVE USING (app_location_ok(location_id)) WITH CHECK (app_location_ok(location_id));
CREATE POLICY location_scope ON shift AS RESTRICTIVE USING (app_location_ok(location_id)) WITH CHECK (app_location_ok(location_id));

GRANT SELECT, INSERT ON booking, patient_contact TO hub_app;
GRANT SELECT, INSERT, UPDATE ON job, shift, crew_assignment, resource_booking, job_allocation TO hub_app;
GRANT SELECT, INSERT ON allocation_exception, job_status_event, shift_change TO hub_app;  -- immutable

-- Job codes are J-117 style (one-letter prefix).
ALTER TABLE org_counter DROP CONSTRAINT org_counter_prefix_check;
ALTER TABLE org_counter ADD CONSTRAINT org_counter_prefix_check CHECK (prefix ~ '^[A-Z]{1,5}$');
