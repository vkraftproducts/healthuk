-- E3: a dispatcher asks a named approver for a policy exception; the approver decides. Both the
-- request and the decision are append-only. Only an approval creates an allocation_exception, so
-- allocation checks are unchanged. Statutory and safety checks still have no path at all.
CREATE TABLE allocation_exception_request (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  job_id          uuid NOT NULL,
  shift_id        uuid NOT NULL,
  check_code      text NOT NULL CHECK (check_code = 'COMPETENCE'),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  expires_at      timestamptz NOT NULL,
  requested_by    uuid NOT NULL,
  approver_id     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organisation_id),
  FOREIGN KEY (job_id, organisation_id) REFERENCES job (id, organisation_id),
  FOREIGN KEY (shift_id, organisation_id) REFERENCES shift (id, organisation_id),
  CHECK (approver_id <> requested_by), -- nobody approves their own request
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);
CREATE INDEX allocation_exception_request_approver_idx
  ON allocation_exception_request (organisation_id, approver_id, created_at);
CREATE TRIGGER allocation_exception_request_immutable BEFORE UPDATE OR DELETE ON allocation_exception_request
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE allocation_exception_decision (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id uuid NOT NULL,
  request_id      uuid NOT NULL UNIQUE, -- one decision per request
  decision        text NOT NULL CHECK (decision IN ('APPROVED', 'DECLINED')),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  decided_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (request_id, organisation_id) REFERENCES allocation_exception_request (id, organisation_id)
);
CREATE TRIGGER allocation_exception_decision_immutable BEFORE UPDATE OR DELETE ON allocation_exception_decision
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The exception an approval creates points back to its request (null for exceptions made before).
ALTER TABLE allocation_exception ADD COLUMN request_id uuid;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['allocation_exception_request', 'allocation_exception_decision']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
    -- Live updates (0013): screens showing these refresh when they change.
    EXECUTE format('CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change()', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON allocation_exception_request, allocation_exception_decision TO hub_app;  -- immutable
