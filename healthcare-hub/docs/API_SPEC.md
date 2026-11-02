# API specification

REST + JSON under `/api/v1`. OpenAPI generated from zod schemas in `packages/contracts`
and published at `/api/v1/openapi.json` (non-prod: Swagger UI at `/api/docs`).

## Conventions

- Headers: `Authorization: Bearer`, `X-Org-Id`, `X-Location-Id` (optional; restricts scope),
  `Idempotency-Key` (required on all POST from mobile; recommended everywhere).
- Pagination: cursor-based `?cursor=&limit=` (max 100) → `{ data, nextCursor }`.
- Filtering: `?status=RED,AMBER&ownerId=&locationId=&from=&to=&module=`.
- Errors: RFC 9457 problem+json `{ type, title, status, code, detail, errors[] }`.
  Business codes e.g. `ALLOCATION_BLOCKED`, `MFA_REQUIRED`, `EVIDENCE_NOT_VERIFIED`,
  `STALE_VERSION`, `OVERRIDE_NOT_PERMITTED`.
- Optimistic concurrency: `version` field; PATCH requires `If-Match` → 409 `STALE_VERSION`.
- Times: ISO 8601 with offset; date-only fields `YYYY-MM-DD`.
- Foreign-org or unauthorised record IDs → 404.
- Every response for a status-bearing entity includes `{ status, reasonCode, reasonText }`.

## Endpoint catalogue (initial)

### Identity & org

```
GET    /me                                  user, memberships, permissions, mfa state
GET    /organisations/:id/locations
POST   /admin/users  PATCH /admin/users/:id  POST /admin/users/:id/revoke
POST   /admin/support-access-grants          (manager approves)
```

### Dashboard

```
GET /dashboard/summary?locationId&serviceId&from&to   tiles + module status + lastRefreshedAt + sources[]
GET /dashboard/actions?cursor                          action-required list
GET /dashboard/actions/export (CSV, audited)
```

### Requirements & evidence

```
GET  /requirements/templates   POST /requirements/templates/:id/versions   POST .../publish
GET  /requirements/instances?subjectType&subjectId&status
POST /requirements/instances/:id/applicability        (N/A decision)
POST /requirements/instances/:id/due-date-change      (reason + approver)
POST /evidence/uploads           → { uploadUrl (SAS), evidenceVersionId }
POST /evidence/:versionId/complete
POST /evidence/:versionId/verify { decision, reason }
POST /evidence/:itemId/links     { requirementInstanceIds[] }
GET  /evidence/:versionId/download → { url, expiresAt }   (audited)
```

### Staff

```
GET/POST /staff   GET/PATCH /staff/:id   POST /staff/:id/transition { to, reason }
GET  /staff/:id/readiness?from&to
GET/POST /staff/:id/{references|dbs|right-to-work|licences|registrations|training|supervisions|appraisals}
POST /staff/:id/restrictions   POST /staff/:id/role-approvals
```

### Fleet

```
GET/POST /vehicles  GET/PATCH /vehicles/:id  GET /vehicles/:id/readiness?from&to
POST /vehicles/:id/odometer   GET/POST /vehicles/:id/maintenance
GET/POST /equipment  POST /equipment/:id/quarantine  POST /equipment/:id/release
POST /vdis                      (idempotent; clientSubmissionId)
POST /vdis/:id/amendments
POST /cleaning-records
POST /defects   PATCH /defects/:id   POST /defects/:id/release   (fleet.return_to_service)
POST /fuel-expenses   POST /fuel-expenses/:id/approve   GET /fuel-expenses/export
```

### Compliance

```
GET/POST /audit-templates  POST /audit-templates/:id/versions  POST .../publish
GET/POST /audit-runs  POST /audit-runs/:id/{samples|responses|submit}
POST /audit-runs/:id/findings  POST /findings/:id/actions
POST /actions/:id/evidence  POST /actions/:id/verify { decision, reason }
GET/POST /policies  POST /policies/:id/versions  POST .../transition  POST .../acknowledge
GET/POST /risks   GET/POST /registration   GET/POST /regulatory-correspondence
POST /evidence-packs { locationId, serviceId, frameworkVersion, from, to } → export job
GET  /exports/:id   → status + short-lived link (audited)
```

### Events & premises

```
GET/POST /events  POST /events/:id/transition  POST /events/:id/obligations
PATCH /obligations/:id  POST /events/:id/candour-assessment
GET/POST /premises-items  POST /premises-items/:id/applicability
```

### Jobs & dispatch

```
GET/POST /bookings  POST /bookings/:id/recurrence  PATCH /jobs/:id?scope=this|following
GET  /planner?date&locationId                      day view grid
GET/POST /shifts  POST /shifts/:id/crew
POST /jobs/:id/validate { shiftId }               → checks[] (no side effects)
POST /jobs/:id/allocate { shiftId, exceptionIds? } → 409 ALLOCATION_BLOCKED with checks[]
POST /jobs/:id/offer   POST /jobs/:id/status { state, capturedAt, reason?, clientSubmissionId }
POST /allocation-exceptions  (policy-type checks only; STATUTORY/SAFETY → 422 OVERRIDE_NOT_PERMITTED)
```

### Crew app (mobile-optimised)

```
GET  /crew/today                 shift, vehicle, gate cards, VDI checklist, jobs (assigned only),
                                 eligibilityCheckedAt, cacheUntil (end of shift + 12 h)
POST /shifts/:id/start           → 422 SHIFT_GATE_BLOCKED with the failing checks (idempotent)
GET  /crew/jobs/:id              assigned-only; patient contact only during the shift window
POST /crew/sync                  ≤50 queued items {clientSubmissionId, type, ref?, payload}
                                 type: VDI | CLEANING | JOB_STATUS | DEFECT | EXPENSE | POLICY_ACK |
                                 SHIFT_START → per-item ACCEPTED | DUPLICATE | CONFLICT (+serverState)
                                 | REJECTED | RETRY, replayed through the normal endpoints
GET  /crew/policies/pending   POST /crew/policies/:versionId/acknowledge {confirmCritical?}
GET  /crew/profile
POST /devices/register-push   GET /devices   DELETE /devices/:id
Header x-device-id on every crew-app call; a revoked device → 401 DEVICE_REVOKED (app wipes).
```

### Data protection (privacy.manage)

```
GET /retention-rules (defaults appear as placeholders)   PATCH /retention-rules/:id   POST /retention-rules/:id/approve
GET /retention-log   GET|POST /legal-holds   POST /legal-holds/:id/release
GET|POST /subject-requests   POST /subject-requests/:id/update   POST /subject-requests/:id/export (SAR ZIP)
GET|POST /disclosures   GET|POST /breaches   POST /breaches/:id/assessment | /ico-report | /close
```

### Reports, import, audit

```
GET /reports (catalogue + definitions)   GET /reports/:id?from&to&locationId
GET /reports/:id/export (CSV, audited)   POST /management-packs {month} → export job (PDF)
POST /imports {kind STAFF|VEHICLES, filename, csv} (preview) → GET /imports/:id → POST /imports/:id/commit
  → POST /imports/:id/rollback (within 7 days) | POST /imports/:id/discard
POST /workbook-imports {sheet, csv, columns} → GET /workbook-items → POST /workbook-items/:id/propose
  → POST /workbook-items/:id/decision (another person) → POST /workbook-items/:id/publish (draft template)
GET /audit-log?entity&actor&from&to   POST /audit-log/verify-chain
POST /exports/full (org-wide data portability export, admin.export.full, audited) → export job (ZIP)
```
