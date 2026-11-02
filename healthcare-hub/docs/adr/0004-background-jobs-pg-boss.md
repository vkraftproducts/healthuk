# ADR 0004: pg-boss for jobs

Status: Accepted. Decision: Postgres-backed queue (pg-boss) for reconciliation,
notifications, exports, imports. Consequences: no extra Azure service cost; jobs enqueued in
the same transaction as the business change; revisit if throughput grows 10×.
