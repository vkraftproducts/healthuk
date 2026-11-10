# Handover: workflow fix programme (continue from here)

Last updated: 6 Nov 2026. Read `CLAUDE.md` first: its non-negotiables still apply to every change.
This file says where the workflow fix programme stands and how to carry on.

## 1. Why this programme exists

A full browser walk-through of every role, combined with research into CQC and UK law, found
99 defects. The worst kind: the app showed things as approved or green when there was no document
or verification behind them. The fix programme is 28 tasks.

- **Defect register (findings 1–99 and a fix plan that maps each task to its findings):**
  https://claude.ai/artifact/8x4UHkYptK4sBNogxWtXxu
- **Workflows doc (the target behaviour, per role and workflow, A1–M):**
  https://claude.ai/artifact/MP5oHVgPACDm3GT8NmA5Ai
  Sections: A Setup, B Staff, C Training, D Vehicles, E Planning, F Crew app, G Audits, actions and
  policies, H Incidents and complaints, I Registration and governance, J Premises, K Data
  protection, L Oversight, M Dental and care home, then a role-by-workflow matrix. Each workflow
  covers steps, system behaviour, rules, failure handling, records kept, how to test it and fixes.

Build each task to match its workflow in that doc.

## 2. Status of the 28 tasks

| #   | Task                                                                                                          | Status                                                  |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Approval gate (no role approval without verified checks)                                                      | Done, tests pass                                        |
| 2   | Driving licence check (verified licence needed to drive)                                                      | Done, tests pass                                        |
| 3   | Honest status ("not set up" instead of green when nothing applies)                                            | Done, tests pass                                        |
| 4   | Requirement library screen                                                                                    | Done, tests pass                                        |
| 5   | Evidence review (view, verify, reject, queue, documents)                                                      | Done, tests pass                                        |
| 6   | Replace browser pop-ups with in-app dialogs                                                                   | Done, tests pass                                        |
| 7   | Defect repair and release                                                                                     | Built; tests written but not yet run (see section 3)    |
| 8   | Dashboard: module filter, owner names, UK date formats                                                        | Built; tests written but not yet run                    |
| 9   | Audits: responses, samples, review, schedule, template view, safe publish and activate                        | Built; tests written but not yet run                    |
| 10  | Policies                                                                                                      | Built; tests written but not yet run                    |
| 11  | Incidents and complaints: reporting obligations, duty of candour                                              | Built; tests written but not yet run                    |
| 12  | Risks and actions                                                                                             | Built; tests written but not yet run                    |
| 13  | Data protection: breach and SAR progression, DP complaints log (new backend), retention approval              | Built; tests written but not yet run                    |
| 14  | Settings and users                                                                                            | Built; tests written but not yet run                    |
| 15  | Registers and forms                                                                                           | Built; tests written but not yet run                    |
| 16  | Role-based navigation and pages; full sign-in list incl. Director, Premises lead, sector users                | Built; tests written but not yet run                    |
| 17  | Browser verification of each batch                                                                            | Deferred: do not do browser checks until the owner asks |
| 18  | Schedule 3 checks and driver eligibility                                                                      | Built; tests written but not yet run                    |
| 19  | Training matrix                                                                                               | Built; tests written but not yet run                    |
| 20  | Harassment duty and speak-up (new backend)                                                                    | Built; tests written but not yet run                    |
| 21  | Registration history, rating display, directors' fit and proper, governance meetings, CQC notification drafts | Built; tests written but not yet run                    |
| 22  | NHS contract items and evidence pack options                                                                  | Built; tests written but not yet run                    |
| 23  | Smaller fixes (from the defect register)                                                                      | Built; tests written but not yet run (finding 99 only)  |
| 24  | Alerts centre                                                                                                 | Built; tests written but not yet run                    |
| 25  | Staff self-service: corrections, due-date change, readiness window, Request review, Book supervision          | Built; tests written but not yet run                    |
| 26  | Vehicle and planner operations                                                                                | Built; tests written but not yet run                    |
| 27  | Data protection logs: disclosures, retention log                                                              | Built; tests written but not yet run                    |
| 28  | Playwright browser tests per role                                                                             | Built; tests written but not yet run                    |

Many API endpoints already exist. Most remaining work is UI on top of them. List the routes in
`packages/contracts/src/routes.ts` before you build anything new.

## 3. What tasks 1–6 changed (where to look)

**Tasks 1–3: staff gates and honest status**

- `packages/domain/src/staff.ts` has `roleChecks()`, `syncStaffRequirements(..., extraRoles)` and
  the licence checks LICENCE_RECORD, LICENCE_EXPIRY and LICENCE_NOT_VERIFIED (state BLOCKED, not
  overridable). `staffStatusSummary` returns GREY plus `setUp` and never NOT_APPLICABLE.
- `apps/api/src/modules/staff/staff.controller.ts` adds:
  - `GET /staff/:id/role-checks/:role` and `POST /staff/:id/role-checks`.
  - Approval refuses when the person is suspended, has no checks set up, or has unverified checks.
    It also enforces the two-person rule (FOUR_EYES_REQUIRED).
  - Lifecycle gates on READY_FOR_REVIEW, APPROVED_FOR_ROLE and ACTIVE.
- Web: `StaffProfile.tsx` (RoleChecks panel, lifecycle and restriction dialogs) and
  `Dashboard.tsx` (the "not set up" banner and tiles).
- In reports, WORKFORCE_READINESS counts a person as ready only when their checks are set up.

**Task 4: requirement library**

- Web: `apps/web/src/pages/settings/LibraryPanel.tsx` is the Settings tab "Requirement library".
  It covers adopt, publish, and mapping requirements to roles.
- API: publishing (`requirements.controller.ts`) now applies the requirement at once to existing
  non-leaver staff, and auto-applies it to vehicles and equipment.

**Task 5: evidence review**

- New API endpoint `GET /api/v1/evidence/review-queue` (needs `compliance.evidence.verify`). It is
  location-scoped and returns `mine` and `requirements[]`.
- Evidence DTOs now carry `uploadedByName` and `reviewerName`.
- New web module `apps/web/src/pages/evidence/Evidence.tsx` contains `uploadFile`, `openEvidence`,
  `UploadDialog` (asks for an expiry when the item has one), `DecisionDialog`, `EvidenceTable`,
  `EvidenceDialog`, `StaffDocuments` and `ReviewQueue`.
- Where it is wired in:
  - Compliance has an "Evidence review" tab, which is the default tab for verifiers.
  - The staff Documents tab.
  - Documents and Upload buttons on staff, vehicle and premises requirements.

**Task 6: pop-ups replaced**

- Every `window.prompt` and `window.confirm` is gone from `apps/web/src`. Do not add them back.
  Use `ActionDialog` from `apps/web/src/components.tsx` instead.
- New API endpoint `GET /api/v1/admin/people`, available to any member. It returns names and roles
  only, for owner pickers.
- New web helpers: `usePeople()` in `pages/settings/hooks.ts` and `PersonSelect` in
  `components.tsx`.

**Task 7: defect repair and release (built 6 Nov 2026; tests not yet run because the agent shell was down)**

- Rules: `repairDueState()` in `packages/rules/src/defects.ts`.
- API (`apps/api/src/modules/fleet/defects.controller.ts`):
  - Signing off a repair needs notes.
  - A signed-off defect is locked, except for making it more serious.
  - Repair notes are added to, never replaced.
  - New `POST /api/v1/defects/:id/reopen` ("Send back for repair", needs `fleet.return_to_service`).
- Defect DTOs now carry `subjectLabel`, `reportedByName`, `classifiedByName`, `repairedBy`,
  `repairedByName`, `repairDue`, and `release.releasedByName` / `release.evidenceItemId`. They are
  built by `defectDtos` / `defectDto` in `fleet.mapper.ts`.
- Web: `apps/web/src/pages/fleet/Defects.tsx` (used by the Fleet tab and the vehicle page) has:
  - The steps Classify, Start repair, Sign off repair, Return to service and Send back for repair.
  - Who did each step, and the repair deadline in words.
  - A "Show: Returned to service" view.
  - The repairer is told someone else must release.
- Tests to run: `apps/api/test/m4.test.ts`, `apps/web/test/fleet.test.tsx` and
  `packages/rules/test/modules.test.ts`. Rebuild packages first.
- Not done: attaching evidence to a release in the UI (the API accepts `evidenceItemId`).

**Task 8: dashboard (built 6 Nov 2026; tests not yet run)**

- Action rows now carry `ownerName` (looked up in `dashboardRows`, `packages/domain/src/governance.ts`).
  The CSV export has an Owner column before Owner id.
- Web `Dashboard.tsx`:
  - The module choice filters the action list only. The summary keeps every module's status.
  - The heading says "– Fleet only", and both clear buttons reset the module.
  - The Owner column shows names, with "(you)" for the viewer.
  - The owner picker uses `usePeople()`, so it is no longer limited to admins.
  - Deadlines use `fmtDate`, and "Last refreshed" uses `fmtDateTime`.
- Tests: `apps/web/test/dashboard-filters.test.tsx`, and `apps/api/test/m5.test.ts` (CSV header and owner name).

**Task 9: audits (built 6 Nov 2026; tests not yet run)**

- API (`apps/api/src/modules/governance/audits.controller.ts`):
  - Activating a template refuses the author of its published version (FOUR_EYES_REQUIRED) and
    refuses a template that is already active (409).
  - Template versions carry `createdBy`/`createdByName`, `approvedByName` and `approvedAt`. Runs
    carry `auditorName`, `ownerName` and `overdue`. Run detail adds `methods` and
    `responses[].recordedByName`.
  - Who activated a template is only in the audit log (`compliance.audit_template.activate`);
    there is no column for it.
- Web:
  - `apps/web/src/pages/compliance/Audits.tsx` (the Audits tab, moved out of `Compliance.tsx`) has
    the schedule with names and overdue in words, a "Schedule an audit" form, a "View controls"
    dialog, and Publish and Activate behind confirm dialogs. The author is told someone else must
    publish or activate.
  - `AuditRun.tsx` has "Record a response" and "Record the sample" forms (sampled items are picked
    by name from staff, vehicles, equipment or locations), a responses history, a confirm dialog for
    submitting, and after submission "Add an observation" and "Raise action" (action or re-audit)
    on failed findings. Dates are UK format.
- Tests: `apps/api/test/m5.test.ts` (activation rule, names, methods) and
  `apps/web/test/compliance.test.tsx` (schedule, templates, carrying out an audit).
- Not done: building or editing template questions in the UI (the API accepts them); "Service" as
  a sample type in the UI.

**Task 10: policies (built 6 Nov 2026; tests not yet run)**

- API (`apps/api/src/modules/governance/policies.controller.ts`):
  - Acknowledging a critical instruction on the web route now needs `confirmCritical: true`, as the
    crew route already did.
  - New `GET /api/v1/policies/:id/readers` (needs `compliance.policy.manage`) lists each required
    reader and whether they have acknowledged the current version; people still to read it first.
  - Policy DTOs carry `ownerName`, `currentVersion.reviewOverdue` and
    `currentVersion.documentEvidenceVersionId`; versions carry `createdByName`, `approvedByName`,
    `approvedAt`, `reviewDate`, `effectiveFrom` and `evidenceItemId`.
