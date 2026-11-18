-- Live updates for the organisation tables added since 0041 (v36 registers, people records, rota,
-- governance, self-audit, workforce checks, training plans: 0044-0058). Each backs a v36 screen,
-- so a committed change must tell that organisation's open screens to refetch. Same rule as
-- 0013/0041: tables no screen shows stay out (audit_log above all, since audited reads write to
-- it), and demo_seed_state, which only records which sample data was loaded. DDL only: no existing
-- row is read or changed, so FORCE RLS and the guard triggers need no lifting. Forward-only.
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
         'org_counter', 'push_message', 'retention_log', 'demo_seed_state')
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
