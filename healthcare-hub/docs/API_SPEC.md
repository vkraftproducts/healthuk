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
PATCH  /admin/memberships/:id { roleId?, locationId?, reason }   ends the membership, starts a new one; never your own (403); support role never grantable (403)
POST   /admin/support-access-grants          (manager approves)
```

### Local username + password sign-in (AUTH_MODE=local only; 404 otherwise; ADR 0006)

```
POST /auth/login {username, password}            public → {access_token, token_type, expires_in} | {mfaRequired, challengeId} | {mfaSetupRequired, challengeId} | {passwordChangeRequired, challengeId}
POST /auth/mfa/setup {challengeId}               public → {secret, otpauthUri} (shown once; enrolment)
POST /auth/mfa/verify {challengeId, code}        public → next step or token (amr ['pwd','otp']); a TOTP step is never accepted twice
POST /auth/forced-password-change {challengeId, newPassword}   public → token; after an administrator reset; ends all other refresh sessions
POST /auth/change-password {currentPassword, newPassword}      signed in → {changed: true}; ends every refresh session and sets a new cookie for this one
POST /auth/refresh                               public (cookie) → {access_token, token_type, expires_in}; rotates the cookie
POST /auth/logout                                public (cookie and/or bearer) → {signedOut: true}; ends the cookie's refresh session, clears the cookie, audits auth.logout
POST /admin/users/:id/reset-password             admin.users.manage → {temporaryPassword, mustChangePassword: true}; current member of the organisation only (else 404); never your own (403); ends their refresh sessions
POST /admin/users/:id/mfa-reset {reason}         admin.users.manage → {mfaReset: true}; removes their TOTP (they enrol again at next sign-in) and ends their refresh sessions; reason 5–500 characters (400); current member only (else 404); never your own (403); audit auth.mfa.reset with the reason
```

Refresh token (local mode only): every completed sign-in (`login`, `mfa/verify`,
`forced-password-change`) also sets the cookie `hub_refresh` — an opaque 256-bit random value,
`HttpOnly; SameSite=Strict; Path=/api/v1/auth`, plus `Secure` unless the API runs over plain http
in development (`PUBLIC_API_URL` http and `NODE_ENV` not production). It is never in a response
body, and the database keeps only its SHA-256. Lifetime: 30 minutes idle (`Max-Age`, renewed on
each refresh), 12 hours absolute from the password sign-in. Each refresh uses the token up and
issues a new one in the same family; presenting a used token again ends the whole family and
audits `auth.refresh.reuse`. Every refresh re-checks access (401 `USER_INACTIVE` once it has
ended) and MFA for the current roles (401 if the session was started without a code and a role
now needs one). Refusals answer 401 `Your session has ended. Sign in again.` and clear the
cookie. A request with an `Origin` other than `WEB_ORIGIN` gets 403. Sessions are also ended by
a password change or reset, an MFA reset, `POST /admin/users/:id/revoke` and an immediate leaver
transition. Web and API must be same-site for the cookie to be sent.

Errors: 401 `Username or password is incorrect.` (unknown user and wrong password alike);
401 `Too many attempts. Try again later.` while locked (5 failures → 15 minutes, right or wrong
password); 429 with the same words after 20 attempts per IP per 15 minutes; 401 `USER_INACTIVE`
`Your access to this organisation has ended.` only after a correct password; 400 for password
policy (12+ characters, not the username, not common). Responses carry `Cache-Control: no-store`.

### Dashboard

```
GET /dashboard/summary?locationId&serviceId&from&to   tiles + module status + lastRefreshedAt + sources[]
GET /dashboard/actions?cursor                          action-required list
GET /dashboard/actions/export (CSV, audited)
```

Summary, actions, export and group are limited to the modules the caller may see
(`visibleDashboardModules`: permissions, plus the ambulance pack for fleet and jobs). The summary
returns `visibleModules[]` and `visibleTiles[]`; anything else is left out by the server.
An unknown sign-in gets 401 `UNAUTHENTICATED` "No Healthcare Hub account exists for this sign-in".
`GET /me` memberships include `sectorPacks`. `support: { endsAt } | null` is set while a support
grant is active (the web shows the support banner). `POST /actions` and `GET /actions?sourceType`
accept `PREMISES` as a source.

Reports: `GET /reports` lists only reports the caller may run (`canRunReport`: `reports.view`
plus a permission for what the report covers; fleet and journeys need the ambulance pack).
`GET /reports/:id` and its export return 403 `FORBIDDEN` for any other report. AUDITOR now holds
`admin.audit.view` (audit log).

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
  role-approvals: regulated roles (SCHEDULE3_ROLES) → 422 TRANSITION_NOT_ALLOWED with one
  SCHEDULE3_<item> check per missing, attention or unverified Schedule 3 item (after four-eyes)
GET/POST /staff/:id/requests  (staff.profile.manage)  POST { kind: REVIEW, instanceId, reason }
  | { kind: SUPERVISION, proposedDate, supervisorUserId?, reason }; not about yourself (422),
  not for leavers (409), max 10 open, one open review per item (409); audited staff.request.raise;
  decided via /staff/self-requests/:id/decide, never by the requester
POST /staff accepts workEmail, startDate, contractType (PERMANENT|FIXED_TERM|BANK|AGENCY|
  VOLUNTEER); PATCH takes the same as nullable (migration 0025_staff_sector_roles)
Staff roles add DENTIST, DENTAL_NURSE, RECEPTIONIST, SENIOR_CARER, ACTIVITIES_COORDINATOR
LICENCE records: optional licenceNumber (DVLA, 16 characters, stored encrypted). Without
  staff.profile.manage or staff.sensitive.view, penaltyPoints is omitted, the number shows as
  ••••last4, and driver-eligibility leaves out the PENALTY_POINTS check
Readiness and allocation: vehicles over 3,500 kg need C1 (over 7,500 kg: C), from grossWeightKg
GET  /staff/:id/schedule-3   (staff.profile.manage + staff.sensitive.view; audited) → { complete, items[] }
GET  /staff/:id/driver-eligibility?category=B   (basic or clearance view) → { eligible, checks[] }
GET  /staff/training-matrix?role&locationId&templateId&gapsOnly=true   (staff.profile.view_basic)
     → { columns[{ templateId, title, roles, summary }], rows[{ hasGap, cells[{ state }] }], truncated }
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
POST /defects/:id/reopen   (fleet.return_to_service; sends a signed-off repair back for more work)
POST /fuel-expenses   POST /fuel-expenses/:id/approve   GET /fuel-expenses/export
GET /fuel-expenses?status   rows carry vehicleLabel, submittedByName, decidedByName (task 15)
POST /fuel-expenses/:id/approve { decision, note }   a REJECTED decision needs a note (≥3 chars)
POST /equipment/:id/regimes { regime, templateId, source? }   (published EQUIPMENT template)
```