- Web `apps/web/src/pages/compliance/Policies.tsx` (moved out of `Compliance.tsx`):
  - Owner names, UK dates and an overdue review shown in words.
  - "Read and acknowledge" opens a dialog with the summary and the document; critical instructions
    need a "read and understood" tick.
  - Send for review, Approve, Publish (with an optional effective date) and Send back to draft are
    confirmed in dialogs. The author is told someone else must approve.
  - "New version" (with a material-change tick), "Details" (history with names, and for managers
    who has not acknowledged), and an "Add a policy" form with owner, readers and optional PDF.
- Tests: `apps/api/test/m5.test.ts` (names, readers, critical confirmation) and
  `apps/web/test/policies.test.tsx`.
- Not done: archiving from the UI; readers without `compliance.requirement.view` cannot open the
  document file (the download route needs that permission).

**Task 11: incidents and complaints (built 6 Nov 2026; tests not yet run)**

- API (`events.controller.ts`): events carry `leadName` and `candourDecided`; `?open=false`
  lists closed events. Detail adds `transitions[].byName`, `candour[].decidedByName`,
  `obligations[].decidedByName`, and `complaint.acknowledgeOverdue` / `respondOverdue` /
  `preferences`.
- Web:
  - `pages/compliance/Events.tsx`: the Events tab with Show (open, closed, all) and Type filters,
    names, harm and stage in words, the candour flag in words, and a "Report an event" form
    (complaint and safeguarding details appear when ticked).
  - New page `/compliance/events/$id` (`EventDetail.tsx`): the stage strip, what blocks the next
    stage, Move on and Reopen with a note, the duty of candour decision, reporting duties (add,
    decide with a reason, record submission), complaint targets and acknowledgement/response,
    restricted safeguarding details, actions, and the history with names.
  - Labels are in `pages/compliance/eventLabels.ts`. Event actions in the Actions tab now link to
    the event page.
- Tests: `apps/api/test/m5.test.ts` and `apps/web/test/events.test.tsx`.

**Task 12: risks and actions (built 6 Nov 2026; tests not yet run)**

- API:
  - Actions carry `ownerName` and `history[].byName` on the list, single action, audit run detail
    and event detail (`withActionNames` in `audits.controller.ts`).
  - New `PATCH /api/v1/actions/:id` (`compliance.action.manage`, If-Match) changes the owner or the
    deadline of an action that is not verified. A reason is required and goes into the action's
    history. Past deadlines are refused.
  - Risks carry `ownerName`, `linkedEvents` (code and title) and `openActions` (actions raised from
    the risk that are not verified).
- Web:
  - `pages/compliance/Risks.tsx` (moved out of `Compliance.tsx`): ratings with likelihood × impact
    in words, owner names, overdue reviews, links to linked events and open actions, and a "Show
    closed risks" tick. Managers can add a risk (1–5 scales with words), review it (controls,
    residual scores, owner, next review date), raise an action, and close or reopen it.
  - Actions table: owner names, UK deadlines with overdue in words, and "Change owner or deadline"
    for managers.
  - Registration correspondence deadlines and export times now use UK formatting.
- Tests: `apps/api/test/m5.test.ts` ("risk actions and action changes") and
  `apps/web/test/risks.test.tsx`.

**Task 13: data protection (built 6 Nov 2026; tests not yet run)**

- Database: new migration `packages/db/sql/migrations/0018_dp_complaints.sql` adds
  `retention_rule.changed_by` and a `dp_complaint` table (tenant isolation plus the
  `privacy.manage` restrictive policy). The Prisma schema has the matching `DpComplaint` model and
  `RetentionRule.changedBy`. Run migrations and regenerate the Prisma client before testing.
- API (`apps/api/src/modules/privacy/privacy.controller.ts`):
  - Retention: a change records who made it; that person cannot approve it
    (`FOUR_EYES_REQUIRED`), and approving an approved rule is refused. Rules carry
    `changedByName` and `approvedByName`.
  - Subject requests carry `staffName`, `handledByName`, `latestExtension` and `completedAt`.
    A request cannot move to in progress or completed before identity is verified.
  - Breaches carry description, occurred time, data types, estimate, containment, decision
    maker's name, late reason and when people were told. Legal holds carry `placedByName`.
  - New complaints log: `GET/POST /dp-complaints`, `POST /dp-complaints/:id/acknowledge`,
    `POST /dp-complaints/:id/resolve`. Acknowledgement is due 30 days after receipt, and the
    outcome needs an acknowledgement first. Code prefix `DPC` was added to `nextCode`.
- Web (`apps/web/src/pages/settings/PrivacyPanel.tsx`, rewritten): change and approve retention
  rules in dialogs; place and release legal holds (whole organisation or a staff member); log
  requests with a staff picker, then verify identity, start, extend, complete, refuse or build the
  export; record breaches with full details, then assess, record the ICO report (late reasons when
  past 72 hours) and close; log, acknowledge and resolve complaints. UK dates throughout.
- Tests: `apps/api/test/m8.test.ts` (retention approval now by `dev|governance`, identity rule,
  breach names, complaints) and `apps/web/test/privacy.test.tsx`.
- Not done: holds on a journey, event or vehicle from the UI (the API supports them).

**Task 14: settings and users (built 6 Nov 2026; tests not yet run)**

- Contracts (`packages/contracts/src/admin.ts`): `SECTOR_PACKS` (known packs only),
  `MembershipChange`, `NON_INVITABLE_ROLE_KEYS` (`PLATFORM_SUPPORT`), `NOTIFICATION_EVENTS`, and
  `OrgSettings.notificationRules` (event, roles, email). `AuditEntryDto.actorName`; workbook items
  carry `proposedByName` and `decidedByName`, and a reject needs a note of at least 3 characters.
- API:
  - `PATCH /admin/memberships/:id` changes a role or location by ending the current membership
    and starting a new one (history kept, reason required, audit `admin.membership.change`,
    permission cache cleared). You cannot change your own membership, add one to yourself or
    revoke yourself (403). An ended membership is 409; no change is 400.
  - Support access can never be granted as a role (403); it stays time-limited under Support
    access.
  - The audit log list returns `actorName`.
- Web (`apps/web/src/pages/settings/Settings.tsx`, rewritten; `DataPanel.tsx` workbook section):
  edit organisation name and sector packs; archive or restore locations and services in dialogs;
  invite with an optional location (support role not offered); change role or location per
  membership; revoke in a dialog, never yourself; a Notifications tab (due-soon days, email
  reminders, roles and email per event); a readable audit log with plain-English actions, names,
  London times, an area filter and an audit-trail check; workbook propose, approve and reject
  dialogs, with the proposer barred from deciding their own mapping.
- Tests: `apps/api/test/m1.test.ts` (membership change, self refusal, support role refusal,
  audit names, workbook reject note), `apps/web/test/data-panel.test.tsx` (reject reason,
  proposer barred).
- Not done: notification rules are stored but delivery does not use them yet. The alerts centre
  (task 24) must read them.

**Task 15: registers and forms (built 6 Nov 2026; tests not yet run)**

- Scope note: the defect register and workflows doc were not readable from the agent session
  (external links and a `.docx`), so this task was scoped from the existing screens: the
  equipment and fuel/expenses registers were the ones without forms, names or UK dates.
- Contracts (`packages/contracts/src/fleet.ts`): `ExpenseDecision` refuses a rejection without a
  note (3+ characters). `ExpenseDto` gains optional `vehicleLabel`, `submittedByName` and
  `decidedByName`.
- API (`fleet/defects.controller.ts`, `ExpensesController.list`): the register returns the
  vehicle callsign and registration and the submitter and decider names, so crew without vehicle
  access still see readable rows.
- Web (`apps/web/src/pages/fleet/Fleet.tsx`):
  - Equipment: where it is kept (vehicle or base), make/model/serial, "No inspection regime set
    up" in words, an "Add equipment" form, and an "Add inspection regime" dialog that offers only
    published organisation EQUIPMENT templates and explains the regime starts as awaiting evidence.
  - Fuel and expenses: UK dates, vehicle and claimant names, status as badges (awaiting approval,
    approved, rejected) with who decided and the note, a duplicate badge, a status filter, approve
    and reject in dialogs (reject needs a reason; your own claim says someone else must approve),
    and a "Submit a claim" form. People without vehicle access open straight on this tab.
- Tests: `apps/api/test/m4.test.ts` (rejection needs a note, names on the register) and
  `apps/web/test/registers.test.tsx`.
- Follow-up (defect register findings, 6 Nov 2026; tests written, not run):
  - Migration `0024_registers_and_exceptions.sql`: `vehicle.gross_weight_kg` (500–44,000) and the
    table `allocation_exception_request` (immutability trigger once decided, the asker can never
    be the decider, RLS `tenant_isolation`, grants SELECT, INSERT, UPDATE). `schema.prisma` has
    `Vehicle.grossWeightKg` and `AllocationExceptionRequest`; added to the full data export.
  - 7 (checklists): new "Inspection checklists" tab on Fleet to publish a checklist version
    (items, critical flag) and retire one (`FleetRegisters.tsx`, `VdiChecklists`).
  - 39 (vehicle register): VIN, ownership, licence category, gross vehicle weight and permitted
    loads on create and edit (`PATCH /vehicles/:id` with If-Match); vehicle page tab "Register
    details" with statutory document badges; Documents tab "Add a document requirement" (only
    published organisation VEHICLE templates not yet applied).
  - 41 (odometer): `VehicleDto.latestReading {reading, readOn}`; `currentOdometer` is null until a
    reading exists. The list shows "42,000 mi (30 Oct 2026)" or "No readings".
  - 42, 43 (add vehicle): browser checks plus server field errors in one summary naming each
    field; the duplicate message says whether the registration or the callsign clashes.
  - 44 (equipment): details panel listing each inspection regime by name, and an edit dialog
    (serial, manufacturer, model, safe working load, kept on a vehicle or at a base) using the
    version.
  - 45 (receipts): the claim form uploads the receipt first and sends `receiptEvidenceItemId`;
    the register has a Receipt column.
  - 49 (staff record forms, `pages/staff/RecordForm.tsx` only; props unchanged): readable labels
    and options, "(optional)" markers, licence categories as checkboxes, person pickers, a course
    picker for training (organisation STAFF templates), a missing-fields alert, and "Upload
    certificate" against the person's matching requirement.
  - 64, 65 (premises): names from the server (`responsibleName`, `actionOwnerName`), the schedule
    title and deadline kind; "Same as responsible person" is stored as that person. Only adopted
    (non-library) published schedules are offered; a library template returns
    TEMPLATE_NOT_PUBLISHED in words. New `PATCH /premises-items/:id` (If-Match) and
    `POST /premises-items/:id/schedule` (no past due date; 409 if already linked). Row actions:
    Edit, Link a schedule, Upload evidence, Mark not applicable.
  - 73 (reports): the FLEET report counts open defects as anything not RELEASED and gives the
    blocked reason from the live stop-use count.
  - Tests: `apps/web/test/registers-forms.test.tsx` (new), `apps/web/test/premises.test.tsx`
    (date text), and `apps/api/test/registers.test.ts` (new).
- Not done or unsure:
  - Staff record forms: `RecordForm.tsx` sits next to the staff pages another worker was editing;
    it was changed on its own, without touching `StaffProfile.tsx`. Check for merge overlap.
  - The certificate upload needs a STAFF requirement instance for the course; without one it says
    so instead of storing unlinked evidence.
  - `VehicleDto.currentOdometer` is now null for vehicles without readings; any other caller that
    assumed a number should be checked.
  - The expense receipt upload uses the shared `uploadFile`; if the claim then fails, the uploaded
    item stays unlinked (unverified, so it never turns anything green).

