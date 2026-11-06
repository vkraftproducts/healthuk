-- Workflows C1-C3 (6 Nov 2026). Forward-only.

-- C1: course catalogue. HR adds a course with its interval and basis; records pick from it (no
-- free-text course codes). A course is retired, never deleted.
CREATE TABLE training_course (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  title               text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  interval_months     int CHECK (interval_months IS NULL OR interval_months BETWEEN 1 AND 120),
  basis               text NOT NULL CHECK (basis IN ('STATUTORY', 'REGULATORY_GUIDANCE', 'ORG_POLICY', 'GOOD_PRACTICE')),
  basis_note          text CHECK (basis_note IS NULL OR length(basis_note) <= 300),
  deployment_critical boolean NOT NULL DEFAULT false,
  retired_at          timestamptz,
  retired_by          uuid,
  retire_reason       text CHECK (retire_reason IS NULL OR length(retire_reason) BETWEEN 3 AND 500),
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK ((retired_at IS NULL) = (retire_reason IS NULL))
);
CREATE TRIGGER training_course_version BEFORE UPDATE ON training_course
  FOR EACH ROW EXECUTE FUNCTION bump_version();
ALTER TABLE training_course ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_course FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON training_course
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON training_course TO hub_app;

-- C2: supervision bookings. Held sessions link to the immutable SUPERVISION staff record; a
-- cancelled or missed booking keeps its reason and may point to the booking that replaced it.
CREATE TABLE supervision_booking (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  staff_id            uuid NOT NULL REFERENCES staff(id),
  supervisor_user_id  uuid NOT NULL,
  scheduled_at        timestamptz NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('ONE_TO_ONE', 'CLINICAL', 'RETURN_TO_WORK', 'PROBATION_REVIEW')),
  topics              text CHECK (topics IS NULL OR length(topics) <= 1000),
  status              text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED', 'HELD', 'CANCELLED', 'MISSED')),
  status_reason       text CHECK (status_reason IS NULL OR length(status_reason) BETWEEN 3 AND 500),
  record_id           uuid REFERENCES staff_record(id),
  rebooked_as         uuid REFERENCES supervision_booking(id),
  booked_by           uuid NOT NULL,
  closed_by           uuid,
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('CANCELLED', 'MISSED') OR status_reason IS NOT NULL),
  CHECK (status <> 'HELD' OR record_id IS NOT NULL),
  CHECK ((status = 'BOOKED') = (closed_by IS NULL))
);
CREATE INDEX supervision_booking_idx ON supervision_booking (organisation_id, staff_id, scheduled_at);
CREATE INDEX supervision_booking_sup_idx ON supervision_booking (organisation_id, supervisor_user_id, status);
CREATE TRIGGER supervision_booking_version BEFORE UPDATE ON supervision_booking
  FOR EACH ROW EXECUTE FUNCTION bump_version();
ALTER TABLE supervision_booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE supervision_booking FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supervision_booking
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON supervision_booking TO hub_app;

-- C2/C3: the staff member acknowledges or comments on a supervision or appraisal record.
-- Append-only: a later comment is a new row.
CREATE TABLE staff_record_ack (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  record_id       uuid NOT NULL REFERENCES staff_record(id),
  staff_id        uuid NOT NULL REFERENCES staff(id),
  user_id         uuid NOT NULL,
  agreed          boolean NOT NULL,
  comment         text CHECK (comment IS NULL OR length(comment) BETWEEN 3 AND 2000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (agreed OR comment IS NOT NULL)
);
CREATE INDEX staff_record_ack_idx ON staff_record_ack (organisation_id, record_id);
CREATE TRIGGER staff_record_ack_immutable
  BEFORE UPDATE OR DELETE ON staff_record_ack FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE staff_record_ack ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_record_ack FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_record_ack
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT ON staff_record_ack TO hub_app;