### Compliance

```
GET/POST /audit-templates  POST /audit-templates/:id/versions  POST .../publish
POST /audit-templates/:id/activate   (compliance.requirement.manage; not the author of the published version)
GET/POST /audit-runs  POST /audit-runs/:id/{samples|responses|submit}
POST /audit-runs/:id/findings  POST /findings/:id/actions
POST /actions/:id/evidence  POST /actions/:id/verify { decision, reason }
PATCH /actions/:id { ownerUserId?, deadline?, reason } (If-Match; not once verified; reason in history)
GET/POST /dp-complaints  POST /dp-complaints/:id/acknowledge { acknowledgedOn }  POST /dp-complaints/:id/resolve { outcome, resolvedOn }
GET/POST /policies  POST /policies/:id/versions  POST .../transition  POST .../acknowledge { confirmCritical }
GET /policies/:id/readers   (compliance.policy.manage; who has and has not acknowledged)
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

### Speaking up and harassment prevention (task 20)

```
POST /speak-up { category, summary, anonymous, thirdParty }   (speakup.raise) → { code, raisedOn, acknowledgeDue }
     anonymous: no raiser or recorder stored; the audit event has no actor
GET  /speak-up/mine   (speakup.raise; own named concerns, progress only)
GET  /speak-up?status&category   GET /speak-up/:id (audited)   (speakup.manage)
POST /speak-up/record { category, channel, summary, raisedOn, anonymous, raisedByUserId?, handlerUserId? }
POST /speak-up/:id/acknowledge { acknowledgedOn, handlerUserId }   (handler ≠ raiser)
POST /speak-up/:id/start { note }
POST /speak-up/:id/notes { kind NOTE|FEEDBACK|DETRIMENT_CHECK, note, on, detrimentReported? }   (append-only)
POST /speak-up/:id/close { outcome, outcomeText, closedOn, lessons? }   (named: feedback first → 422)
GET|POST /harassment/assessments   PATCH /harassment/assessments/:id (draft only, If-Match)
POST /harassment/assessments/:id/approve   (not the preparer → 422 SELF_APPROVAL)   (harassment.manage)
GET  /harassment/duty → { steps[], concernsLast12Months, note }   (harassment.manage)
```

### Registration, rating display, fit and proper, meetings, CQC notifications (task 21)

```
POST /registration { …, reason? }   writes a registration_history row every time
GET  /registration/history   (compliance.registration.manage or compliance.audit.view)
GET|POST /cqc-ratings { locationId?, overall, keyQuestions?, publishedOn, reportUrl? (https), noWebsite? }
     the rating as CQC published it; displayDue = published + 21 days; never calculated
