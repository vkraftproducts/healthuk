-- v36 batch 3 (17 Nov 2026): open shifts, shift swaps, hours worked (planned against actual) and
-- shift patterns. Forward-only and additive: shifts and crew assignments are unchanged; filling an
-- open shift or approving a swap writes crew assignments the same way the planner does.

-- ---------------------------------------------------------------------------------------------
-- Open shifts: a gap on a planned shift that staff can offer to cover.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE open_shift (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id       uuid NOT NULL,
  code                  text NOT NULL,
  shift_id              uuid NOT NULL,
  role                  staff_role NOT NULL,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  note                  text CHECK (note IS NULL OR length(note) BETWEEN 3 AND 500),
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FILLED', 'CANCELLED')),
  posted_by             uuid NOT NULL,
  filled_staff_id       uuid,
  filled_assignment_id  uuid REFERENCES crew_assignment(id),
  filled_by             uuid,
  filled_at             timestamptz,
  cancel_reason         text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 3 AND 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  version               int NOT NULL DEFAULT 1,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  FOREIGN KEY (shift_id, organisation_id) REFERENCES shift (id, organisation_id),
  FOREIGN KEY (filled_staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (ends_at > starts_at),
  CHECK ((status = 'FILLED') = (filled_staff_id IS NOT NULL AND filled_assignment_id IS NOT NULL
                                AND filled_by IS NOT NULL AND filled_at IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE INDEX open_shift_idx ON open_shift (organisation_id, status, starts_at);
CREATE TRIGGER open_shift_version BEFORE UPDATE ON open_shift FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE FUNCTION open_shift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'a filled or cancelled open shift cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.shift_id, NEW.role, NEW.starts_at, NEW.ends_at, NEW.posted_by) IS DISTINCT FROM
     (OLD.shift_id, OLD.role, OLD.starts_at, OLD.ends_at, OLD.posted_by) THEN
    RAISE EXCEPTION 'the open shift cannot be changed; cancel it and post a new one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER open_shift_guard BEFORE UPDATE ON open_shift FOR EACH ROW EXECUTE FUNCTION open_shift_guard();
CREATE TRIGGER open_shift_no_delete BEFORE DELETE ON open_shift FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Who offered to cover it. Withdrawing keeps the row.
CREATE TABLE open_shift_offer (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  open_shift_id   uuid NOT NULL REFERENCES open_shift(id),
  staff_id        uuid NOT NULL,
  offered_by      uuid NOT NULL,
  offered_at      timestamptz NOT NULL DEFAULT now(),
  withdrawn_at    timestamptz,
  UNIQUE (open_shift_id, staff_id),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id)
);
CREATE INDEX open_shift_offer_idx ON open_shift_offer (organisation_id, open_shift_id);
CREATE FUNCTION open_shift_offer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.open_shift_id, NEW.staff_id, NEW.offered_by, NEW.offered_at) IS DISTINCT FROM
     (OLD.open_shift_id, OLD.staff_id, OLD.offered_by, OLD.offered_at)
     OR OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'an offer can only be withdrawn, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER open_shift_offer_guard BEFORE UPDATE ON open_shift_offer
  FOR EACH ROW EXECUTE FUNCTION open_shift_offer_guard();
CREATE TRIGGER open_shift_offer_no_delete BEFORE DELETE ON open_shift_offer
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Shift swaps: a crew member asks to swap a planned assignment with a colleague's; the colleague
-- agrees; control or a manager approves (never the person who asked).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE shift_swap_request (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id      uuid NOT NULL,
  code                 text NOT NULL,
  from_assignment_id   uuid NOT NULL REFERENCES crew_assignment(id),
  to_assignment_id     uuid NOT NULL REFERENCES crew_assignment(id),
  from_staff_id        uuid NOT NULL,
  to_staff_id          uuid NOT NULL,
  reason               text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  status               text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'AGREED',
                         'DECLINED', 'APPROVED', 'REFUSED', 'WITHDRAWN')),
  requested_by         uuid NOT NULL,
  agreed_at            timestamptz,
  declined_at          timestamptz,
  decided_by           uuid,
  decided_at           timestamptz,
  decision_note        text CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 3 AND 500),
  warnings             jsonb NOT NULL DEFAULT '[]',
  created_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  FOREIGN KEY (from_staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  FOREIGN KEY (to_staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (from_assignment_id <> to_assignment_id),
  CHECK (from_staff_id <> to_staff_id),
  CHECK (status NOT IN ('APPROVED', 'REFUSED') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (status <> 'APPROVED' OR agreed_at IS NOT NULL),
  CHECK (status <> 'REFUSED' OR decision_note IS NOT NULL)
);
CREATE INDEX shift_swap_request_idx ON shift_swap_request (organisation_id, status, created_at);
CREATE UNIQUE INDEX shift_swap_open_from_key ON shift_swap_request (organisation_id, from_assignment_id)
  WHERE status IN ('REQUESTED', 'AGREED');
CREATE TRIGGER shift_swap_request_version BEFORE UPDATE ON shift_swap_request
  FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE FUNCTION shift_swap_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('DECLINED', 'APPROVED', 'REFUSED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'this swap is already decided' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.from_assignment_id, NEW.to_assignment_id, NEW.from_staff_id, NEW.to_staff_id, NEW.reason,
      NEW.requested_by) IS DISTINCT FROM (OLD.from_assignment_id, OLD.to_assignment_id, OLD.from_staff_id,
      OLD.to_staff_id, OLD.reason, OLD.requested_by) THEN
    RAISE EXCEPTION 'the swap itself cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shift_swap_request_guard BEFORE UPDATE ON shift_swap_request
  FOR EACH ROW EXECUTE FUNCTION shift_swap_request_guard();
CREATE TRIGGER shift_swap_request_no_delete BEFORE DELETE ON shift_swap_request
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Hours worked: actual start, end and breaks against a crew assignment. Crew clock in and out on
-- the phone; a manager corrects with a new entry that supersedes the old one (history kept).
-- This is not a pay calculation (payroll is out of scope).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE shift_time_entry (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  assignment_id    uuid NOT NULL REFERENCES crew_assignment(id),
  shift_id         uuid NOT NULL,
  staff_id         uuid NOT NULL,
  clock_in         timestamptz NOT NULL,
  clock_out        timestamptz,
  break_minutes    int NOT NULL DEFAULT 0 CHECK (break_minutes BETWEEN 0 AND 600),
  source           text NOT NULL CHECK (source IN ('CREW_APP', 'MANAGER')),
  supersedes_id    uuid REFERENCES shift_time_entry(id),
  reason           text CHECK (reason IS NULL OR length(reason) BETWEEN 3 AND 500),
  recorded_by      uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shift_id, organisation_id) REFERENCES shift (id, organisation_id),
  FOREIGN KEY (staff_id, organisation_id) REFERENCES staff (id, organisation_id),
  CHECK (clock_out IS NULL OR clock_out > clock_in),
  CHECK (clock_out IS NULL OR clock_out - clock_in <= interval '24 hours'),
  -- A manager's entry (a correction, or recording for someone) always says why.
  CHECK ((source = 'MANAGER') = (reason IS NOT NULL)),
  CHECK (supersedes_id IS NULL OR source = 'MANAGER'),
  CHECK (source = 'CREW_APP' OR clock_out IS NOT NULL)
);
CREATE UNIQUE INDEX shift_time_entry_first_key ON shift_time_entry (organisation_id, assignment_id)
  WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX shift_time_entry_supersedes_key ON shift_time_entry (supersedes_id)
  WHERE supersedes_id IS NOT NULL;
CREATE INDEX shift_time_entry_idx ON shift_time_entry (organisation_id, staff_id, clock_in);
-- Only an open entry's clock-out and breaks may be filled in, once.
CREATE FUNCTION shift_time_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.clock_out IS NOT NULL
     OR (NEW.organisation_id, NEW.assignment_id, NEW.shift_id, NEW.staff_id, NEW.clock_in, NEW.source,
         NEW.supersedes_id, NEW.reason, NEW.recorded_by)
        IS DISTINCT FROM (OLD.organisation_id, OLD.assignment_id, OLD.shift_id, OLD.staff_id, OLD.clock_in,
         OLD.source, OLD.supersedes_id, OLD.reason, OLD.recorded_by) THEN
    RAISE EXCEPTION 'a time entry is corrected with a new entry, not changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shift_time_entry_guard BEFORE UPDATE ON shift_time_entry
  FOR EACH ROW EXECUTE FUNCTION shift_time_entry_guard();
CREATE TRIGGER shift_time_entry_no_delete BEFORE DELETE ON shift_time_entry
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Shift patterns: named start/end times, paid break and a rotation (days on, days off) used to
-- plan shifts. Retired patterns are kept.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE shift_pattern (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id    uuid NOT NULL,
  code               text NOT NULL CHECK (code ~ '^[A-Z0-9]{1,6}$'),
  name               text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  start_time         text NOT NULL CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time           text NOT NULL CHECK (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  paid_break_minutes int NOT NULL DEFAULT 0 CHECK (paid_break_minutes BETWEEN 0 AND 180),
  on_days            int NOT NULL CHECK (on_days BETWEEN 1 AND 14),
  off_days           int NOT NULL CHECK (off_days BETWEEN 0 AND 14),
  active             boolean NOT NULL DEFAULT true,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_by         uuid,
  retired_at         timestamptz,
  version            int NOT NULL DEFAULT 1,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time <> end_time),
  CHECK (active = (retired_at IS NULL) AND (retired_at IS NULL) = (retired_by IS NULL))
);
CREATE UNIQUE INDEX shift_pattern_code_key ON shift_pattern (organisation_id, code) WHERE active;
CREATE TRIGGER shift_pattern_version BEFORE UPDATE ON shift_pattern
  FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE FUNCTION shift_pattern_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.active OR (NEW.code, NEW.name, NEW.start_time, NEW.end_time, NEW.paid_break_minutes,
      NEW.on_days, NEW.off_days, NEW.created_by) IS DISTINCT FROM (OLD.code, OLD.name, OLD.start_time,
      OLD.end_time, OLD.paid_break_minutes, OLD.on_days, OLD.off_days, OLD.created_by) THEN
    RAISE EXCEPTION 'a pattern is retired and replaced, not changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shift_pattern_guard BEFORE UPDATE ON shift_pattern
  FOR EACH ROW EXECUTE FUNCTION shift_pattern_guard();
CREATE TRIGGER shift_pattern_no_delete BEFORE DELETE ON shift_pattern
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['open_shift', 'open_shift_offer', 'shift_swap_request', 'shift_time_entry',
                           'shift_pattern'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON open_shift, open_shift_offer, shift_swap_request, shift_time_entry,
  shift_pattern TO hub_app;
