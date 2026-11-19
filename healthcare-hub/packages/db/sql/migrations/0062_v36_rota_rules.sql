-- v36 front end ↔ real tables, staff area part 2 (step 2, 19 Nov 2026): the person-level rota
-- (S.rota), shift swaps, working-time exceptions, group training sessions, and the organisation's
-- working rules with their two-person change (S.rules, S.ruleProp).
--
-- Every v36 register table has the same frame: organisation (RLS forced), v36's reference in
-- `code` (unique per organisation), `extra` for values a typed column cannot hold (so a record
-- loads back exactly as v36 wrote it), who created it, and a version bumped on every change.

CREATE OR REPLACE FUNCTION v36_register_secure(t text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE UNIQUE INDEX %I ON %I (organisation_id, code)', t || '_org_code_uidx', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bump_version()', t || '_version', t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hub_app', t);
END $$;

-- S.rota: one person's shift (v36 plans people, not vehicles; a shift may have no vehicle).
CREATE TABLE rota_shift (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL CHECK (length(code) BETWEEN 2 AND 20),
  staff_id         uuid REFERENCES staff(id),
  shift_date       date,
  start_time       text CHECK (start_time ~ '^\d{2}:\d{2}$'),
  end_time         text CHECK (end_time ~ '^\d{2}:\d{2}$'),
  drive_hours      numeric CHECK (drive_hours BETWEEN 0 AND 24),
  vehicle_id       uuid REFERENCES vehicle(id),
  pattern          text CHECK (pattern IN ('E', 'D', 'L', 'N', 'Custom')),
  break_minutes    numeric CHECK (break_minutes BETWEEN 0 AND 600),
  state            text CHECK (state IN ('Planned', 'Started', 'On break', 'Ended')),
  actual           jsonb CHECK (actual IS NULL OR jsonb_typeof(actual) = 'object'),
  extra            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rota_shift_day_idx ON rota_shift (organisation_id, shift_date, staff_id);
SELECT v36_register_secure('rota_shift');

-- S.swaps: crew ask to swap shifts; the colleague agrees; dispatch or a manager decides.
CREATE TABLE rota_swap (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL CHECK (length(code) BETWEEN 2 AND 20),
  from_staff_id    uuid REFERENCES staff(id),
  to_staff_id      uuid REFERENCES staff(id),
  from_shift       text,
  to_shift         text,
  requested_on     date,
  reason           text CHECK (reason IS NULL OR length(reason) <= 500),
  state            text CHECK (state IN ('Requested', 'Colleague agreed', 'Approved', 'Refused')),
  note             text CHECK (note IS NULL OR length(note) <= 500),
  extra            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT v36_register_secure('rota_swap');

-- S.rotaEx: a working-time exception approved for one shift (decision D1: RM or Director).
CREATE TABLE rota_exception (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL CHECK (length(code) BETWEEN 2 AND 20),
  shift_code       text,
  approved_by      uuid REFERENCES app_user(id),
  approved_by_name text,
  reason           text CHECK (reason IS NULL OR length(reason) <= 1000),
  until_on         date,
  approved_on      date,
  extra            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT v36_register_secure('rota_exception');

-- S.sessions: group training recorded from one signed register, verified by a second person.
CREATE TABLE training_session (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL CHECK (length(code) BETWEEN 2 AND 20),
  course           text,
  held_on          date,
  provider         text CHECK (provider IS NULL OR length(provider) <= 200),
  register_ref     text CHECK (register_ref IS NULL OR length(register_ref) <= 100),
  attendee_ids     uuid[],
  recorded_by      uuid REFERENCES app_user(id),
  recorded_by_name text,
  recorded_at      text,
  state            text CHECK (state IN ('Awaiting verification', 'Verified', 'Rejected')),
  verified_by      uuid REFERENCES app_user(id),
  verified_by_name text,
  verified_at      text,
  reject_reason    text CHECK (reject_reason IS NULL OR length(reject_reason) <= 1000),
  extra            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (verified_by IS NULL OR recorded_by IS NULL OR verified_by <> recorded_by)
);
SELECT v36_register_secure('training_session');

-- S.rules: the organisation's working rules (rest, hours, driving, DVLA intervals, IPC block,
-- complaint days). Changed only by a second person approving a proposal.
CREATE TABLE org_rule (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL CHECK (code ~ '^[A-Za-z]{2,30}$'),
  value            jsonb,
  set_by           uuid REFERENCES app_user(id),
  set_by_name      text,
  set_on           date,
  confirmed        boolean,
  extra            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT v36_register_secure('org_rule');

CREATE TABLE org_rule_proposal (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  code             text NOT NULL CHECK (length(code) BETWEEN 2 AND 20),
  rule_key         text,
  old_value        jsonb,
  new_value        jsonb,
  reason           text CHECK (reason IS NULL OR length(reason) <= 1000),
  proposed_by      uuid REFERENCES app_user(id),
  proposed_by_name text,
  proposed_on      date,
  state            text CHECK (state IN ('Proposed', 'Approved', 'Rejected')),
  decided_by       uuid REFERENCES app_user(id),
  decided_by_name  text,
  extra            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (decided_by IS NULL OR proposed_by IS NULL OR decided_by <> proposed_by)
);
SELECT v36_register_secure('org_rule_proposal');