PATCH /cqc-ratings/:id { displayedPremisesOn?, displayedWebsiteOn?, noWebsite? }   (If-Match; nothing else changes)
GET|POST /fit-and-proper { directorName, directorRole, userId?, checkedOn, items[], declarationOn?, outcome, notes? }
     (governance.fit_proper.manage; append-only; own check → 422 SELF_APPROVAL; list audited)
GET  /governance-meetings?kind&status   GET /governance-meetings/:id   (governance.meeting.manage or compliance.audit.view)
POST /governance-meetings { kind, title, heldOn, chair, attendees[], apologies[], quorate, minutes, decisions? }
PATCH /governance-meetings/:id (draft only, If-Match; editor becomes author)
POST /governance-meetings/:id/approve (If-Match; not the author → 422)   POST /governance-meetings/:id/actions
GET  /cqc-notifications?status   GET /cqc-notifications/suggestions   (events.event.manage or compliance.registration.manage)
POST /cqc-notifications { kind, eventId?, occurredOn, planned?, summary, actionsTaken? }   (events.event.manage)
PATCH /cqc-notifications/:id (draft only, If-Match; editor becomes preparer)
POST /cqc-notifications/:id/transition { to READY|DRAFT|SUBMITTED{submittedOn,cqcReference}|NOT_REQUIRED{reason} }
     (If-Match; READY by someone other than the preparer → else 422; the hub never sends to CQC)
```

### NHS contracts and evidence pack options (task 22)

```
GET  /nhs-contracts → { contracts[], items[], summary, notAdopted }   (compliance.registration.manage or compliance.audit.view)
POST /nhs-contracts { commissioner, reference, service, contractType, startOn, endOn, noticeMonths?, reporting?,
     managerUserId, reviewMeetingOn?, notes? }   (compliance.registration.manage; duplicate reference → 409)
PATCH /nhs-contracts/:id (If-Match)
POST /evidence-packs { from, to, locationId?, domain?, purpose? INSPECTION|NHS_CONTRACT|INTERNAL,
     sections? [REQUIREMENTS, AUDITS, ACTIONS, POLICIES, GOVERNANCE, CONTRACTS], includeFiles?, gapsOnly? }
