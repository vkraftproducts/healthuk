-- M3: staff module (HR-01..04). Forward-only.
-- Every tenant table: organisation_id, FORCE RLS, org-leading indexes, composite FKs.
-- Sensitive records (DBS, OH detail, personal data) are additionally hidden by a RESTRICTIVE
-- policy unless the transaction carries `staff.sensitive.view` (SECURITY_COMPLIANCE §3).

CREATE TYPE staff_lifecycle AS ENUM (
  'CANDIDATE', 'CHECKS_IN_PROGRESS', 'READY_FOR_REVIEW', 'APPROVED_FOR_ROLE', 'ACTIVE', 'SUSPENDED', 'LEAVER'
);
CREATE TYPE staff_role AS ENUM (
  'DRIVER', 'CARE_ASSISTANT', 'EMERGENCY_CARE_ASSISTANT', 'TECHNICIAN', 'PARAMEDIC', 'NURSE',
  'CONTROL_ROOM', 'MANAGER', 'OTHER'
);
CREATE TYPE staff_record_kind AS ENUM (
  'REFERENCE', 'DBS', 'RIGHT_TO_WORK', 'LICENCE', 'REGISTRATION', 'TRAINING', 'COMPETENCY',
  'SUPERVISION', 'APPRAISAL', 'OBJECTIVE', 'EMPLOYMENT_HISTORY', 'INDUCTION', 'PROBATION',
  'OH_CLEARANCE', 'OH_DETAIL', 'PERSONAL'
);
CREATE TYPE staff_restriction_type AS ENUM (
  'NO_DRIVING', 'NO_BLUE_LIGHT', 'NO_LONE_WORKING', 'NO_PATIENT_CONTACT', 'NO_CHILDREN',
  'NO_NIGHT_SHIFTS', 'OTHER'
);
CREATE TYPE correction_status AS ENUM ('OPEN', 'APPLIED', 'REJECTED');