**Task 16: role-based navigation and sign-in list (built 6 Nov 2026; tests not yet run)**

- Seed (`packages/db/src/admin/seed.ts`): two new synthetic users in Meadowbank, `dev|director`
  (Dee Rector, DIRECTOR) and `dev|premises` (Priya Mason, PREMISES_LEAD). Re-run `pnpm db:seed`.
- Web:
  - `apps/web/src/nav.ts`: each item has `anyOf` permissions; `canSee()` and `navItemFor()`.
    New items "My record" (`staff.self.view`, task 25) and "Alerts"
    (`compliance.requirement.view`, task 24).
  - `Shell.tsx` shows only the items the role can use. Without `dashboard.view` the first item
    reads "Home".
  - `App.tsx`: every page route (and the staff, vehicle, audit and event detail routes) is wrapped
    in a guard that shows "Your role does not give access to this page" with a link home. The home
    route shows the dashboard to roles that have one and otherwise a "Welcome" page listing the
    role's pages. The server still checks every call.
  - `auth.ts` / `SignIn.tsx`: the development sign-in lists every seeded user grouped by
    organisation: Meadowbank (manager, director, HR, fleet, premises, governance, dispatcher,
    auditor, two crew), the other organisation (manager, crew) and the dental and care home mock
    users from `pnpm db:seed:sectors`.
- Tests: `apps/api/test/workflows.test.ts` (director and premises sign-in), and in
  `apps/web/test`: `app.test.tsx` (navigation per role, guard), plus updated expectations in
  `sign-in.test.tsx`, `staff.test.tsx`, `planner.test.tsx` and `reports.test.tsx`.
- Not done: the Maestro mobile flows and Playwright still only use the original users; the
  `dev|support` user is not offered (support access is grant-based, not a membership).
- Defect-register follow-up (6 Nov 2026; tests written, nothing run or built):
  - Closed:
    - 9 and 30: new seeded `dev|orgadmin` (Olu Adeyemi, ORG_ADMIN). The sign-in page lists
      every seeded user, including the dental and care home logins.
    - 16 and 95: nav items can carry `pack: 'ambulance'`. Vehicles and Work planner are hidden
      (and their routes refused) where the organisation's `sectorPacks` lack ambulance. `/me`
      memberships now return `sectorPacks`.
    - 23 and 88: new `packages/rules/src/visibility.ts`. The dashboard API returns
      `visibleModules`/`visibleTiles` and leaves out rows, tiles and module status the role
      cannot open (fleet and jobs also need the ambulance pack). The web subtitle names the role.
      A role with no figures (org admin) is told so.
    - 25: AUDITOR gains `admin.audit.view`, synced on migrate.
    - 84: reports are filtered by `canRunReport` (permission for what the report covers, plus
      the sector). Running a refused report returns 403. The web runs the first report listed
      and explains when export is not allowed.
    - 91: penalty points are removed from licence records and from driver eligibility for
      anyone without `staff.profile.manage` or `staff.sensitive.view`.
    - 92: an unknown sign-in gets 401 "No Healthcare Hub account exists for this sign-in". The
      web says "This account does not exist in Healthcare Hub."
    - 22: crew see a "Your shifts are in the crew app" section on Home. Crew no longer get
      Vehicles in the web nav (expenses are in the crew app).
    - 99: already fixed (task 23).
  - Partly done:
    - 20, 21 and 81: the Compliance shell only shows Audits with `compliance.audit.view` and
      always selects a visible tab. Crew no longer reach Vehicles. Still open: the Fleet page
      Expenses tab for governance, dispatcher and auditor needs a fleet page change (another
      worker's area).
    - 26: Reports now explains missing export. Fleet and dispatcher are still not given Export
      or Request pack (that would be a permission change).
    - 82: crew can upload a certificate from My record (verification by someone else is still
      needed). Defect and incident reporting stay in the crew app.
    - 90: a tab is always selected. HR still cannot report an incident: there is no
      any-role incident endpoint.
  - Tests: `packages/rules/test/visibility.test.ts`, `apps/api/test/role-scope.test.ts`,
    `apps/api/test/m10.test.ts`, `apps/web/test/app.test.tsx`, `reports.test.tsx`,
    `sign-in.test.tsx`.

**Task 18: Schedule 3 checks and driver eligibility (built 6 Nov 2026; tests not yet run)**

- Rules (`packages/rules/src/schedule3.ts`): `schedule3Checks()` returns the eight Schedule 3 /
  reg 19 items (identity, enhanced DBS and barred list, conduct references, why earlier care
  work ended, qualifications and registration, full employment history with gaps over 31 days
  explained, health, right to work). An item is green only when recorded and its requirement
  has evidence verified by a second person; recorded but unverified is amber; missing or
  needing attention is red, always with words. `driverEligibility()` checks the Driver role
  approval, no driving restriction, licence recorded and verified, category, photocard in date
  and a DVLA check within 6 months (fail), and 6+ penalty points (warning only).
- Contracts: employment history gains `careRole` and `reasonForLeaving` (the generated record
  form shows them automatically); new `Schedule3Dto`, `DriverEligibilityQuery`,
  `DriverEligibilityDto`.
- API (`staff.controller.ts`): `GET /staff/:id/schedule-3` (needs `staff.profile.manage` and
  `staff.sensitive.view`, audited as `staff.schedule_three.view`; audit actions allow letters and underscores only) and
  `GET /staff/:id/driver-eligibility?category=` (basic or clearance view, so dispatch can see
  it). Requirements are matched to items from the template code and title
  (`schedule3ItemsFor`: STF-02 DBS, STF-03 identity and right to work, STF-04 references and
  history).
- Web (`apps/web/src/pages/staff/Schedule3.tsx`, shown on the profile's Recruitment tab): the
  Schedule 3 checklist (only for people with sensitive access) and driver eligibility with a
  licence category picker.
- Tests: `packages/rules/test/schedule3.test.ts`, `apps/api/test/workflows.test.ts`,
  `apps/web/test/staff.test.tsx`.
- Not done: Schedule 3 is not a hard gate on role approval (the task 1 role checks remain the
  gate, and a new gate would have broken the existing approval flow); driver eligibility is
  informational and does not change job allocation, whose gates are unchanged. Qualifications
  are matched by title keywords, so an organisation with unusual template titles may see "no
  requirement covers this yet".
- Defect-register follow-up (6 Nov 2026; tests written, nothing run or built). This supersedes
  the "not a hard gate" note above:
  - Schedule 3 now gates role approval. For regulated roles (`SCHEDULE3_ROLES`: driver, care
    assistant, ECA, technician, paramedic, nurse, dentist, dental nurse, senior carer,
    activities coordinator), `POST /staff/:id/role-approvals` returns 422 with one
    `SCHEDULE3_<item>` check per blocker. A blocker is anything missing or needing attention,
    or whose requirement has unverified evidence. The gate runs after the four-eyes check. The
    test harness (`recordSchedule3`) and the demo data now record a synthetic Schedule 3 file
    before approval.
  - Licence category from weight: `drivingCategoryFor()` makes a B family category C1 over
    3,500 kg, and C over 7,500 kg. Shift and allocation readiness pass the vehicle's
    `grossWeightKg` (`packages/domain/src/staff.ts` and `dispatch.ts`).
  - 48: licence records take an optional encrypted DVLA `licenceNumber`; people without
    manage/sensitive access see only the last 4. The profile shows the licence in words (who
    recorded it and when). Records can be corrected through a superseding record. Licence
    records appear in History.
  - 53: Add staff takes work email, start date, contract type and line manager, and can start
    checks for a role straight away. This needs migration `0025_staff_sector_roles.sql`.
  - 89: seed ambulances are C1 at 4,250 kg (AMB-01) or B at 3,500 kg; the demo ambulances are
    C1 at 4,250 kg.
  - 96: new staff roles DENTIST, DENTAL_NURSE, RECEPTIONIST, SENIOR_CARER and
    ACTIVITIES_COORDINATOR. Sector staff get an approved role. Role pickers offer the sector's
    roles only (`staffRolesFor`). Profiles say "No approved role yet" instead of N/A.
  - Tests: `packages/rules/test/schedule3.test.ts`, `apps/api/test/m3.test.ts` (approval
    refused before the Schedule 3 file), `role-scope.test.ts`, `demo-data.test.ts`,
    `m10.test.ts`, `apps/web/test/staff.test.tsx`.
  - Not done: the licence number field in the record form (`RecordForm.tsx` belongs to the
    other worker; the API accepts it). Vehicle edit screens are unchanged (fleet area).

**Task 19: training matrix (built 6 Nov 2026; tests not yet run)**

- Rules (`packages/rules/src/matrix.ts`): `matrixCellState()` (met only when the item is green,
  i.e. verified; due soon; overdue; missing, including no record at all; not required),
  `summariseMatrixColumn()` and `matrixRowHasGap()`.
- Contracts: `MatrixQuery` (`role`, `locationId`, `templateId`, `gapsOnly`); `MatrixDto` gains
  per-column `roles` and `summary` totals, per-row `hasGap`, per-cell `state`, and `truncated`
  (the matrix is capped at 500 people). All new fields are optional so older clients still parse.
- API: `GET /staff/training-matrix` takes the new filters and returns the totals.
- Web: the Staff page has "Register" and "Training matrix" tabs (the matrix needs
  `staff.profile.view_basic`, so dispatch does not see it). The matrix page
  (`apps/web/src/pages/staff/TrainingMatrix.tsx`) has role, requirement and "only people with
  something overdue or missing" filters, a totals table per requirement (met of required, with
  a percentage) and the person-by-requirement grid, each cell a badge in words with the next
  date.
- Tests: `packages/rules/test/matrix.test.ts`, `apps/api/test/workflows.test.ts`,
  `apps/web/test/staff.test.tsx`.
- Not done: no CSV export of the matrix (the reports module exports remain the route for that);
  the cell status is the stored status, refreshed by the existing recompute job, not
  re-evaluated per request.

**Task 20: harassment duty and speak-up (built 6 Nov 2026; tests not yet run)**

- Migration `packages/db/sql/migrations/0019_speak_up_harassment.sql` (Prisma models
  `SpeakUpConcern`, `SpeakUpNote`, `HarassmentRiskAssessment`):
  - `speak_up_concern`: tenant RLS plus restrictive policies. Reading needs `speakup.manage`, or
    being the named raiser; updating needs `speakup.manage`. Anonymous concerns store no raiser
    and, when raised in the hub, no recorder (database CHECKs enforce both).
  - `speak_up_note`: append-only (SELECT, INSERT only), handlers only.
  - `harassment_risk_assessment`: draft, approved (frozen by a trigger) or superseded; the
    approver must differ from the preparer (CHECK and API).
  - `restricted_for_dispatch_and_crew()` now includes `speakup.manage`.
- Permissions (`rbac.ts`): `speakup.raise` (every system role except auditor and platform
  support; also a self-service permission), `speakup.manage` (registered manager, director, HR
  lead; restricted for dispatch and crew), `harassment.manage` (registered manager, director, HR
  lead). They are synced by `syncSystemRoles()` after migrations.
- Codes: new `SPK` prefix in `nextCode`.
- Rules (`packages/rules/src/speakup.ts`): acknowledgement due in 7 days, detriment check 90
  days after closing, `speakUpCloseBlocker()` (named concerns need feedback recorded before
  closing), and `harassmentDutySteps()` (risk assessment, policy, training, acknowledgements,
  detriment checks). The steps never say the duty is met; the API adds a note that whether the
  steps are reasonable is the organisation's judgement.
- API (`apps/api/src/modules/speakup/speakup.controller.ts`): raise (named or anonymous; the
  anonymous audit event has no actor), my concerns, the handler list and detail (detail view
  audited), record a concern received another way, acknowledge (handler cannot be the raiser),
  start, notes (feedback and detriment checks are notes; detriment checks only after closing),
  close; risk assessments list, create draft, edit draft (If-Match), approve; prevention steps.
- Web (`apps/web/src/pages/speakup/SpeakUp.tsx`, new "Speak up" navigation item): tabs "Raise a
  concern" (anonymous option with a plain explanation), "My concerns", "Concerns" (handlers:
  status in words including overdue acknowledgement, detail with history, acknowledge, start,
  note, close dialogs, and a form to record concerns received another way) and "Harassment
  prevention" (the steps with badges, risk assessment drafts with a risk editor; the preparer is
  told someone else must approve).