Library pack NHS_CONTRACT_V1: 15 organisation items, adopted and published like the ambulance pack
```

### Alerts centre and notification rules (task 24)

```
GET  /alerts/centre?event&includeAcknowledged → { items[], rules[], emailReminders }   (any member)
     event: EXPIRY_WARNING|ACTION_OVERDUE|AUDIT_OVERDUE|INCIDENT_REPORTED|BREACH_RECORDED|
            POLICY_PUBLISHED|OPERATIONS
     item: { key, event, sourceType, sourceId, alertId?, alertVersion?, severity, title, reasonText,
             raisedAt, dueOn?, state, snoozedUntil?, why OWNER|NOTIFIED|RULE|ROLE, link }
     Titles are codes or record titles only; events show their code, never title or description.
GET  /alerts   POST /alerts/:id/acknowledge   POST /alerts/:id/snooze   (unchanged)
Notification planning honours OrgSettings.notificationRules: EXPIRY_WARNING adds in-app (and email
when the rule and the organisation allow it) deliveries for the named roles; BREACH_RECORDED sends
open breach alerts to the named roles only.
```

### Staff self-service (task 25)

```
GET  /staff/me/readiness?role&from&to → ReadinessDto   (staff.self.view; window ≤ 31 days)
GET  /staff/me/requests → { data: SelfRequestDto[] }   (staff.self.view)
POST /staff/me/requests   (staff.self.update; own items only, others → 404; ≤ 10 open)
     { kind: DUE_DATE_CHANGE, instanceId, proposedDate, reason ≥ 10 }   (expiry items → 422)
     { kind: REVIEW, instanceId, reason }
     { kind: SUPERVISION, proposedDate, supervisorUserId?, reason }
POST /staff/me/requests/:id/withdraw   (If-Match; open only)
GET  /staff/self-requests?status   (staff.profile.manage, compliance.due_date.change or
     compliance.evidence.verify)
POST /staff/self-requests/:id/decide { decision: ACCEPTED, note?, bookedFor? } |
     { decision: DECLINED, note }   (If-Match; not the requester → 422; supervision needs bookedFor)
     DUE_DATE_CHANGE: compliance.due_date.change; accepting writes due_date_change and moves the date
     REVIEW: staff.profile.manage or compliance.evidence.verify
     SUPERVISION: staff.profile.manage or the named supervisor
```

### Vehicle and planner operations (task 26)

```
POST /vehicles/:id/off-road | /vehicles/:id/quarantine { on, reason }   (fleet.vehicle.manage;
     on: false also needs fleet.return_to_service → else 403). The reason is kept in
     vehicle_status_change (append-only). on: true releases not-started allocations on the vehicle
     (jobs → REASSIGNED, crew told, control alerted with job codes only).
GET  /vehicles/:id/status-history → { data: VehicleStatusChangeDto[] }   (fleet.vehicle.view)
VehicleDto now carries offRoad and quarantined.
POST /shifts/:id/cancel { reason }   (jobs.allocate; PLANNED shifts only → else 409; a job under
     way → 409). Jobs → REASSIGNED with an alert, crew assignments withdrawn, vehicle and crew
     bookings freed, shift_change CANCELLED, crew told.
Job release and cancel from the planner use POST /jobs/:id/status (REASSIGNED / CANCELLED + reason).
```

### Registers, forms and exception requests (task 15 and fleet follow-ups)

```
POST/PATCH /vehicles[/:id] accept vin, ownership, licenceCategory, grossWeightKg (500–44,000),
     permittedLoads. A duplicate on create → 409 naming the registration or the callsign.
VehicleDto carries grossWeightKg and latestReading { reading, readOn } | null; currentOdometer
     is null until a reading exists.
