-- Live updates: a committed change to an organisation's data notifies the API, which tells that
-- organisation's open screens to refetch through the normal, permission-checked endpoints.
-- The payload is only the organisation id, and pg_notify collapses repeats within a transaction
-- and is delivered on commit, so a rolled-back change signals nothing. Writes made outside a
-- tenant context (app.org_id unset) do not signal.
CREATE FUNCTION notify_org_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org text := current_setting('app.org_id', true);
BEGIN
  IF org IS NOT NULL AND org <> '' THEN
    PERFORM pg_notify('hub_changes', org);
  END IF;
  RETURN NULL;
END $$;

-- Every table with an organisation_id signals, except those no screen shows. audit_log in
-- particular must stay out: audited reads write to it, and a read that signals would make every
-- open screen refetch for ever. A new table needs its own trigger (test/live.test.ts checks).
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables s USING (table_schema, table_name)
     WHERE c.table_schema = 'public'
       AND c.column_name = 'organisation_id'
       AND s.table_type = 'BASE TABLE'
       AND c.table_name NOT IN (
         'audit_log', 'idempotency_key', 'notification_delivery', 'org_counter', 'push_message',
         'retention_log')
    UNION
    SELECT 'organisation'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change()', t);
  END LOOP;
END $$;