- Tests: `packages/rules/test/speakup.test.ts`, `apps/api/test/workflows.test.ts` (named flow,
  anonymous storage, assessment approval and freeze, duty steps), `apps/web/test/speakup.test.tsx`
  and the crew navigation expectation in `apps/web/test/app.test.tsx`.
- Not done / to decide:
  - The raiser's identity is visible to every `speakup.manage` holder, including the registered
    manager and director. An organisation with an independent Freedom to Speak Up guardian may
    want only the guardian to hold it (a custom role can do this).
  - Request logs may still record the user and time of an anonymous submission; check log
    retention and access before relying on anonymity.
  - No alerts or notifications for overdue acknowledgements yet (task 24 can add them); the
    policy and training steps are found by "harass" in the title.

**Task 21: registration history, rating display, directors' fit and proper, governance meetings,
CQC notification drafts (built 6 Nov 2026; tests not yet run)**

- Migration `packages/db/sql/migrations/0020_governance_records.sql` (Prisma models
  `RegistrationHistory`, `CqcRatingRecord`, `DirectorFppCheck`, `GovernanceMeeting`,
  `CqcNotification`), all with tenant RLS:
  - `registration_history`: append-only snapshot written on every registration save, with the
    fields that changed and an optional reason.
  - `cqc_rating_record`: the rating exactly as CQC published it, display due 21 days after
    publication (reg 20A), and the premises and website display dates. A trigger refuses any
    change except the display dates.
  - `director_fpp_check`: append-only; a restrictive policy means only
    `governance.fit_proper.manage` can read or write; a CHECK stops someone recording their own.
  - `governance_meeting`: draft minutes, approved by someone other than their last editor
    (CHECK and API) and then frozen by a trigger. The `action.source_type` CHECK now allows
    `MEETING`.
  - `cqc_notification`: draft, reviewed ("ready", by someone other than the preparer), submitted
    (date and CQC reference) or not required (with a reason).
  - `restricted_for_dispatch_and_crew()` now includes `governance.fit_proper.manage`.
- Permissions: `governance.meeting.manage` and `governance.fit_proper.manage` (registered
  manager, director and governance lead). Ratings and history use the existing
  `compliance.registration.manage` (view also with `compliance.audit.view`); notifications use
  `events.event.manage` (view also with `compliance.registration.manage`).
- Codes: new `MTG` and `NTF` prefixes (`CodePrefix` type in `domain/governance.ts`).
- Rules (`packages/rules/src/regulatory.ts`): `ratingDisplayState()`, `fppState()` and
  `fppOutstanding()` with nine check items and a 12-month review, `notificationTargetDate()`
  (next day; a planned manager absence 28 days before it starts), `suggestNotificationKind()`
  (death, safeguarding, severe harm), `notificationState()`, `CQC_NOTIFICATION_NEXT`.
- API: `POST /registration` now writes history (body takes an optional `reason`); new
  `apps/api/src/modules/governance/regulatory.controller.ts` with registration history, CQC
  ratings (record, display dates with If-Match), fit and proper (list audited, record),
  governance meetings (list, get, record, edit draft, approve, raise action) and CQC
  notifications (list, suggestions from recent events, draft, edit draft, transition).
- Web (`apps/web/src/pages/compliance/Regulatory.tsx`): the Registration tab gains an edit form,
  the change history and the rating display panel; new Compliance tabs "Governance meetings",
  "Fit and proper" and "CQC notifications". Actions from meetings link back to the meetings tab.
- Tests: `packages/rules/test/regulatory.test.ts`, `apps/api/test/workflows.test.ts` (task 21
  block), `apps/web/test/regulatory.test.tsx`.
- Not done / to decide:
  - The hub never sends notifications to CQC; the target date is an internal prompt, not legal
    advice. Kinds and wording should be checked against the current CQC notification forms.
  - Notification text is checked only for NHS-number-like digits; it cannot detect names.
  - Marking a notification "not required" needs one person (with a reason), not two.
  - Fit and proper checks record that items were done, not the documents; evidence upload for
    them is not wired in. The DBS outcome itself is never stored.
  - The rating display panel trusts the dates entered; no check of the website.

**Task 22: NHS contract items and evidence pack options (built 6 Nov 2026; tests not yet run)**

- Migration `packages/db/sql/migrations/0021_nhs_contract.sql`:
  - A new library pack `NHS_CONTRACT_V1` with 15 organisation-level items (DSPT, EPRR, PSIRF,
    LFPSE, Freedom to Speak Up, safeguarding leads, IG roles, business continuity test,
    indemnity, counter-fraud, Accessible Information Standard, WRES/WDES, carbon reduction plan,
    modern slavery statement, the commissioner report). Synthetic starting content marked "check
    against your contract"; no clause numbers are quoted. They work like the ambulance pack:
    adopt, a second person publishes, and an item is green only with verified evidence.
  - `nhs_contract` (Prisma `NhsContract`): commissioner, reference (unique), service, type,
    start and end, notice months, reporting frequency, contract manager, next review meeting.
    Tenant RLS; no deletes.
- Rules (`regulatory.ts`): `contractNoticeBy()`, `contractState()` (not started, running, notice
  date reached, ended), `isNhsContractItem()` (NHS pack or a code starting `NHS-`),
  `summariseContractItems()`.
- API (`regulatory.controller.ts`): `GET /nhs-contracts` (contracts, NHS item statuses from the
  requirement instances, totals, and how many library items are not adopted), `POST` and
  `PATCH /nhs-contracts/:id` (If-Match). Manage with `compliance.registration.manage`; view
  also with `compliance.audit.view`.
- Evidence pack options (`EvidencePackInput`, `buildEvidencePack`): `purpose` (inspection, NHS
  commissioner, internal; the NHS pack keeps only NHS contract items), `sections`
  (requirements, audits, actions, policies, governance, contracts), `includeFiles` (false gives
  an index-only pack), `gapsOnly`. New "Registration and governance" section (ratings as CQC
  published them, meetings, notifications by code and kind only) and "NHS contracts" section.
  Reviewer and policy approver names now replace raw user ids in the index. Older queued jobs
  without options produce the same pack as before.
- Web: new Compliance tab "NHS contracts" (contracts table with notice state, NHS items table,
  record form, change dialog for end date and notice); the evidence pack form gains purpose,
  section checkboxes, index-only and gaps-only; the Library shows the new pack name.
- Tests: `packages/rules/test/regulatory.test.ts`, `apps/api/test/workflows.test.ts` (task 22
  block, including a built NHS pack), `apps/web/test/regulatory.test.tsx`.
- Not done / to decide:
  - Contract KPIs and activity figures are not recorded; the monthly report is tracked as an
    item with evidence only.
  - Items are not linked to a particular contract; with several contracts, all share one item
    list.
  - The NHS items need checking by someone who knows the current NHS Standard Contract.
  - Open actions in the pack are still not filtered by location or domain (unchanged).

**Task 23: smaller fixes (built 6 Nov 2026; tests not yet run)**

- Scope note: the defect register was not readable from the agent session, so only finding 99
  (listed under known issues) was fixed. Other findings for this task still need picking up.
- Finding 99 (`apps/web/src/App.tsx`, `Authenticated`):
  - A stored `hub.orgId` is dropped when it is not among the person's memberships and the server
    did not accept it as the active organisation (support access is still honoured). The first
    membership is then selected and stored.
  - If `/me` refuses the stored organisation (400, 403 or 404), the stored id is forgotten and
    `/me` is asked again without one, instead of showing "Your account is not active here".
  - With no memberships at all, the stored id is simply cleared.
- Tests: `apps/web/test/app.test.tsx`, "stored organisation selection (task 23)".
- Defect-register follow-up (6 Nov 2026; tests written, nothing run or built):
  - 17 (closed): seed renames "Example organisation" to Meadowbank Patient Transport
    (only while it still has the old name). Shell service names use the `care_home` key. The
    breadcrumb follows the route.
  - 18 (closed): AC-07 is now "Premises, vehicles and equipment". An existing template is
    renamed only if it still has the old title.
  - 24 (closed): demo data adds three synthetic premises register items (fire, water,
    oxygen). They have no linked schedule, so nothing shows as met.
  - 98 (closed): the dental and care home mock organisations get mock services and registered
    activities (`seed-sectors.ts`).
  - Tests: `apps/api/test/demo-data.test.ts`, `m10.test.ts`.

**Task 24: alerts centre (built 6 Nov 2026; tests not yet run)**

- Rules (`packages/rules/src/alerts.ts`): `readNotificationRules`, `rolesForEvent`,
  `emailRolesForEvent`, `toldByRule`, `alertEvent`, `alertLink`, `compareCentreItems`.
- API: `GET /api/v1/alerts/centre` in `alerts.controller.ts` (any member). It gathers:
  - stored alerts the person owns, was notified about, is named for by a rule, or whose area their
    role covers (requirements, breaches and retention, defects, jobs);
  - overdue actions and audits (owner or auditor, rule roles, action managers);
  - incidents and events reported in the last 7 days (lead, rule roles, event managers), code only;
  - policies published in the last 14 days (owner, rule roles, readers who have not acknowledged).
    Each item says why it is shown (`why`). Filters: `event`, `includeAcknowledged`.