PATCH /premises-items/:id   (premises.item.manage; If-Match) PremisesPatch: title,
     responsibleUserId, actionOwnerUserId, frequencySource, contractorName, assessmentRef,
     assessedOn. Members only (400); stale → 409 STALE_VERSION. Audit premises.item.update.
POST /premises-items/:id/schedule { templateId, dueDate? }   (premises.item.manage) Links an
     organisation-owned published PREMISES schedule; library or unpublished → 422
     TEMPLATE_NOT_PUBLISHED; past dueDate → 400; already linked → 409.
     Audit premises.item.schedule.
PremisesDto carries responsibleName, actionOwnerName, scheduleTitle, deadlineKind.
POST /allocation-exception-requests { jobId, shiftId, checkCode, reason, expiresAt }
     (jobs.allocate) The check must be failing (else 400) and policy-level (else 422
     OVERRIDE_NOT_PERMITTED); one open request per job and check (else 409). Audit
     allocation.exception.request.
GET  /allocation-exception-requests?status&jobId → { data: ExceptionRequestDto[] }
     (jobs.allocate or allocation.exception.approve)
POST /allocation-exception-requests/:id/decide { decision: APPROVED|REJECTED, note? }
     (allocation.exception.approve) The asker → 403 SELF_APPROVAL; already decided → 409;
     REJECTED needs a note (3+ characters); APPROVED re-runs the check, then creates the
     allocation exception. Audit allocation.exception.approve / .reject. Decided requests are
     immutable (database trigger).
POST /shifts and POST /shifts/:id/vehicle: a vehicle that is not AVAILABLE → 422
     OVERRIDE_NOT_PERMITTED. POST /shifts: the same person twice → 400. POST /shifts/:id/crew:
     overlapping time for someone already on the shift → 400.
Allocate and offer refusals list the failing checks in words; SHIFT_GATE is PENDING (not FAIL)
     before the shift start time, then FAIL until the crew start it (finding 71).
```

### Data protection logs (task 27)

```
GET  /disclosures?from&to → { data: DisclosureDto[] }   (privacy.manage; dates of disclosure,
     from ≤ to else 400; adds recordedByName and subjectRequestCode)
POST /disclosures   (privacy.manage; disclosedOn in the future → 400; append-only table)
GET  /retention-log?category&from&to → { data: RetentionLogDto[] }   (privacy.manage; run date
     in London; unknown keys or categories → 400)
```

Task 28 (Playwright browser tests per role) adds no API routes.

### Workflow pass: G, H1-H5, I, L1, L3, L5, M (6 Nov 2026; tests not yet run)

```
GET  /incidents/types → { data: string[] }   (events.event.report; IRMER for dental, DOLS for
     care homes)
POST /incidents/report → { id, code, triageDueAt, stillAtRiskAlerted, message }
     (events.event.report; occurredAt in the future → 400; type not used here → 400; still at
     risk raises an alert holding the reference only)
GET  /incidents/mine → { data: MyReportDto[] }   (own reports, status only)
POST /events/:id/triage   (events.event.manage; only while TRIAGE → 409; lead not active → 400)
GET  /events/:id/obligation-suggestions   POST /events/:id/obligations/suggested {bodies}
POST /events/:id/candour-steps {step, doneOn}   (before the RM decides candour applies → 409;
     step already recorded → 409; future date → 400)
POST /events/:id/learning {response, notes}   (closed event → 409)
PATCH /events/:id/complaint {reopenReason}   (If-Match; reopens with history kept)
POST /audit-templates/:id/clone {code, title}   (code used → 409; new draft)
POST /audit-templates/:id/retire {reason}   (compliance.requirement.manage; twice → 409)
POST /audit-templates/:id/versions/:versionId/publish {specialistName, specialistRole}
     (both required for dental and care home templates)
POST /audit-runs   adds serviceId, reviewerUserId (not the auditor), recurrenceMonths
POST /audit-runs/:id/submit   (every control answered, else 400 listing what is missing;
     failures become draft actions)
