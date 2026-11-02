# Runbook: restore the database (NFR-01: RPO ≤ 1 h, RTO ≤ 4 h)

Use this when production data is lost or corrupted, the server is unavailable, or for the
**quarterly drill**. Restores always go to a **new** server; the damaged one is kept until the
incident is closed (evidence).

| Target    | How it is met                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| RPO ≤ 1 h | Postgres Flexible Server point-in-time restore (continuous WAL, ~5 min) with geo-redundant backups (UK West), 35-day retention |
| RTO ≤ 4 h | Restore (typically 20–60 min at pilot size) + verification (minutes) + connection swap (minutes)                               |
| Files     | Storage account GRS + versioning + 30-day soft delete; audit anchors in an immutable container                                 |

## Roles

- **Incident lead** (registered manager or delegate): decides to restore, chooses the restore
  point, approves the swap, informs users (downtime procedure: printed rota and "call control").
- **Operator** (platform engineer): runs the steps and keeps the timeline below.

## Steps

1. **Declare and record.** Note the time, symptom and chosen restore point (UTC) in the incident
   log. Switch crews and control to the downtime procedure if the service is down.
2. **Restore to a new server.**

   ```bash
   az postgres flexible-server restore \
     --resource-group <rg> --name hub-prod-pg-r<yyyymmdd> \
     --source-server hub-prod-pg --restore-time "<UTC ISO time>"
   # Region outage: geo-restore into UK West instead
   az postgres flexible-server geo-restore \
     --resource-group <rg-dr> --name hub-prod-pg-dr<yyyymmdd> \
     --source-server <source server resource id> --location ukwest
   ```

   Re-apply `azure.extensions = BTREE_GIST,PGCRYPTO` and the firewall rules from
   `infra/modules/postgres.bicep` if the restore did not carry them.

3. **Verify the copy** before anything points at it (from a machine allowed through the firewall):

   ```bash
   DRILL_SOURCE_URL="postgresql://hubadmin:<pw>@hub-prod-pg-r<yyyymmdd>.postgres.database.azure.com:5432/hub?sslmode=require" \
   DRILL_CONTEXT="Production restore to <server> from <restore time>" \
     pnpm --filter @hub/db drill
   ```

   This dumps the restored server into a scratch database on the same server, compares every
   table and verifies each organisation's audit hash chain (`audit_verify_chain`). Also check:
   latest `audit_log.occurred_at` is close to the restore point, and `SELECT count(*) FROM
pgboss.job WHERE state = 'active'` is zero.

4. **Swap.** Update the Key Vault secrets `database-url` and `queue-database-url` to the new host,
   then restart the API and worker revisions:

   ```bash
   az containerapp revision restart -g <rg> -n hub-prod-api --revision <active>
   az containerapp revision restart -g <rg> -n hub-prod-worker --revision <active>
   ```

   Confirm `/readyz` returns `ready` and the availability alert clears.

5. **Reconcile.** Work done after the restore point is lost. Crew devices replay their offline
   outbox automatically (idempotent: nothing is duplicated). Ask control to re-enter bookings
   and changes made after the restore point from the downtime paperwork.
6. **Close.** Record the timeline, the drill report and lessons learned. Keep the old server
   (stopped) until the incident review signs off, then delete it.

## Quarterly drill

Run steps 2–3 against a restore of production (no swap), record the report in
`docs/compliance/` and the timings below, then delete the drill server. The build machine drill
(`docs/compliance/restore-drill-report.md`) proves the procedure on synthetic data only.

| Date | Restore point | Restore time | Verify | Total | Result | Operator |
| ---- | ------------- | ------------ | ------ | ----- | ------ | -------- |
|      |               |              |        |       |        |          |