- Notification planning (`packages/domain/src/notifications.ts`) now honours
  `OrgSettings.notificationRules`: EXPIRY_WARNING rules add deliveries for the named roles (email
  only when both the rule and the organisation's email switch allow it); BREACH_RECORDED rules send
  open breach alerts to the named roles. Breach emails carry the reason code and a link only.
- Web: `apps/web/src/pages/alerts/Alerts.tsx` at `/alerts`. Table "Your alerts", "Show" filter,
  "Only things I own or was told about", "Include acknowledged alerts", Acknowledge and Snooze
  dialogs (need `compliance.requirement.manage`, as before), and "Who is told about what". The
  navigation item now also shows for action, audit, event, privacy, dispatch and defect roles.
- Tests: `packages/rules/test/alerts-centre.test.ts`, `apps/web/test/alerts.test.tsx`, and the
  task 24 block in `apps/api/test/workflows.test.ts`.
- Not done:
  - ACTION_OVERDUE, AUDIT_OVERDUE, INCIDENT_REPORTED and POLICY_PUBLISHED rules show in the alerts
    centre only; they do not send email yet (there is no stored alert for them to deliver).
  - Defect, job and retention alerts are not routable by a rule (no matching event in settings).
  - No API test drives `planNotifications` with a rule, to avoid clashing with the m2 dedupe test
    on the shared database.

**Task 25: staff self-service, "My record" (built 6 Nov 2026; tests not yet run)**

- Migration `0022_staff_self_requests.sql`: table `staff_self_request` (kinds DUE_DATE_CHANGE,
  REVIEW, SUPERVISION; statuses OPEN, ACCEPTED, DECLINED, WITHDRAWN). Checks: decider is not the
  requester; a declined request has a note; accepted supervision has `booked_for`; one open
  request per item and kind. A trigger freezes closed requests. RLS and grants (no delete).
  `schema.prisma` model `StaffSelfRequest`; added to the full data export.
- Contracts (`packages/contracts/src/staff.ts`): `SelfRequestInput` (discriminated on `kind`),
  `SelfRequestDecision`, `SelfRequestDto`, `MyReadinessQuery` (window up to 31 days).
- API (`apps/api/src/modules/staff/self-service.controller.ts`, `StaffSelfServiceController`):
  - `GET /staff/me/readiness`, `GET /staff/me/requests`, `POST /staff/me/requests`,
    `POST /staff/me/requests/:id/withdraw` (If-Match).
  - `GET /staff/self-requests` and `POST /staff/self-requests/:id/decide` (If-Match).
  - Only your own requirement items (others are 404). Expiry dates cannot be moved (422). At most
    10 open requests.
  - Deciding: date changes need `compliance.due_date.change`; reviews need `staff.profile.manage`
    or `compliance.evidence.verify`; supervision needs `staff.profile.manage`, or the named
    supervisor. Never the requester (422).
  - Accepting a date change writes the `due_date_change` log (decider as approver), moves the
    date and recomputes the item. Reviews and supervision never change a status.
- Web:
  - `apps/web/src/pages/me/MyRecord.tsx` at `/me`: record summary, table "My requirements" with
    "Change date" and "Request review" dialogs, "Check my readiness", "Book supervision", table
    "My requests" with Withdraw, "Ask for a correction", and table "My correction requests".
  - `StaffRequestsQueue` on the Staff page: "Staff requests waiting for a decision" and
    "Correction requests waiting for HR", with Accept, Decline, Applied and Reject dialogs.
- Tests: `apps/web/test/my-record.test.tsx` and the task 25 block in
  `apps/api/test/workflows.test.ts`.
- Not done or unsure:
  - Two API tests skip their second half if the seeded crew member has no requirement items, or
    no item governed by a due date.
  - Correction rows carry no staff name (the existing `CorrectionDto` has only `staffId`), so the
    Applied and Reject buttons name the field, not the person.
  - Booking supervision does not create a calendar entry or a supervision record. Acceptance
    stores the agreed time only.
  - Accepting a correction still means HR edits the record by hand (unchanged behaviour).
- Defect-register follow-up (6 Nov 2026; tests written, nothing run or built):
  - 14: already done (task 25).
  - 15 (closed): managers raise "Request review" (per requirement) and "Book supervision"
    from the staff profile through `POST /staff/:id/requests`. These join the same queue, and
    the requester cannot decide them. The profile lists them in "Review and supervision
    requests". Withdraw is refused for requests someone else raised.
  - 50 (closed): the profile offers "Upload renewal evidence" for verified items, plus Request
    review and Book supervision dialogs (no inline forms). My record offers "Upload
    certificate".
  - 51 (closed): the profile header shows location, line manager, start date, contract and a
    Readiness badge in words. It never shows "N/A".
  - Tests: `apps/api/test/role-scope.test.ts`, `apps/web/test/staff.test.tsx`,
    `my-record.test.tsx`.

**Task 26: vehicle and planner operations (built 6 Nov 2026; tests not yet run)**

- Migration `0023_vehicle_status_change.sql`: append-only table `vehicle_status_change` (flag
  OFF_ROAD or QUARANTINE, on or off, reason, jobs released, who, when). `forbid_mutation` trigger,
  RLS and grants (SELECT, INSERT only). `schema.prisma` model `VehicleStatusChange`; added to the
  full data export.
- API:
  - `POST /vehicles/:id/off-road` and `/quarantine` now store the reason. Turning a flag off
    also needs `fleet.return_to_service` (403 otherwise). Turning one on releases jobs that have
    not started on that vehicle (same path as a stop-use defect: jobs go to REASSIGNED, crew are
    pushed, control gets a JOB_NEEDS_REASSIGNMENT alert with the job code only).
  - `GET /vehicles/:id/status-history`. `VehicleDto` gained `offRoad` and `quarantined`.
  - `POST /shifts/:id/cancel { reason }` (`jobs.allocate`): planned shifts only; refuses if a job
    is under way. Releases its jobs with an alert, withdraws crew, frees the vehicle and crew
    bookings, writes a CANCELLED shift change and pushes to the crew.
- Web:
  - Vehicle page, new tab "Status and readiness": "Vehicle status" with take off road,
    quarantine, put back on the road and lift quarantine dialogs (reason required), table
    "Status history"; "Base location" with a move dialog; "Readiness for a journey" form and
    table "Vehicle readiness checks".
  - Maintenance tab: "Record service done for {plan}" dialog per row, "Add maintenance plan" form.
  - Planner: "Manage shift for {callsign}" opens `ShiftActions` (`pages/planner/ShiftActions.tsx`):
    crew table with "Stand down {name}", "Add crew" form, jobs table with "Take {code} off this
    shift" and "Cancel {code}" (through `POST /jobs/:id/status`), "Change vehicle" and "Cancel
    shift" dialogs.
- Tests: `apps/web/test/vehicle-operations.test.tsx`, three new cases in
  `apps/web/test/planner.test.tsx`, and the task 26 block in `apps/api/test/workflows.test.ts`.
- Not done or unsure:
  - No API test drives a cancel or off-road with an allocated job (allocation needs a fully
    cleared crew); the release path reuses `releaseAllocationsForVehicle`, which m4/m6 tests cover.
  - The web job actions send `crypto.randomUUID()` as the submission id; the jsdom version in use
    must provide it.
  - No seeded role has `fleet.vehicle.manage` without `fleet.return_to_service`, so the new 403
    is covered only in the web test.
  - Shift crew add uses the existing route; there is no time-window picker for partial shifts.
- Follow-up (defect register fleet and planner findings, 6 Nov 2026; tests written, not run):
  - 40 (vehicle operations) and 13 (shift operations): already met by the work above; 13 also
    gains the Plan a shift fixes below.
  - 67: a vehicle that is not AVAILABLE cannot be put on a shift or swapped in (422
    OVERRIDE_NOT_PERMITTED, no override). Plan a shift and Change vehicle list such vehicles as
    disabled options with the reason in words.
  - 68: the same person cannot fill two crew places on one shift (400), and adding someone whose
    time overlaps their existing place says "{name} is already on this shift at that time". The
    second-crew list leaves out the chosen driver. The double-booking message is in plain words.
  - 69: `POST /allocation-exception-requests` (`jobs.allocate`; 409 if one is already open),
    `GET /allocation-exception-requests?status=&jobId=` (allocators and approvers) and
    `POST /allocation-exception-requests/{id}/decide` (`allocation.exception.approve`; the asker
    gets 403 SELF_APPROVAL; a refusal needs a note; approval re-runs the check and creates the
    exception). Statutory and safety checks get 422 OVERRIDE_NOT_PERMITTED, as before. Planner:
    dispatchers see "Ask for an exception for {check}" and the request status; approvers see
    "Exceptions waiting for a decision".
  - 70: Book a journey adds order number, appointment time, access notes, patient weight
    (required for a stretcher), escorts, communication needs, stairs, infection precautions,
    equipment and skills, a separate patient contact (never put in the job) and daily or weekly
    repeats.
  - 71: allocation and offer errors list the failing checks in words with names (for example
    "Alex Driver: Bariatric competence missing"); before the crew start, vehicle checks and
    cleaning show as pending ("checked when the crew start the shift") instead of blocking.
  - Tests: `apps/api/test/registers.test.ts`, `apps/api/test/m6.test.ts` (AMB-03 is now refused
    at shift creation; the critical-VDI case expects SHIFT_GATE pending),
    `packages/rules/test/modules.test.ts` (shift gate before start, names in details),
    `apps/web/test/planner.test.tsx` (dispatcher asks) and
    `apps/web/test/registers-forms.test.tsx`.
- Not done or unsure (follow-up):
  - Finding 71 changes behaviour: a planned shift whose start time has passed but whose crew has
    not started now shows SHIFT_GATE as pending rather than failing. Product should confirm.
  - Exception requests are not pushed as notifications; approvers see them on the planner only.
  - Existing m6/m8 assertions on AMB-03 (for example the m8 fleet report row) were read but not
    re-run.

**Task 27: data protection logs (built 6 Nov 2026; tests not yet run)**

- No migration: `disclosure` and `retention_log` already exist and are immutable (0012).
- Contracts (`packages/contracts/src/privacy.ts`): `DisclosureDto` gained `subjectRequestCode`
  and `recordedByName`; new `DisclosureQuery` (from, to) and `RetentionLogQuery` (category, from,
  to), both strict.
- API (`privacy.controller.ts`): `GET /disclosures` filters by date and names who recorded each
  entry; `POST /disclosures` refuses future dates; `GET /retention-log` filters by category and
  London run date.
- Web (`apps/web/src/pages/settings/DataProtectionLogs.tsx`, shown in Settings, Data
  protection): "Retention log" (filters, table "Retention runs" in words: found, acted on, held by
  a legal hold) and "Disclosure log" (date filters, table "Disclosures", form "Record a
  disclosure" with lawful-basis suggestions and an optional linked subject request).
- Tests: `apps/web/test/data-protection-logs.test.tsx` and the task 27 block in
  `apps/api/test/workflows.test.ts`.
- Not done or unsure:
  - No CSV export of either log (a client-side export would bypass the audit trail; a server
    export route would be the right way).
  - The disclosure list is capped at 500 rows and the retention log at 200, with no paging.
  - Viewing the disclosure log is not audited (it holds descriptions, not records); revisit if
    the DPO wants reads audited.

**Task 28: Playwright browser tests per role (built 6 Nov 2026; tests not yet run)**

- `apps/web/playwright.config.ts` (Chromium, one worker, London time zone, `E2E_BASE_URL`,
  default `http://localhost:5173`; no web server is started, the dev stack must be running).
- `apps/web/e2e/`: `support.ts` (dev sign-in, expected menu from `SYSTEM_ROLES` and
  `NAV_ITEMS`, axe helper using the root `axe-core`), `roles.e2e.ts`, `workflows.e2e.ts`,
  `accessibility.e2e.ts` and `README.md` (how to run).
- `apps/web/package.json`: `e2e` script and `@playwright/test` dev dependency. Root `test:e2e`
  now runs it (the old echo about Maestro is gone; crew app E2E is still
  `maestro test apps/mobile/.maestro`). `test-results` and `playwright-report` are git-ignored.
- Not done or unsure:
  - `pnpm install` is needed for `@playwright/test` (the lockfile was not updated) and
    `playwright install chromium` for the browser. The version range `^1.56.0` was not checked.
  - The specs import `../src/nav.js` and `packages/contracts/src/rbac.js` by relative path and
    rely on Playwright resolving `.js` to `.ts`.
  - `e2e/` is outside the web `tsconfig.json`, so `pnpm typecheck` does not check it.
  - The menu check assumes seeded users hold exactly their system role. Items reachable through
    self-service permissions (for example "My record") are not asserted as hidden.
  - Journeys that need seeded vehicles or shifts skip or shorten themselves when none exist.

**Workflow pass: G, H1-H5, I, L1, L3, L5, M, navigation (6 Nov 2026; tests not yet run)**

- Migrations `0034_incident_workflow.sql` (H1-H5), `0035_audit_policy_workflow.sql` (G1-G4)
  and `0036_registration_workflow.sql` (I1-I3), with `schema.prisma` updated. New tables
  (`event_candour_step`, `risk_review`, `audit_review`, `registration_location`) have RLS
  `tenant_isolation`, grants and immutability triggers. 0037 is unused.
- G1 templates. Already: draft, version, publish and activate. Added: copy as a new draft, retire
  with a reason (cannot be scheduled; past runs unchanged), sector pack and proposed cadence, and
  dental and care home publishing needs the specialist's name and role. The sector seed marks
  `DEN-`/`CH-` templates with their pack and cadence (still inactive drafts).
- G2 runs. Already: schedule, sample, respond, submit, findings. Added: service, named reviewer
  (never the auditor) and repeat interval on scheduling; month and week calendar with overdue
  in red and the word "(overdue)"; "Not assessed" result (reason required, like N/A); progress
  "n of m controls answered"; submit refused until every control is answered; overall result
  (a failed critical control makes it non-compliant); failures become draft actions; reviewer
  Accept or Return with a reason (append-only `audit_review`); accepting a repeating audit
  schedules the next run. Results never change after corrective action.
- G3 actions. Added: raise an action from any source (`POST /actions`); filters by owner,
  source, state and overdue; "Evidence submitted" now reads "Ready for verification". Evidence
  still never closes an action; only verification by someone else does.
- G4 policies. Added: reader groups by role, location or everyone (empty groups mean
  everyone, also in the POLICY_ACK report); percentage acknowledged; "Remind those
  outstanding" (one push per person per day, audited); non-approvers see who must approve.
  Not done: the crew app and alerts centre still honour reader roles only, not locations
  (owned by other workers).
- H1 incidents. Added: "Report an incident" page for every staff member (`/report`), people
  named only by job or booking reference, still-at-risk alert holding the reference only,
  receipt with reference and triage due time, "Reports you have made"; triage (priority, harm,
  category, lead, protection steps, linked risks); suggested reporting duties with an "Add"
  button (a person still decides each); duty of candour steps after the RM decides it applies;
  PSIRF learning response for NHS-funded work; close blockers listed in words.
- H2 complaints. Added: complaint fields on the report form; escalation text by funding (PHSO
  for NHS, ISCAS or LGSCO otherwise); reopen with a reason (history kept).
- H3 feedback. Already met: themes with the "what people raised" wording and actions from
  feedback. No change.
- H4 risks. Added: title, category, band in words ("Medium 8"), review history snapshots,
  linked audit runs, close or archive with a required reason.
- H5 harassment. Added: harassment report type restricted to HR and the RM (plus lead and
  reporter) in RLS. Not done: no separate harassment page beyond the events list (SpeakUp is
  worker 1's).
- I1 registration. Added: insurance expiry and business continuity review dates; registered
  locations (manager, start date, activities, conditions, effective date, reason; append-only);
  a change of RM or nominated individual drafts a CHANGE_OF_DETAILS notification.
- I2 rating display. Added: evidence items for the premises and website display (API only).
- I3 governance meetings. Added: meeting pack from live records since the last meeting
  (audited); minutes approved at a later meeting only. Not done: web view of the pack and the
  "approved at" picker (API only).
- I4 evidence pack. Added: unknown service → 400. Otherwise already met.
- I5 NHS contract. Added: NHS_KPI report (contract items, IG training against 95%, DSPT).
- L1 dashboard. Added: policy review rows (overdue red, due within 30 days amber); sector tiles
  only when the server lists them; "Not set up" badge per module; module filter chip with
  "Clear filter"; policy and correspondence rows link to the right tab.
- L3 reports. Added: NHS_KPI (kept in sync in rules catalogue, contracts, visibility and
  domain); readiness row reads "No requirements set up".
- L5 inspection view. Added: `/inspection` page per key question (published rating, coverage
  labelled "Internal measure — not a CQC rating", gaps, audits with results in words,
  policies); auditors land there from the home page.
- M sectors. Added: IR(ME)R incidents for dental, DoLS for care homes, sector dashboard tiles,
  specialist validation for sector templates, and the seed marks. Not done: no dental- or
  care-home-specific report tables.
- Navigation. `nav.ts` gains "Inspection" (`inspection.view`) and "Report an incident"
  (`events.event.report`); its comment says how to add items. Home redirects inspectors to
  `/inspection` and ambulance dispatchers to `/planner` (`homePathFor`); crew keep the welcome
  page rather than `/me`.
- Tests (not run): `apps/api/test/workflow-pass.test.ts`, `apps/web/test/workflow-pass.test.tsx`,
  `packages/rules/test/workflow-pass.test.ts`; updated `m5.test.ts` (risk close needs a reason),
  `m8.test.ts` and `packages/rules/test/reports.test.ts` (NHS_KPI).
- Unsure: new dashboard rows (AUD, COR, DEF, POL) may change counts asserted in older tests;
  the candour-step API test assumes the RM can decide candour while the event is in triage.
- API_SPEC: section "Workflow pass: G, H1-H5, I, L1, L3, L5, M".

**Workflow pass: A, B, C, K, H6, L2, L4, F0 (6 Nov 2026; tests not yet run)**

Nothing in this pass has been built, type-checked or run. Migrations added: `0026_org_setup_access`,
`0027_training_supervision`, `0028_data_protection_speak_up`, `0029_requirement_retirement`
(all with RLS `tenant_isolation` and grants, and in `schema.prisma`).

- A1/A2 Organisation and locations. Archiving a location needs a reason (stored and shown on the
  badge). Settings merge only the keys sent (`SettingsPatch` is an explicit partial). Not done:
  services-per-location editing in the web.
- A3 Users and roles. Invite refuses an email with current access (409 `EXISTING_USER`, "Use
  Change access"). Invite can link an existing staff record (404 if missing; 409 if it is already
  linked or is a leaver). The registered manager cannot be removed or have their role changed if
  they are the only one. Revoke flags future shifts (`flagFutureShifts`, `ACCESS_ENDED`). Role
  permissions are listed in plain words. Sign-in is recorded at most every 8 hours (`/me`, audited
  `auth.sign_in`). Unknown account: "No account found for this sign-in. Ask your administrator to
  invite you." (API and `auth.ts`). Not done: `App.tsx` still matches the old wording (see
  below).
- A4 Support access. Grants show names. New "End access now" with a reason
  (`POST admin/support-access-grants/:id/end`); ended grants stop working at once (the guard
  ignores ended grants). `supportBannerText` is in contracts; the banner itself is in `Shell.tsx`
  (not done).
- A6/A7 Notifications and alerts. Settings gain warning days (labelled "product defaults, not CQC
  rules"), who is told per item kind, escalation days, deputies with dates, channels and the Speak
  Up guardian; the alert centre adds "DEPUTY" and "ESCALATED" reasons. Snoozing needs a reason
  and a date means the end of that UK day. New `GET alerts/count` for the bell. Not done: the bell
  in `Shell.tsx`; email/push delivery of escalations (the worker still sends rule-based alerts
  only).
- B Staff. Readiness for a window (`GET staff/:id/readiness-window`), employment gap rule,
  competence rules (`hasCompetence`, `missingCompetences`). F0 My record gains a To do list
  (renewals, policies to read, booked supervisions, answered corrections) and Report links.
- C1-C4 Training and supervision. Course catalogue (`training-courses`, retire with reason),
  group training (`training-records/bulk`, records unverified), matrix CSV export, supervision
  bookings (book, close as held/cancelled/missed with rebook), staff acknowledgement of
  supervision and appraisal records. `TrainingController` is registered before
  `StaffController` so `staff/training-matrix/export` and `staff/:id/supervision-bookings` are
  not caught by `staff/:id/:kind`. Not done: the web matrix cell drill-down, bulk entry and
  booking screens.
- K Requirement library. Templates can be retired with a reason; adopting specialist content
  needs the specialist and their organisation as separate fields.
- H6 Speak up. Anonymous concerns get a one-time progress code (only a hash is stored); anyone can
  check status and feedback with it (`GET speak-up/progress`); handlers write feedback for it.
  The guardian's name is shown on the raise page. Quarterly themes hide counts under 3. Not done:
  web screens for themes and for writing progress feedback (API only).
- L2 Data protection. Legal holds can have a date range. Subject requests record when identity
  was asked for and verified, and the clock pauses in between (`effectiveDueOn`); refusals name
  the exemption; a sources list helps gather the response. Disclosures record the requester,
  method and a different approver, and can be searched. Breaches record containment and people
  affected, have guided risk questions (`suggestBreachRisk`), and close only once contained and
  with lessons learned. ICO complaints need the ICO case reference; the acknowledgement letter
  is drafted. Monthly retention reviews per approved rule with frozen counts and immutable keep
  or act decisions.
- L4 Audit log. Filters by area (action prefix), person, dates and record; shows the actor's role
  and the reason given; CSV export (5000 rows, audited `admin.audit.export`).
- Tests (not run): `apps/api/test/workflow-people.test.ts`,
  `packages/rules/test/workflow-people.test.ts`; updated `m1`, `m2`, `m8`, `role-scope` API
  tests and `alerts`, `library`, `speakup` web tests.
- Needed from the owners of shared files: `App.tsx` should treat 401 `UNAUTHENTICATED` with
  "No account found" as the unknown-account case (it still matches "no healthcare hub account",
  and `apps/web/test/app.test.tsx` uses the old text); `Shell.tsx` bell from `GET alerts/count`
  and the support banner; `rbac.ts` has no `admin.audit.verify` grant for ORG_ADMIN, GOVERNANCE
  or AUDITOR, so the "Check the audit trail" button shows only for roles that already have it.
- API_SPEC: section "Workflow pass: A, B, C, K, H6, L2, L4, F0".

**Shared web helpers in `apps/web/src/components.tsx`**

- `errText`, `errReasons`, `useRun`, `useCan`.
- `ActionDialog`, an in-app confirm dialog with an optional required reason and extra fields.
- `fmtDate` and `fmtDateTime` (UK format, Europe/London).
- `PersonSelect`, `smallButton`, `input`, `button`.
- `ApiClient.send` now also accepts DELETE, and a 204 response returns null.

**Test helpers in `apps/api/test/harness.ts`**

- `ensureRoleRequirement`, `uploadAndVerify` (pass `verifier: null` to leave the document waiting
  for review), `completeChecks`, `activateStaff` and `addVerifiedLicence`.
- New tests: `apps/api/test/library.test.ts`, `apps/web/test/library.test.tsx` and
  `apps/web/test/evidence.test.tsx`.

**Demo data**

- `apps/api/scripts/demo-data-lib.ts` adopts and publishes the ambulance pack and maps it to roles
  before it creates staff.
- Staff then go through role checks, then synthetic evidence uploaded by the manager and verified
  by governance, then approval by HR. Nothing is green without verified evidence.

**Local username and password sign-in (6 Nov 2026; tests not yet run)**

- Decision: `docs/adr/0006-local-password-sign-in.md` (approved exception to ADR 0003 for local
  and pilot use; Entra remains the production target), indexed in `DECISIONS.md`. Set up and the
  username table: `docs/guides/RUN_LOCALLY.md` ("Username and password sign-in").
- Config: `AUTH_MODE` (`dev` default, `local`, `entra`) and `LOCAL_AUTH_PRIVATE_KEY` in
  `apps/api/src/config.ts`; `VITE_AUTH_MODE` in the web (`apps/web/src/env.d.ts`);
  `SEED_LOCAL_PASSWORD` for the seed (default `Hub-Dev-Password-2026!`, dev only).
- Database: `packages/db/sql/migrations/0038_local_credentials.sql` (`local_credential`, closed
  unless `app.local_auth = 'on'`; SELECT/INSERT/UPDATE for `hub_app`, no DELETE) and the
  `LocalCredential` model in `schema.prisma` (no relation on `AppUser`; the API uses raw SQL, so
  the generated client is not required).
- API: `apps/api/src/auth/password.ts` (scrypt), `totp.ts` (RFC 6238), `local-keys.ts` (signing key,
  issuer `healthcare-hub-local`), `attempt-limiter.ts` (per-IP limit, lockout rule);
  `token.service.ts` trusts only local tokens when `AUTH_MODE=local`; `hub.guard.ts` binds
  `local|<userId>` straight to the user; `mfa.ts` adds `mfaSatisfiedBy` (`mfa`, or `pwd` + `otp`).
  Endpoints in `apps/api/src/modules/local-auth/`: `POST /auth/login`, `/auth/mfa/setup`,
  `/auth/mfa/verify`, `/auth/forced-password-change` (public), `/auth/change-password`,
  `/auth/logout` (signed in), `/admin/users/{id}/reset-password` (`admin.users.manage`). All 404
  unless `AUTH_MODE=local`. Wired in `app.module.ts`; routes in `packages/contracts/src/routes.ts`;
  schemas and messages in `packages/contracts/src/auth.ts`.
- Mock OIDC (`apps/api/scripts/mock-oidc.ts`) refuses to mint tokens when `AUTH_MODE=local`.
- Seed: `packages/db/src/admin/seed-credentials.ts`, called by `seed()` and `seedSectors()`;
  never in production, never overwrites an existing credential, no TOTP (privileged users enrol
  at first sign-in).
- Web: `LocalAuthClient` in `apps/web/src/auth.ts` (token in memory; username only in
  sessionStorage; reload means sign in again), `apps/web/src/pages/LocalSignIn.tsx` (credentials,
  show password, error summary, MFA code, TOTP enrolment with the key as text, forced password
  change), and a small switch at the top of `pages/SignIn.tsx`.
- Tests: `apps/api/test/local-auth.test.ts`, `apps/web/test/local-sign-in.test.tsx`.
- Not done or unsure:
  - Nothing was built or run. Rebuild `@hub/contracts` and `@hub/db` before API typecheck; run
    `prisma generate` if you want the new model in the generated client.
  - Challenges, the per-IP limit and the unknown-username lockout are in memory (single instance).
  - Superseded by the next section: refresh tokens and the MFA reset now exist.
  - In local mode the crew app (OIDC) cannot sign in, and Playwright's dev sign-in does not apply.
  - The isolation suite now covers `/auth/change-password`, `/auth/logout` and the reset route
    (it runs with `AUTH_MODE=dev`, where the guard answers before the handler).

**Local sign-in: refresh tokens and administrator MFA reset (6 Nov 2026)**

- Database: `0039_local_refresh_tokens.sql` (`local_refresh_token`: SHA-256 of the token, family,
  `mfa`, 30 min idle / 12 h absolute expiry, `used_at`, `replaced_by`, `revoked_at` + reason;
  same `app.local_auth` rule; no DELETE) and `revoke_local_refresh_tokens(user, reason)` for code
  outside the local-auth service. `LocalRefreshToken` model in `schema.prisma`.
- API: `apps/api/src/auth/refresh-cookie.ts` (the `hub_refresh` cookie, no plugin dependency);
  `local-auth.service.ts` creates a family at every completed sign-in, rotates on
  `POST /auth/refresh`, ends the family on reuse (audit `auth.refresh.reuse`) and revokes on a
  password change, a password reset and an MFA reset. `POST /auth/logout` is now public (cookie or
  bearer). `POST /admin/users/{id}/mfa-reset` (`admin.users.manage`, reason required, audit
  `auth.mfa.reset`). The admin revoke and the immediate leaver transition call
  `revoke_local_refresh_tokens`. Contracts: `MfaResetRequest`, `MfaResetResponse`,
  `LOCAL_REFRESH_*_SECONDS`, `AUTH_MESSAGES.sessionEnded`; routes `authRefresh`,
  `adminMfaReset`; `authLogout` marked public. No new permission, so no re-seed is needed.
- Web: `LocalAuthClient` refreshes on demand and at start-up (`restore()`, called from `App.tsx`
  while showing "Checking your sign-in…"), with `credentials: 'include'`; one refresh at a time
  in and across tabs. Settings > Users: "Reset MFA" row button (local mode only) with an
  `ActionDialog` that needs a reason.
- Tests: `apps/api/test/local-auth.test.ts` (refresh and MFA reset sections, all passing),
  `apps/web/test/local-refresh.test.tsx`, `apps/web/test/mfa-reset.test.tsx`.

**Workflow pass: D, E, J (6 Nov 2026; tests not yet run)**

Read against `docs/WORKFLOWS.md` sections D1–D7, E1–E5 and J1, on top of tasks 7, 15 and 26.
Migrations `0030_fleet_workflows.sql`, `0031_dispatch_workflows.sql` and
`0033_premises_workflows.sql` (0032 not used); `schema.prisma` updated. API lines are in
`docs/API_SPEC.md` under "Workflow pass: D, E, J1".

- D1 vehicle register. Already: register, documents, capability. Added: make, model, year, first
  registered, EN 1789 type, conversion company and certificate, lease end (required unless owned),
  services, blue-light, bariatric limit; licence worked out from weight ("Needs C1"); UK
  registration message; MOT applied only once three years old; missing MOT, insurance or tax and a
  missed base oxygen check block readiness (no override); header says whether it can be used now
  and why. Documents tab only with `compliance.requirement.view` (finding 21).
- D2 maintenance and odometer. Already: plans by date or miles. Added: which limit comes first,
  garage and job sheet on "service done", fleet review of flagged readings (confirm or correct,
  reason, original kept).
- D3 equipment. Already: register, LOLER regimes, quarantine. Added: instructions, wheelchair and
  hoist categories, release needs evidence and a different person; status changes recorded.
- D4 defects. Already: classify, repair, release by someone else. Added: report form with severity
  guidance, photos and "stop use" (always for critical), affected job codes after reporting,
  severity filter, next-action column, job sheet on repair, "checked" tick on release, no release
  without repair notes.
- D5 off road and moves. Added: reason list and expected return date (shown on the planner),
  backdated move with effective date and base history.
- D6 inspection checklists. Added: draft then publish by a second person; status in words.
- D7 fuel and expenses. Added: litres and odometer required for fuel, duplicate by receipt,
  approved CSV export for a period; tab hidden without an expense permission (finding 21).
- E1 booking. Added: "Booking reference (never a patient name)", contract type and NHS
  eligibility, return journey as its own job, blue lights, weight warning, assessed only once the
  access plan is reviewed.
- E2 shifts and crew. Added: own times per crew member, readiness as each person is picked
  (`GET /shifts/crew-readiness`), swap crew member with reason, plain overlap messages naming
  the person or vehicle and times, unavailable vehicles say why and when due back.
- E3 validation. Already: checks with reasons and exceptions. Added: "How to fix" with a button
  (manage shift, open vehicle, open staff), re-check at shift start.
- E4 run the job. No change.
- E5 exceptions. Added: reassign to another shift (checks run again, old allocation ended with the
  reason), new vehicle check and cleaning before setting off after a vehicle swap, event actor
  names.
- J1 premises. Added: area or room, interval in months (next due from the last assessment),
  reviewer and review date for "not applicable", history of every change, findings become actions
  (source PREMISES), oxygen at an ambulance base is shown as deployment-critical.
- Finding 71 (needs product owner sign-off): the shift gate is Pending before the shift start
  time; after it, Fail "Shift has not been started" until the crew start the shift.
- Tests: `apps/api/test/workflows-dej.test.ts`; web tests in `fleet.test.tsx`,
  `vehicle-operations.test.tsx`, `registers-forms.test.tsx`, `premises.test.tsx` (existing
  tests updated where text or payloads changed).
- Not done or unsure:
  - Nothing was built or run.
  - Mobility has no "own wheelchair" or "bariatric" value (bariatric is a skill or equipment
    need); recurring bookings have no weekday pattern on the web form.
  - Driver list uses the staff role list; the server does not separately refuse an unapproved
    driver at planning time (allocation checks still do). Crew readiness uses staff competency
    records.
  - Missing-document blocking only applies to templates set to auto-apply.
  - Premises actions are created inline; `action.source_type` gains PREMISES in 0033 and the
    domain `createAction` type does not include it yet.
  - Off-road reason code is optional on the API (imports and older clients do not send it); the
    web form requires it.

### Workflow pass follow-ups (closed)

- `admin.audit.verify` added to ORG_ADMIN, GOVERNANCE_LEAD and AUDITOR (re-seed to apply).
- Mobility gains OWN_WHEELCHAIR and BARIATRIC (migration 0032). Stretcher and bariatric bookings
  need the patient weight; a bariatric job is unsuitable for a vehicle with no bariatric limit.
  Weekly repeats take weekdays (`byWeekday`), with checkboxes on the planner form.
- Sign-in errors use `AUTH_MESSAGES` (unknown account, access ended, server unreachable with the
  last refresh time). Crew-only users land on `/me`, which points them to the crew app.
- Shell: an alert link in the header reads `GET /alerts/count` (count and critical in words), and
  a support banner shows while a support grant is active (`MeResponse.support.endsAt`, set by
  the guard from the grant).
- PREMISES is a full action source: contracts (`ActionSourceType`), domain `createAction`,
  `POST /actions` source lookup, and the actions register shows "Premises item" with a link to
  `/premises`.

### Coolify demo deployment and Exora branding (6 Nov 2026)

- `docker-compose.coolify.yml` + `deploy/setup.Dockerfile` + `apps/web/Dockerfile` +
  `apps/web/nginx.conf`: demo stack (Postgres, one-shot setup, API, worker, nginx web proxying
  `/api`). Built and run locally in Docker: setup, health check, sign-in, cookie and live stream
  all pass. Guide: `docs/deploy/coolify.md`.
- `pg` moved to the API's runtime dependencies (the live service imports it; the production
  image crashed without it). API and worker images create `/data/evidence` owned by `node`.
- Demo organisation renamed to "Exora International Ltd" (trading name Exora Medical), location
  London; the seed renames existing databases. The web reads the repo-root `.env` (`envDir`),
  unit tests keep their own.
- Product branding (10 Nov 2026): "Healthcare Hub by Vkraft" with the Vkraft V-and-cross logo
  (`apps/web/src/brand.tsx`, `public/favicon.svg`, `public/brand/vkraft-mark.svg`). The
  per-deployment `VITE_BRAND_NAME` / `VITE_BRAND_LEGAL_NAME` settings were removed;
  `VITE_BRAND_LOGO=pulse|rapid` still selects the older marks.

### Full test run fixes (6 Nov 2026; all suites and Playwright green)

- Both Prisma clients open sessions with `TimeZone=UTC`, so a Postgres server in another zone no
  longer shifts dates. Migration 0041 backfills `live_change` triggers; 0039's refresh-token revoke
  uses `set_config` instead of a function `SET` clause (which `hub_app` may not use).
- Rate limit is per user as DECISIONS M8 says (`keyGenerator` hashes the bearer token;
  unauthenticated routes such as password sign-in stay per IP). `ProblemFilter` now reports the
  limiter's plain object as 429 `RATE_LIMITED`; before, it became a 500 and the web showed
  "Your account could not be loaded". The web `/me` query retries up to three times on 429 or 5xx.
- Web: `App` waits while `/me` still reflects the previous organisation (no empty menu flash);
  the sidebar scrolls on its own (`md:overflow-y-auto`, fixes an axe contrast hit on the footer);
  `fmtDate` prints "Sep" not "Sept"; the Compliance and Speak-up menu entries also open for
  event, meeting and report permissions; Settings copes with an organisation that has no sector
  packs.
- `staff.schedule3.view` is now `staff.schedule_three.view` (audit action names allow no digits).
- 5xx logs carry the error type only (`err`), never the message.
- `DEV_DISABLE_MFA=true` (local development only; `loadConfig` refuses it in production) makes
  `mfaRequiredFor` return false, so privileged roles sign in without TOTP. Set from `main.ts`
  only, so tests always enforce MFA. `pnpm --filter @hub/api totp <SECRET>` prints the current
  code for a secret shown at enrolment.

**Email and push delivery of escalations (6 Nov 2026; nothing built or run)**

Closes the A6/A7 "not done" item above: escalations now go out by email and push, not only in
the alerts centre.

- Migration `0040_notification_outbox.sql` (0039 belongs to another change): tables
  `notification_outbox`, `push_device` and `notification_preference`, each with `organisation_id`,
  RLS `tenant_isolation`, indexes on `(organisation_id, ...)`, and SELECT/INSERT/UPDATE for `hub_app`
  (no DELETE). The outbox has no `live_change` trigger (worker-only, like `push_message`;
  `apps/api/test/live.test.ts` exemption list updated); the other two do. Prisma models
  `NotificationOutbox`, `PushDevice`, `NotificationPreference` (no back-relations).
- Outbox row: `escalation_stage` LEAD or MANAGER, `channel` EMAIL or PUSH, `status` PENDING, SENT,
  FAILED or CANCELLED, `attempts`, `next_attempt_at`, `last_error` (codes only), and a unique
  `idempotency_key` `<alert>:<stage>:<recipient>:<channel>`. Subject, body and link path are stored
  as sent, so you can see exactly what went out.
- Domain (`packages/domain/src/escalations.ts`): `escalationMessage` (fixed text, UK date through
  `formatDate(londonDate(now))`, opaque path from `alertLink`), `stageTargets`,
  `planEscalationDeliveries`, `drainNotificationOutbox`, and `escalationsAll` for the worker.
  Senders (`notification-senders.ts`): a `NotificationSender` interface with `EmailSender` and
  `PushSender`. Email transports: `OutboxEmailTransport` (development; keeps messages in memory and
  logs the domain only) or the worker's `smtpMailer` (nodemailer, loaded only when
  `EMAIL_TRANSPORT=smtp`). Push transports: `OutboxPushTransport`, `ExpoPushTransport` and
  `WebPushTransport` (VAPID with Node crypto and no payload, so no encryption library is needed;
  a 404 or 410 response revokes the device). The crew push interface in `push.ts` was renamed
  `PushSender` → `CrewPushSender` to free the name (it was only used inside that file).
- Who is told: at the lead stage, the lead role for the item kind (`LEAD_ROLE_BY_KIND`); at the
  manager stage, the registered manager (someone who is both is told once, as lead). Deputies
  covering a target that day are told too. The alert owner is not told. Stages reached more than
  7 days ago are skipped, so the first run does not send old alerts. Acknowledged, resolved and
  snoozed alerts are not escalated.
- Worker: new pg-boss queue `deliver-escalations` every 5 minutes (Europe/London) in
  `apps/worker/src/main.ts`. Config in `apps/worker/src/config.ts`: `EMAIL_TRANSPORT`,
  `SMTP_URL`, `EMAIL_FROM`, `PUSH_TRANSPORT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`. In production the worker refuses to start with the outbox email or push
  transport.
- API (`apps/api/src/modules/notifications/notification-delivery.controller.ts`,
  `NotificationDeliveryController`): `GET/POST /me/push-devices`, `DELETE /me/push-devices/:id`,
  `GET/PUT /me/notification-preferences`. Self-scoped `@OrgMember()`, audited, in `routes.ts`.
  Contracts are in `packages/contracts/src/notification-delivery.ts`.
- Tests (not run): `apps/api/test/escalation-delivery.test.ts`. It uses its own synthetic
  organisation and covers outbox creation, idempotency, generic content, retry and backoff up to
  FAILED, cancelling, push with rejected tokens, device registration and preferences, and the
  VAPID signature.
- Not done or unsure:
  - Rebuild `@hub/contracts` and `@hub/domain` (and `@hub/db` for the models), apply 0040, and
    run `pnpm install` for `nodemailer` (pinned 10.2.0, worker only).
  - Web and mobile: there is no UI yet for registering a browser or phone, or for the two
    switches. The web needs a service worker that shows generic text on a push with no payload,
    and `VITE_VAPID_PUBLIC_KEY` for `pushManager.subscribe`. The crew app could post its Expo
    token to `/me/push-devices`. Its existing `/devices/register-push` token is not used for
    escalations.
  - Links go to existing pages (`alertLink`). There is no `/alerts/:id` deep link yet.
  - Delivery is at least once: a crash between sending and the status update can send a message
    twice.
  - Only stored alerts escalate. Overdue actions, audits, incidents and policies are not stored
    alerts, so they do not.

## 4. Working rules for the remaining tasks

1. Start from the workflow in the workflows doc and the findings in the defect register.
2. Server first: zod contract in `packages/contracts`, then permission, audit event and
   isolation. New routes go in `routes.ts`, otherwise the OpenAPI test fails.
3. Rebuild packages after changing them. They resolve to `dist`, and there is no watch mode:
   `pnpm --filter @hub/contracts --filter @hub/rules --filter @hub/domain build`
4. In the UI:
   - No browser pop-ups.
   - Every status shows words as well as colour.
   - UK date format.
   - Never show raw codes; label maps are in `pages/staff/labels.ts`.
   - Buttons in table rows get an `aria-label` that includes the record's name.
5. Uploading never makes anything green. A different person verifies. Never show approved or
   verified unless there is a real verification record behind it.
6. Run the tests and checks:
   - API tests: `cd apps/api && npx vitest run <files>`. They need Postgres; see `docs/guides`.
   - Web tests: `cd apps/web && npx vitest run`. All 70 pass.
   - Type check: `npx tsc --noEmit -p .` in each app.
   - Lint: run ESLint per package directory (`npx eslint src`), not from the repo root.
7. Do not check changes in the browser for now. The owner will say when to start. Rely on the
   automated tests.

## 5. Task 14 details (Settings and users)

Done; see the task 14 entry in section 3.

## 6. Known issues

- **Postgres time zone:** the database server must run in UTC. A non-UTC time zone made role
  approvals look future-dated. Set it with `ALTER SYSTEM SET timezone='UTC'`, then restart.
- **m8 restore drill test:** it needs `pg_dump` on the PATH.
- **Crew demo and Maestro flows:** the crew demo user (Alex) now shows a licence blocker until a
  verified licence exists. That is correct behaviour, but the Maestro mobile flows need updating.
- **Finding 99:** a stale `hub.orgId` in sessionStorage broke loading when you switched between
  users in different organisations. Fixed in task 23 (not yet run).
- **Seeding order:** run `pnpm db:seed`, then `pnpm db:seed:sectors`, then the demo-data script, so
  the ambulance pack gets adopted.
- **Browser checks deferred:** tasks 1–6 have passed automated tests but have not been checked in a
  browser. Do not start browser checks until the owner asks.

## 7. Web screens for API-only workflow features (6 Nov 2026)

Web only: no API, contract, nav or route changes. New tests pass, web type check and ESLint are clean.

- H6 Speak up (`pages/speakup/SpeakUp.tsx`): a "Themes" tab (`speakup.manage` or `reports.view`)
  with a quarter picker over the last 8 quarters (`GET speak-up/themes?quarter=`), categories in
  words, the server's hidden small counts and note shown unchanged. Concern detail offers "Write
  feedback for the raiser" on anonymous concerns only (ActionDialog,
  `POST speak-up/:id/progress-feedback`). Named concerns still use a FEEDBACK note.