POST /audit-runs/:id/review {decision, reason?}   (auditor → 422 SELF_APPROVAL; not the named
     reviewer → 403; RETURNED needs a reason; ACCEPTED with recurrence schedules the next run)
POST /actions {sourceType, sourceId, title, ownerUserId, deadline}   GET /actions?ownerUserId&
     sourceType&status&overdue
PATCH /policies/:id/readers {readerRoles?, readerLocationIds?, readerEveryone?}
POST /policies/:id/chase → { chased }   (compliance.policy.manage; no published version → 409;
     one reminder per person per day)
PATCH /risks/:id {status: CLOSED|ARCHIVED, reason}   (reason required → 400; If-Match → 409)
POST /registration   adds insuranceExpiresOn, bcpReviewedOn, bcpNextReviewOn, effectiveFrom;
     a change of RM or nominated individual drafts a CHANGE_OF_DETAILS notification
POST /registration/locations {locationId, registeredManagerUserId?, managerStartOn?,
     activities, conditions?, effectiveFrom, reason}   (append-only; manager change drafts a
     notification; manager without start date → 400)
PATCH /cqc-ratings/:id   display adds premisesEvidenceItemId, websiteEvidenceItemId
GET  /governance-meetings/pack → MeetingPackDto   (governance.meeting.manage; audited)
POST /governance-meetings/:id/approve {approvedAtMeetingId?}   (same or earlier meeting → 400)
GET  /inspection/overview → InspectionOverviewDto   (inspection.view; every view audited;
     coverage labelled 'Internal measure — not a CQC rating')
GET  /reports/NHS_KPI   (contract items, IG training against 95%, DSPT; registration or audit
     view permission)
POST /evidence-packs   serviceId unknown → 400 'Unknown service'
```

### Workflow pass: A, B, C, K, H6, L2, L4, F0 (6 Nov 2026; tests not yet run)

```
PATCH /organisations/:id/locations/:locationId {archived: true, archiveReason}   (reason → 400)
POST /admin/users   adds staffId?; current member with that email → 409 EXISTING_USER; staff
     record linked or leaver → 409
PATCH /admin/memberships/:id, POST /admin/users/:id/revoke   (only registered manager → 409);
     revoke flags future shifts
PATCH /admin/settings   only keys sent change; adds itemRules, escalation, deputies, channels,
     speakUpGuardianUserId (deputies and guardian must be current members → 400)
POST /admin/support-access-grants/:id/end {reason} → SupportGrantDto   (admin.support.approve;
     not the support user; ended or expired → 409)
GET  /alerts/count → { open, critical }   (any member)
POST /alerts/:id/snooze {until: date|dateTime, reason}   (reason required → 400)
GET  /audit-log?action=<prefix.>&entityId&actorId&from&to   entries add actorRole, reason, summary
GET  /audit-log/export?…same filters → text/csv   (admin.audit.view; 5000 rows; audited)
GET  /staff/:id/readiness-window?role&from&to → ReadinessWindowDto
GET  /staff/training-matrix/export → text/csv
GET  /training-courses   POST /training-courses   POST /training-courses/:id/retire {reason}
     (If-Match)
POST /training-records/bulk {courseCode, completedOn, staffIds…} → { created, recordIds }
GET  /supervision-bookings?staffId&status   POST /staff/:id/supervision-bookings
POST /supervision-bookings/:id/close {status HELD|CANCELLED|MISSED, …}   (If-Match)
GET|POST /staff-records/:id/acknowledgements {agreed, comment?}   (own record only)
POST /requirements/templates/:id/retire {reason}
POST /requirements/templates/:id/adopt   dental and care home need specialistValidatedBy and
     specialistOrganisation (→ 422)
GET  /subject-requests/:id/sources → SubjectRequestSourcesDto   (privacy.manage)
PATCH /subject-requests/:id   adds identityRequestedOn, identityVerifiedOn, exemption (REFUSED)
POST /disclosures   adds subjectDescription, requestedBy, method, approvedBy (self → 422
     SELF_APPROVAL)   GET /disclosures?q
