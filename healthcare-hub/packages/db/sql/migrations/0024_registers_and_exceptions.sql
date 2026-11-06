-- Task 15 / 26 follow-up (defect register findings 13, 39-45, 67-71). Forward-only.

-- Gross vehicle weight decides the licence needed (B up to 3,500 kg, C1 up to 7,500 kg).
ALTER TABLE vehicle ADD COLUMN gross_weight_kg int
  CHECK (gross_weight_kg IS NULL OR gross_weight_kg BETWEEN 500 AND 44000);

-- A dispatcher asks for a policy exception; a different person with
-- allocation.exception.approve decides. Statutory and safety checks are refused by the API before
-- a request is stored. Once decided, a request cannot change.
CREATE TABLE allocation_exception_request (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  job_id           uuid NOT NULL REFERENCES job(id),
  shift_id         uuid NOT NULL REFERENCES shift(id),
  check_code       text NOT NULL,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  expires_at       timestamptz NOT NULL,
  requested_by     uuid NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'REQUESTED'
                   CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED')),
  decided_by       uuid,
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  exception_id     uuid REFERENCES allocation_exception(id),
  CHECK ((status = 'REQUESTED') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'APPROVED') = (exception_id IS NOT NULL))
);
CREATE INDEX allocation_exception_request_idx
  ON allocation_exception_request (organisation_id, status, requested_at DESC);

CREATE FUNCTION allocation_exception_request_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'exception requests are kept' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a decided exception request cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.organisation_id, NEW.job_id, NEW.shift_id, NEW.check_code, NEW.reason, NEW.expires_at,
      NEW.requested_by, NEW.requested_at) IS DISTINCT FROM
     (OLD.organisation_id, OLD.job_id, OLD.shift_id, OLD.check_code, OLD.reason, OLD.expires_at,
      OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'only the decision can be recorded on a request'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_exception_request_frozen
  BEFORE UPDATE OR DELETE ON allocation_exception_request
  FOR EACH ROW EXECUTE FUNCTION allocation_exception_request_frozen();

ALTER TABLE allocation_exception_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_exception_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON allocation_exception_request
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON allocation_exception_request TO hub_app;
