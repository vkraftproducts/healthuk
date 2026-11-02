# ADR 0002: Tenant isolation with RLS

Status: Accepted. Decision: every tenant table has organisation_id, RLS with FORCE, app role
not owner, `SET LOCAL app.org_id` per transaction via withTenant(). App-level checks remain
primary. Consequences: a missed WHERE clause cannot leak cross-tenant data; all queries must
run inside a transaction (pgbouncer transaction mode compatible).