- C1 matrix drill-down (`pages/staff/TrainingMatrix.tsx`): every cell is a button ("Open
  <requirement> for <person>: <status>") that opens the record (status, why, next date, a
  Documents button using `EvidenceDialog`, a link to the profile). "Show people: <requirement>" on
  the totals lists everyone who needs it, worst first. Uses the existing matrix response only.
- C1 group training (`pages/staff/TrainingSupervision.tsx`, Staff tab "Group training",
  `staff.profile.manage`): current course from `GET training-courses` (retired courses hidden),
  session date, register reference, provider, optional expiry, attendee ticks (leavers hidden, own
  record shown but not tickable), `POST training-records/bulk`. Says the records await HR
  verification.
- C2 supervision bookings (same file, Staff tab "Supervision bookings"): list from
  `GET supervision-bookings` with a status filter, type and status in words, and a booked session
  whose date has passed shown as needing an outcome. HR books with
  `POST staff/:id/supervision-bookings` (typed times are read as London time through
  `londonDateTime`). "Record outcome: <name>" (supervisor or HR, never on your own booking, which
  is worked out from `GET staff/me`) records held, cancelled or missed with a reason and an optional
  rebook (`POST supervision-bookings/:id/close`, If-Match).
- I2 rating display (`pages/compliance/Regulatory.tsx`): the "Record display" dialog can upload a
  premises photo and a website capture (`uploadFile`, then `premisesEvidenceItemId` /
  `websiteEvidenceItemId` on `PATCH cqc-ratings/:id`); the Display column says what is on file.