POST /breaches/:id/containment {containedAt, how, peopleAffected?}
POST /breaches/:id/close {lessons}   (not contained → 422; no lessons → 400; closed → 409)
POST /dp-complaints   ICO source needs icoCaseRef   POST /dp-complaints/:id/acknowledge {text?}
GET  /retention-reviews   POST /retention-reviews {ruleId}   (approved rules; one per rule per
     month → 409)   POST /retention-reviews/:id/decisions {recordType, decision KEEP|ACT,
     reason?, keepUntil?}   POST /retention-reviews/:id/close
POST /speak-up   anonymous → receipt adds progressCode (shown once)
GET  /speak-up/progress?code → { status, feedback, updatedOn }   (speakup.raise; unknown → 404)
GET  /speak-up/guardian → { guardianName }   (speakup.raise)
GET  /speak-up/themes?quarter=YYYY-Qn → SpeakUpThemesDto   (speakup.manage or reports.view;
     counts under 3 hidden)
POST /speak-up/:id/progress-feedback {feedback}   (speakup.manage; anonymous concerns only)
```

### Workflow pass: D, E, J1 (6 Nov 2026; tests not yet run)

```
POST /vehicles accepts make, model, year, firstRegisteredOn, en1789Type, conversionCompany,
     conversionCertificateRef, ownershipEndsOn (required unless OWNED), serviceIds,
     blueLightAuthorised, bariatricLimitKg. licenceCategory is worked out from the weight.
     VehicleDto adds licenceNeeded, expectedReturnOn; GET /vehicles/:id adds headline
     { status, reason } and readings[].review. Missing MOT, insurance or tax (auto-applied
     templates) and a missed oxygen storage check at the base block readiness (no override).
POST /vehicles/:id/odometer/:readingId/review { decision CONFIRMED|CORRECTED,
     correctedReading?, reason }   (fleet.vehicle.manage; unflagged or already reviewed → 409;
     audit fleet.odometer.review). The original reading is kept.
POST /vehicles/:id/maintenance/:planId/done adds garage?, jobSheetEvidenceItemId? (unknown → 400)
POST /vehicles/:id/off-road adds reasonCode? (ACCIDENT, AWAITING_PARTS, REPAIR, SERVICE, SOLD,
     OTHER) and expectedReturnOn? (past → 400). POST /vehicles/:id/move adds effectiveOn?
     (today by default; future → 400).
POST /equipment/:id/release { reason, evidenceItemId }   (the person who quarantined it → 403
     SELF_APPROVAL; unknown evidence → 400)
PATCH /defects/:id adds repairJobSheetEvidenceItemId; release of a REPAIRED defect needs the
     repair notes. GET /defects?severity=CRITICAL|MAJOR|MINOR. DefectDto adds affectedJobCodes.
