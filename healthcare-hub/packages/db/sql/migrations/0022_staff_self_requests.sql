-- Task 25: staff self-service requests from "My record".
-- A member of staff asks; someone else decides. A due-date change is only applied when another
-- person with compliance.due_date.change accepts it (through the normal due_date_change log).
-- Asking for a review or booking supervision never changes any status by itself.

CREATE TABLE staff_self_request (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id       uuid NOT NULL REFERENCES organisation(id),
  staff_id              uuid NOT NULL REFERENCES staff(id),
  kind                  text NOT NULL CHECK (kind IN ('DUE_DATE_CHANGE', 'REVIEW', 'SUPERVISION')),
  instance_id           uuid,
  proposed_date         date,
  supervisor_user_id    uuid,
  reason                text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  status                text NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN', 'ACCEPTED', 'DECLINED', 'WITHDRAWN')),
  requested_by          uuid NOT NULL,
  decided_by            uuid,
  decided_at            timestamptz,
  decision_note         text CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  booked_for            timestamptz,
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (instance_id, organisation_id) REFERENCES requirement_instance (id, organisation_id),
  CHECK (kind = 'SUPERVISION' OR instance_id IS NOT NULL),
  CHECK (kind <> 'DUE_DATE_CHANGE' OR (proposed_date IS NOT NULL AND length(reason) >= 10)),
  CHECK (kind <> 'SUPERVISION' OR proposed_date IS NOT NULL),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status IN ('ACCEPTED', 'DECLINED')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'DECLINED' OR decision_note IS NOT NULL),
  CHECK (booked_for IS NULL OR (kind = 'SUPERVISION' AND status = 'ACCEPTED')),
  CHECK (kind <> 'SUPERVISION' OR status <> 'ACCEPTED' OR booked_for IS NOT NULL)
);
CREATE INDEX staff_self_request_staff_idx ON staff_self_request (organisation_id, staff_id, created_at DESC);
CREATE INDEX staff_self_request_open_idx ON staff_self_request (organisation_id, status, kind);
CREATE UNIQUE INDEX staff_self_request_one_open ON staff_self_request (staff_id, kind, instance_id)
  WHERE status = 'OPEN' AND instance_id IS NOT NULL;

-- Decided and withdrawn requests are history: they cannot change again.
CREATE OR REPLACE FUNCTION staff_self_request_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'staff_self_request % is %, it cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.staff_id <> OLD.staff_id OR NEW.kind <> OLD.kind
     OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'staff_self_request % keeps who asked and what for', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_self_request_frozen BEFORE UPDATE ON staff_self_request
  FOR EACH ROW EXECUTE FUNCTION staff_self_request_frozen();
CREATE TRIGGER staff_self_request_version BEFORE UPDATE ON staff_self_request
  FOR EACH ROW EXECUTE FUNCTION bump_version();

ALTER TABLE staff_self_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_self_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_self_request
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON staff_self_request TO hub_app;   -- no deletes: history is kept