- I3 governance meetings (same file): "Meeting pack" section, built only when someone presses the
  button because the server audits each request (`GET governance-meetings/pack`): figures in words
  with overdue counts as red or green badges, minutes waiting to be agreed (each opens the
  meeting) and open meeting actions. The approve dialog has an "Agreed at which meeting?" picker
  listing only meetings held later (`approvedAtMeetingId`); approved minutes show the meeting.
- Tests: `apps/web/test/speakup-themes.test.tsx`, `training-supervision.test.tsx`,
  `governance-display-meetings.test.tsx`.
- Not done or unsure:
  - Supervision "agreed actions" are saved as text on the record; they do not create G3 actions
    (the API does not create them either).
  - Staff pickers use the first 100 staff (`GET staff?limit=100`). Larger organisations need search
    or paging.
  - Crew without `staff.profile.view_basic` cannot see the Staff page, so their own bookings are
    visible only through the My record to-do list.
  - The rating evidence is shown as "on file", with no link to open it: the rating response holds
    item ids, not version ids.
  - Themes are offered to `reports.view`, but the Speak up menu item does not list that permission,
    so a reports-only user cannot reach the page.
  - Two existing tests in `apps/web/test/regulatory.test.tsx` fail because the Compliance item in
    `nav.ts` (which has uncommitted changes in the working tree) leaves out `governance.meeting.manage` and
    `events.event.manage`, so users with only those permissions are refused the page. Add them to
    the item, or give those tests `compliance.audit.view`.
