-- Live updates for the organisation tables added since 0013 (workflow programme, 0018-0036): every
-- one of them backs a screen, so a committed change must tell that organisation's open screens to
-- refetch. Same rule as 0013: tables no screen shows stay out, audit_log above all (audited reads
-- write to it, and a read that signals would make every screen refetch for ever). Forward-only.
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
         'audit_log', 'idempotency_key', 'notification_delivery', 'notification_outbox',
         'org_counter', 'push_message', 'retention_log')
       AND NOT EXISTS (
         SELECT 1 FROM pg_trigger g
          WHERE g.tgrelid = ('public.' || quote_ident(c.table_name))::regclass
            AND g.tgname = 'live_change')
  LOOP
    EXECUTE format(
      'CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change()', t);
  END LOOP;
END $$;