-- Permission and location helpers for RLS (values come from transaction-local settings).
CREATE FUNCTION app_has_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p = ANY (string_to_array(coalesce(current_setting('app.permissions', true), ''), ','))
$$;
-- '' = every location in the organisation (membership with location_id NULL).
CREATE FUNCTION app_location_ok(l uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.location_ids', true), '') = ''
      OR l::text = ANY (string_to_array(current_setting('app.location_ids', true), ','))
$$;
GRANT EXECUTE ON FUNCTION app_has_permission(text), app_location_ok(uuid) TO hub_app;

-- ---------------------------------------------------------------------------
CREATE TABLE staff (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  staff_no            text NOT NULL CHECK (staff_no ~ '^ST-[0-9]{4,6}$'),
  user_id             uuid REFERENCES app_user(id),
  display_name        text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  lifecycle_state     staff_lifecycle NOT NULL DEFAULT 'CANDIDATE',
  primary_location_id uuid NOT NULL,
  manager_staff_id    uuid,
  job_title           text CHECK (job_title IS NULL OR length(job_title) <= 120),
  working_pattern     text CHECK (working_pattern IS NULL OR length(working_pattern) <= 120),
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  UNIQUE (organisation_id, staff_no),
  FOREIGN KEY (primary_location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE UNIQUE INDEX staff_org_id_key ON staff (id, organisation_id);
CREATE UNIQUE INDEX staff_user_idx ON staff (organisation_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX staff_lifecycle_idx ON staff (organisation_id, lifecycle_state, display_name);
ALTER TABLE staff ADD CONSTRAINT staff_manager_fk
  FOREIGN KEY (manager_staff_id, organisation_id) REFERENCES staff (id, organisation_id);
CREATE TRIGGER staff_version BEFORE UPDATE ON staff FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Lifecycle state may only change through the transition endpoint, which writes this log.
CREATE TABLE staff_lifecycle_event (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  staff_id        uuid NOT NULL,
  from_state      staff_lifecycle,
  to_state        staff_lifecycle NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  actor_user_id   uuid NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id)
);
CREATE INDEX staff_lifecycle_event_idx ON staff_lifecycle_event (organisation_id, staff_id, at);
CREATE TRIGGER staff_lifecycle_event_immutable BEFORE UPDATE OR DELETE ON staff_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION staff_lifecycle_logged() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state AND NOT EXISTS (
    SELECT 1 FROM staff_lifecycle_event e
     WHERE e.staff_id = NEW.id AND e.to_state = NEW.lifecycle_state
       AND e.from_state IS NOT DISTINCT FROM OLD.lifecycle_state
       -- written by this same transaction
       AND e.xmin::text = ((pg_current_xact_id()::text)::bigint % 4294967296)::text
  ) THEN
    RAISE EXCEPTION 'lifecycle changes must be logged in staff_lifecycle_event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_lifecycle_logged_trg BEFORE UPDATE OF lifecycle_state ON staff
  FOR EACH ROW EXECUTE FUNCTION staff_lifecycle_logged();

-- ---------------------------------------------------------------------------
-- Role approvals: append-only; the only permitted change is a one-time revocation.
CREATE TABLE staff_role_approval (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  staff_id        uuid NOT NULL,
  role            staff_role NOT NULL,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  approved_by     uuid NOT NULL,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid,
  revoke_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX staff_role_approval_idx ON staff_role_approval (organisation_id, staff_id, role);
CREATE UNIQUE INDEX staff_role_approval_active_idx ON staff_role_approval (staff_id, role) WHERE revoked_at IS NULL;

-- Restrictions: append-only; the only permitted change is a one-time lift.
CREATE TABLE staff_restriction (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  staff_id        uuid NOT NULL,
  type            staff_restriction_type NOT NULL,
  detail          text CHECK (detail IS NULL OR length(detail) <= 200),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  applied_by      uuid NOT NULL,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  lifted_at       timestamptz,
  lifted_by       uuid,
  lift_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL))
);
CREATE INDEX staff_restriction_idx ON staff_restriction (organisation_id, staff_id);

CREATE FUNCTION revoke_once_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a jsonb := to_jsonb(OLD);
  b jsonb := to_jsonb(NEW);
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (a ->> TG_ARGV[0]) IS NOT NULL THEN
    RAISE EXCEPTION '% row is already closed', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  -- Only the closing columns (TG_ARGV) may change.
  FOREACH k IN ARRAY TG_ARGV LOOP a := a - k; b := b - k; END LOOP;
  IF a IS DISTINCT FROM b THEN
    RAISE EXCEPTION '% may only be closed, not edited', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_role_approval_guard BEFORE UPDATE OR DELETE ON staff_role_approval
  FOR EACH ROW EXECUTE FUNCTION revoke_once_guard('revoked_at', 'revoked_by', 'revoke_reason');
CREATE TRIGGER staff_restriction_guard BEFORE UPDATE OR DELETE ON staff_restriction
  FOR EACH ROW EXECUTE FUNCTION revoke_once_guard('lifted_at', 'lifted_by', 'lift_reason');

-- ---------------------------------------------------------------------------
-- Staff records: one immutable table, typed payload validated by the API per kind. Corrections
-- create a new record that supersedes the old one (non-negotiable 5).
CREATE TABLE staff_record (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id         uuid NOT NULL,
  staff_id                uuid NOT NULL,
  kind                    staff_record_kind NOT NULL,
  sensitive               boolean GENERATED ALWAYS AS (kind IN ('DBS', 'OH_DETAIL', 'PERSONAL')) STORED,
  data                    jsonb NOT NULL,
  valid_from              date,
  valid_to                date,
  requirement_instance_id uuid,
  supersedes_id           uuid UNIQUE REFERENCES staff_record(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL,
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  FOREIGN KEY (requirement_instance_id, organisation_id) REFERENCES requirement_instance (id, organisation_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CHECK (jsonb_typeof(data) = 'object')
);
CREATE UNIQUE INDEX staff_record_org_id_key ON staff_record (id, organisation_id);
CREATE INDEX staff_record_idx ON staff_record (organisation_id, staff_id, kind, created_at);
CREATE TRIGGER staff_record_immutable BEFORE UPDATE OR DELETE ON staff_record
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION staff_record_supersede_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM staff_record r
     WHERE r.id = NEW.supersedes_id AND r.staff_id = NEW.staff_id AND r.kind = NEW.kind
       AND r.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'a correction must supersede a record of the same staff member and kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_record_supersede_trg BEFORE INSERT ON staff_record
  FOR EACH ROW EXECUTE FUNCTION staff_record_supersede_check();

-- Which requirement templates each staff role needs (HR-03 recalculation).
CREATE TABLE role_requirement (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL REFERENCES organisation(id),
  role            staff_role NOT NULL,
  template_id     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  UNIQUE (organisation_id, role, template_id),
  FOREIGN KEY (template_id, organisation_id) REFERENCES requirement_template (id, organisation_id)
);

-- Staff self-service correction requests (the requester never edits the record directly).
CREATE TABLE staff_correction_request (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  staff_id        uuid NOT NULL,
  field           text NOT NULL CHECK (length(field) BETWEEN 1 AND 60),
  proposed_value  text NOT NULL CHECK (length(proposed_value) BETWEEN 1 AND 500),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  status          correction_status NOT NULL DEFAULT 'OPEN',
  requested_by    uuid NOT NULL,
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text,
  version         int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK ((status = 'OPEN') = (decided_by IS NULL))
);
CREATE INDEX staff_correction_idx ON staff_correction_request (organisation_id, status, created_at);
CREATE TRIGGER staff_correction_version BEFORE UPDATE ON staff_correction_request
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
ALTER TABLE staff                    ENABLE ROW LEVEL SECURITY; ALTER TABLE staff                    FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_lifecycle_event    ENABLE ROW LEVEL SECURITY; ALTER TABLE staff_lifecycle_event    FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_role_approval      ENABLE ROW LEVEL SECURITY; ALTER TABLE staff_role_approval      FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_restriction        ENABLE ROW LEVEL SECURITY; ALTER TABLE staff_restriction        FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_record             ENABLE ROW LEVEL SECURITY; ALTER TABLE staff_record             FORCE ROW LEVEL SECURITY;
ALTER TABLE role_requirement         ENABLE ROW LEVEL SECURITY; ALTER TABLE role_requirement         FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_correction_request ENABLE ROW LEVEL SECURITY; ALTER TABLE staff_correction_request FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON staff
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
-- Location-scoped users see staff based at their locations, plus their own record.
CREATE POLICY location_scope ON staff AS RESTRICTIVE
  USING (app_location_ok(primary_location_id) OR user_id = app_user_id())
  WITH CHECK (app_location_ok(primary_location_id));
CREATE POLICY tenant_isolation ON staff_lifecycle_event
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON staff_role_approval
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON staff_restriction
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON staff_record
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY sensitive_records ON staff_record AS RESTRICTIVE
  USING (NOT sensitive OR app_has_permission('staff.sensitive.view'))
  WITH CHECK (kind NOT IN ('DBS', 'OH_DETAIL', 'PERSONAL') OR app_has_permission('staff.sensitive.view'));
CREATE POLICY tenant_isolation ON role_requirement
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON staff_correction_request
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT, UPDATE ON staff TO hub_app;
GRANT SELECT, INSERT ON staff_lifecycle_event, staff_record TO hub_app;              -- immutable
GRANT SELECT, INSERT, UPDATE ON staff_role_approval, staff_restriction TO hub_app;    -- close-once (trigger)
GRANT SELECT, INSERT, DELETE ON role_requirement TO hub_app;                          -- configuration
GRANT SELECT, INSERT, UPDATE ON staff_correction_request TO hub_app;