POST /fuel-expenses: the same receipt is also flagged as a possible duplicate.
GET  /vdi-templates?all=true (managers)   POST /vdi-templates/:id/publish (drafter → 403)
POST /bookings adds contractType? (NHS needs nhsEligibility { met, criteria, assessedBy }),
     returnJourney? (its own job, addresses swapped, returnOfJobId), job.blueLights. Response
     adds warnings[] (weight above every vehicle's permitted load).
POST /jobs/:id/status ASSESSED needs accessPlanReviewed (400). EN_ROUTE after a vehicle swap
     needs a passed VDI and cleaning for the new vehicle (422 SHIFT_GATE_BLOCKED).
POST /jobs/:id/reassign { shiftId, reason }   (jobs.allocate) Re-runs every check; blocked → 409
     with the reasons; else the old allocation ends with the reason. Audit jobs.reassign.
GET  /shifts/crew-readiness?staffId&role&from&to&vehicleId? → CrewReadinessDto   (jobs.allocate)
POST /shifts/:id/crew/:assignmentId/swap { staffId, reason }   (jobs.allocate) Same role, rest
     of the assignment; audit jobs.shift.crew_swap.
Overlaps name the person or vehicle: "Sam Taylor is already on AMB-02 from 07:00 to 19:00" (409).
SHIFT_GATE (finding 71): PENDING before the shift start time; after it, FAIL "Shift has not been
     started" until the crew start it.
POST /premises-items adds areaName?, intervalMonths? (nextDue from assessedOn + interval).
POST /premises-items/:id/applicability adds reviewerId?, reviewOn? (future; default one year).
POST /premises-items/:id/findings { title, deadline, ownerUserId?, severity? } → ActionDto
     (premises.item.manage; source PREMISES; oxygen defaults to HIGH)
GET  /premises-items/:id/history → { data: PremisesHistoryDto[] }   (premises.item.view)
PremisesDto adds areaName, intervalMonths, applicabilityReviewer*, deploymentCritical.
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

### Live updates

- `GET /live/changes` — any member of the organisation. `text/event-stream`: `ready` once listening, then `change` when the organisation has new data. Carries no record data: refetch through the normal endpoints. Ends after `LIVE_STREAM_MAX_SECONDS` (default 300); reconnect to continue.

### Email and push delivery of escalations (6 Nov 2026; tests not yet run)

Self-scoped: `@OrgMember()` and every query is limited to the caller in the selected
organisation (another person's device is 404). Support access gets 403 on the writes.

```
GET    /me/push-devices                  → { data: PushDeviceDto[] }   (live registrations only)
POST   /me/push-devices                  → 201 PushDeviceDto   audit notifications.push_device.register
       { kind: 'EXPO', token: 'ExponentPushToken[...]' }
     | { kind: 'WEB_PUSH', endpoint: 'https://...', keys?: { p256dh, auth } }
       Re-registering the same token refreshes it (same id, no new audit). A live token belongs to
       one person: registering it moves it from anyone else in the organisation. At most 10 live
       registrations per person (MAX_PUSH_DEVICES); the oldest are revoked.
DELETE /me/push-devices/:id              → PushDeviceDto (revokedAt set)   audit notifications.push_device.remove
GET    /me/notification-preferences      → { email, push, organisation: { email, push } }
PUT    /me/notification-preferences { email?, push? } (at least one)   audit notifications.preferences.update
```

- `PushDeviceDto` is `{ id, kind, createdAt, lastRegisteredAt, revokedAt }`; the token or
  endpoint is never returned.
- Defaults: both switches on. The organisation's switches (`settings.channels.email` with
  `settings.emailReminders`, and `settings.channels.push`) apply on top.
- Delivery (worker job `deliver-escalations`, every 5 minutes): when an open, unacknowledged,
  unsnoozed alert reaches the lead stage (`escalation.leadAfterDays`), the lead role for its item
  kind is told; at the manager stage (`managerAfterDays`), the registered manager. Deputies
  covering a target that day are told too; the alert owner is not. One `notification_outbox` row
  per (alert, stage, recipient, channel). Push rows only for people with a live device. Stages
  reached more than 7 days ago are not announced.
- Content is fixed: subject "An item needs your attention in Healthcare Hub", the stage, priority
  word and UK date, and a link to an opaque in-app path (`alertLink`, e.g. `/staff/<uuid>`;
  requirement alerts go to `/alerts`). Push: title "Healthcare Hub", that subject as the body,
  data `{ type: 'ESCALATION', id: <alertId>, path }`. Web Push is sent with no payload.
- Retries: `retryDelayMinutes` (1, 2, 4, 8, 16 minutes) up to `MAX_DELIVERY_ATTEMPTS` (6), then
  `FAILED`. Rows are `CANCELLED` when the alert is no longer open, the recipient has left or opted
  out, or (push) has no device; a snoozed alert's rows wait for the snooze to end.
