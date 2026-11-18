# Live app vs demo: workflow assessment

Status: **Baseline review complete (12 Nov 2026). Batches 1–3 from the eight-workflow backlog are implemented in code (Nov 2026). Batches 4–5 remain deferred pending sign-off.**

The original review was inspection-only. The sections below keep that baseline. **Implementation progress** after the eight-workflow reconciliation is summarised next, then the original findings remain for history.

**The "live app" is the Coolify deployment of this same demo** (`http://web-xjb1wmqru0ymsjayjjl4vjjr.207.180.253.120.sslip.io`). So "live" and "demo" are the same product: the live column shows what a user actually sees with the seeded data, and the demo column shows what the code can do.

- **Live app column:** still shows the reviewer's notes from the brief, marked _to verify_. What I actually saw is recorded in **Part 2** at the end.
- **Demo column:** comes from reading the code (API, web, crew app, worker, seed data), with file references.
- **Regulatory points:** listed under "Assumptions to verify". They are not requirements until checked against current official guidance.

Status labels used in the demo column:

- **Supported:** works end to end.
- **Partial:** exists, but with a gap that matters.
- **Missing:** not built.
- **Not seeded:** built, but the demo data doesn't set it up, so it looks empty.

---

## Eight-workflow reconciliation and agreed batches

The eight workflows (onboarding, training, supervision, vehicle checks, defects, vehicle docs, incidents, audits) are the right product flows. Corrections against early improvement notes:

| Note | Actual state |
|---|---|
| “No duty of candour step” | **Built.** Flag at moderate+ harm; decision RM/Director only; five dated steps; closure blocked until done. Missing: step deadlines (Batch 4). |
| “Blocking a defect doesn’t reallocate jobs” | **Built.** Future jobs released; control gets `JOB_NEEDS_REASSIGNMENT`. |
| “Servicing doesn’t block” | **Partial → Batch 3.** Overdue by date/mileage blocked allocation already; planner now shows blocked for expired docs / overdue service and shift create refuses them. |
| “Allow a photo on a failed check item” | **Built on mobile.** Web Inspections tab now shows photos; failed-item photo is copied onto the defect (Batch 2–3). |
| “Make pre-shift clean a check item” | Already a separate model required by the shift gate. ACT-218 is a seed finding about a past miss. |

**Agreed principles preserved:** second-person verification / publish / return-to-service; sensitive-view logging; role-limited access (API + RLS); honest status labels (never claim CQC ratings).

| Batch | Scope | Status |
|---|---|---|
| **1 — Starter seed** | Adopt/publish/map staff, training, vehicle/equipment requirements; multi-control audits; stage demo records; Alex Morgan licence fix | **Done** (`packages/db/src/admin/seed-starter.ts`) |
| **2 — Quick fixes** | VDI FAIL-only reason; Documents / MFA / optional copy; web Inspections detail; role-approval Revoke | **Done** |
| **3 — Ownership / escalation** | Defect owner + review-by; persist overdue actions/audits/supervisions/defects/no-check as alerts; chase log; 8-week / probation rules; planner blocks | **Done** (`0042_ownership_escalation.sql`, `overdue-alerts.ts`, worker `sync-overdue-alerts`) |
| **4 — Governance depth** | Second-person incident closure; candour step targets; lessons in packs; auditor ≠ owner; rolling programme; template UI | **Deferred** until Batches 1–3 are signed off on Coolify |
| **5 — Records / training workflow** | Per-entity timeline PDF; training verification; planned sessions; rejection → re-upload task | **Deferred** until Batches 1–3 are signed off |

Do not hard-code statutory candour / RIDDOR / ICO deadlines; prefer configurable local-policy targets labelled as such.

---

## Headline findings (baseline review, 12 Nov 2026)

1. **Day-one configuration was the biggest gap.** The machinery existed but the seed shipped empty (nothing adopted, published or mapped). **Addressed by Batch 1.**
2. **The demo already matched the live app's main strengths:**
   - a second person must verify evidence, publish templates, verify actions, approve role changes and sign off return to service;
   - viewing sensitive records is logged;
   - access is limited by role, enforced by both the API and database row-level security;
   - every status is shown as a word, an icon and a colour.
3. **Recurring weak spots at review time:**
   - **Escalation / ownership:** overdue actions/audits/supervisions and defect owners were missing → **Batch 3.**
   - **Notifications:** nothing is sent on evidence rejection, supervision booking or reporter outcome → mostly **Batch 4–5.**
   - **Records:** no single exportable timeline per person, vehicle or incident → **Batch 5.**
4. **Demo bug found:** N/A on a vehicle check was rejected by the API while the app only sent a reason for FAIL → **fixed in Batch 2.**

---

## Focus area 1: crew onboarding, training and supervision

### A. Candidate onboarding and role approval

| Step | Live app (reviewer notes, _to verify_) | Demo | Evidence |
|---|---|---|---|
| Add person | Staff no., name, job title, base, start date, contract, line manager; Candidate / Checks in progress; History with reason | **Supported.** Same fields, plus "Role to check for" (Decide later or one of 9 roles), seen live. Starts as Candidate ("Record created"); "Start checks" moves it to Checks in progress. History tab shows lifecycle, approvals, restrictions and corrections. Who made each change is stored but not shown. | `packages/contracts/src/staff.ts:386-398`, `apps/api/src/modules/staff/staff.controller.ts:243-252`, `apps/web/src/pages/staff/StaffProfile.tsx:704-790` |
| Lifecycle | Candidate → … → Approved for role → Active | **Supported.** Candidate → Checks in progress → Ready for review → Approved for role → Active ⇄ Suspended; Leaver from any state. Nobody can move their own record. Ready for review needs every check verified. | `packages/rules/src/staff.ts:12-18`, `staff.controller.ts:637-735` |
| Role checks appear as "Awaiting evidence" | Depends on Requirement library being published; live shows "Nothing mapped" | **Supported but not seeded.** Checks come only from published requirements mapped to a role. The library (AMB-STF-01…11) ships but is inactive until adopted, published by a second person, and mapped. | `packages/domain/src/staff.ts:331-371`, `packages/db/sql/migrations/0008_library_ambulance_v1.sql` |
| Schedule 3 checks; restricted info hidden | ID, DBS, references, employment, RTW, licence, registration, health; DBS/health hidden | **Supported.** Structured forms for each. Sensitive numbers are encrypted or masked. Unexplained employment gaps over 3 months are refused. Right-to-work follow-up is set 28 days before expiry. Restricted information is hidden at database, API and UI level, and every view is logged. | `staff.ts:52-230`, `staff.controller.ts:838-862,1147-1192,1260-1280` |
| Evidence upload via My record | Unverified until reviewed | **Supported.** Uploads stay grey until verified. Crew can upload files but can't add the structured records. There's no upload in the mobile app. | `apps/web/src/pages/me/MyRecord.tsx:234`, `packages/rules/src/status.ts:150-161` |
| Second-person verify / reject | Queue; no self-verification | **Partial.** The queue exists, and self-verification is blocked by both the API and the database. A rejection needs a reason, but **no notification or re-upload task** follows. Any verifier can verify any item (`approvalRole` is ignored). | `apps/api/src/modules/evidence/evidence.controller.ts:233-386`, `0004_m2_requirements.sql:294-306` |
| Approved for role; approvals list | Retained list | **Partial.** The approval gate works, and approval is refused if the approver verified every check themselves. There's no separate second approver. **The revoke API exists but there's no revoke button.** Approval doesn't change the lifecycle status. | `staff.controller.ts:962-1067` |
| Readiness to dispatcher/planner | Ready when active; checked on assignment | **Supported, one gap.** Readiness blocks job allocation and shift start, and a worker re-checks every 2 minutes. **Adding someone to a shift doesn't check readiness**; it's only caught later. | `apps/api/src/modules/dispatch/jobs.controller.ts:611-651,1765,1824-1861` |

**Gaps to assess (reviewer's list, demo status):**

| Gap | Demo | Suggested demo option |
|---|---|---|
| Starter checks per role | **Not seeded** | Seed adopted, published (by a second seeded user) and mapped checks for Driver, Care assistant, ECA, Technician and Paramedic. |
| Stage due dates and escalation | **Missing.** Onboarding items have no due date. | A target date for each stage (e.g. checks complete within N days of start), feeding the existing escalation chain. |
| Requested / chased / received dates | **Partial.** References have requested, received and verified dates. DBS has no "applied on" date. No "chased on" anywhere. | Structured chaser log for references and DBS. |
| Rejection → re-upload task | **Missing** | Notify the uploader with the reason, open a resubmission task, track how many attempts. |
| Per-person evidence pack | **Missing.** Only the organisation-wide pack and the data protection access-request export. | Per-person timeline and evidence pack (PDF or zip). Viewing and exporting are logged. |

### B. Training

| Step | Live app (_to verify_) | Demo | Evidence |
|---|---|---|---|
| Training tab and group training | Course, date, register ref, provider, expiry, attendees; one record per attendee | **Partial.** Group training does this: register reference required, up to 100 attendees, no recording your own training. **The course catalogue isn't seeded.** No certificate can be attached. | `apps/api/src/modules/staff/training.controller.ts:150-215` |
| Verify against register | Per record; no self-verification | **Missing.** Training records have no verification step and **don't feed the matrix**. Only verified evidence on a requirement does. | `apps/web/src/pages/staff/TrainingSupervision.tsx:91` (the screen text promises verification, but nothing implements it) |
| Role-based matrix | Met / due soon / overdue / missing; empty in live | **Supported but not seeded.** Statuses are Met, Due soon, Overdue, Awaiting, Missing and Not required, with filters and a logged CSV export. Nothing is mapped. | `packages/rules/src/matrix.ts:18-43`, `staff.controller.ts:459-576` |
| Expiry alerts and escalation | Owner → lead → manager | **Supported.** Reminders at 90, 60, 30, 14 and 7 days go to the owner, then a deputy, then managers. Escalation goes to the HR lead after 1 day and the registered manager after 7, by email and push. | `packages/domain/src/notifications.ts`, `packages/domain/src/escalations.ts` |

| Gap | Demo | Suggested demo option |
|---|---|---|
| Starter role-based training | **Not seeded.** The library has manual handling, BLS, safeguarding, IPC and induction. **There's no driving assessment item.** | Seed role mappings, and add a driving assessment item. |
| Plan future sessions, invite, mark attendance | **Missing.** Future dates are refused. | Session scheduling that invites people whose training is due soon, then marks attendance. |
| Bulk verification | **Missing** | Verify a whole session against one register, by someone other than whoever recorded it. Link courses to requirements so verified training updates the matrix. |

### C. Supervision and corrections

| Step | Live app (_to verify_) | Demo | Evidence |
|---|---|---|---|
| Request or book | Preferred date, supervisor, topics | **Partial.** Crew can request a date, a supervisor and a topic, but **can't choose the meeting type**. **Accepting a request doesn't create a booking.** HR can book directly with a type (one-to-one, clinical, return to work, probation). | `apps/api/src/modules/staff/self-service.controller.ts:170-448`, `training.controller.ts:250-262` |
| Confirm (not own) | Second person | **Supported.** The requester can't decide their own request, and the person being supervised can't close the booking. | as above |
| Outcome | Held / missed / cancelled + notes | **Supported.** Held writes a permanent supervision record. Missed or cancelled needs a reason, with optional rebooking. Staff can acknowledge the record. **No notifications** are sent. | `training.controller.ts:268-417` |
| Correction request | Reason, HR decision | **Partial.** Marking a correction "Applied" doesn't change the data, the note is optional on rejection, and no notification is sent. | `staff.controller.ts:287-367` |

| Gap | Demo | Suggested demo option |
|---|---|---|
| Recurring schedules (8-week, probation) | **Missing.** Held supervisions don't satisfy the "supervision every 2 months" requirement. | Recurring cycle per person, probation review dates, and reminders. |
| Escalate missed supervision | **Missing** | Raise a saved alert so the existing owner → lead → manager escalation applies. |

---

## Focus area 2: ambulance checks, defects and compliance

### D. Daily vehicle checks

| Step | Live app (_to verify_) | Demo | Evidence |
|---|---|---|---|
| Crew completes published checklist (phone) | Not observed by reviewer | **Supported.** Each item is Pass, Fail or N/A. A failure needs a reason, and a photo is optional. The odometer reading is required. It works offline, and a critical failure tells the crew "Do not use" and offers "Call control". Checks are started from a shift only. | `apps/mobile/src/screens/Vdi.tsx`, `apps/api/src/modules/crew/crew.controller.ts:161-199` |
| What managers see | Not visible in live web | **Partial.** The vehicle's Inspections tab shows the time, the outcome, the failed item codes and the number of amendments. **It doesn't show who did the check, the odometer, the reasons, photos or linked defects**, although the API returns most of these. | `apps/web/src/pages/fleet/VehicleDetail.tsx:475-536` |
| Items / critical | 7 of 9 critical | **Supported.** The seeded checklist has 9 items, 7 of them critical: tyres, lights, brakes, restraints, ramp/lift, safety kit, clinical kit. | `packages/db/src/admin/seed.ts:409-427` |
| Submission, amendments | Recorded; amendments separate | **Supported in the API.** Amendments are append-only. **No screen lets anyone make an amendment.** | `inspections.controller.ts:168-387` |
| Critical fail → stop-use defect, vehicle blocked | Yes | **Supported.** It also releases future jobs and alerts control. | `inspections.controller.ts:284-310`, `packages/domain/src/fleet.ts:29-44` |
| Checklist versioning, second-person publish | Yes | **Supported.** The drafter can't publish their own version, and publishing retires the old one. | `inspections.controller.ts:68-165` |

| Gap | Demo | Suggested demo option |
|---|---|---|
| Alert if vehicle used or first job without a check | **Partial.** A shift can't start without a passed check and a pre-shift clean, but **nobody is alerted ahead of time**. | Raise a "no check before first job" alert to control and the Fleet lead at a set time before the vehicle's first job. |
| Non-critical fails → owned defect with repair-by date | **Partial.** They create a MINOR defect with no owner and no deadline until someone classifies it. | Auto-assign the Fleet lead and set a default repair-by date by severity. |
| Cleaning as a check item | Separate model (pre-shift, between patients, enhanced). The shift gate requires a pre-shift clean. | Keep it separate (it is already enforced), or show it as a line on the check. |
| Photos on failed items | **Partial.** Photos are captured and stored, but not shown on the web or copied onto the defect. | Show photos and carry them onto the defect. |

### E. Defects and return to service

| Step | Live app (_to verify_) | Demo | Evidence |
|---|---|---|---|
| Report defect | Severity, description, ≤6 photos, stop-use, repairer notes | **Supported.** CRITICAL, MAJOR or MINOR, up to 6 photos; stop-use is forced on for critical. There's an optional "Anything else the repairer should know" field (seen live). | `apps/api/src/modules/fleet/defects.controller.ts:87-144`, `apps/mobile/src/screens/Defect.tsx` |
| Critical → blocked, control alerted, no allocation | Yes | **Supported, enforced by the server.** The vehicle is BLOCKED, control gets a critical alert, and future jobs are released and need reassigning. The planner shows a blocked lane, and allocation is refused with no override. | `packages/domain/src/dispatch.ts:405-458`, `packages/rules/src/readiness.ts:162-168` |
| Repair plan / booking | Recorded; stays blocked | **Partial.** Recorded as free text only, with no structured garage, date or reference. | `defects.controller.ts:345-349` |
| Repair completion | Work, parts, person, date, job sheet | **Partial.** The repairer and date are recorded automatically and a job sheet can be attached, but the work done and parts are free text. | `defects.controller.ts:159-243` |
| Return to service by a different person | Not observed | **Supported.** Needs the `fleet.return_to_service` permission, the releaser must not be the repairer, and the release record can't be changed. It can be reopened. | `defects.controller.ts:285-342` |
| History | Retained | **Partial.** The audit log and release record are kept, but **there's no defect status history table**. The vehicle's status history leaves out defect-driven blocking. | `packages/db/prisma/schema.prisma:2932-2947` |

| Gap | Demo | Suggested demo option |
|---|---|---|
| Auto-assign owner (Fleet lead) | **Missing.** Defects have no owner field. | Add an owner, defaulting to the Fleet lead. |
| Review date and escalation for long blocks | **Partial.** Generic escalation goes to the Fleet lead, then the registered manager. A passed repair deadline only changes the display. | A review date for each critical defect; overdue repairs escalate. |
| Off-road workflow and reallocation | **Supported.** Off-road or quarantine releases jobs and alerts control. | Keep it. Show the affected jobs on the defect page. |
| Defect ↔ check link | **Partial.** Linked in the data but not on screen. | Show the link both ways. |
| Different person to lift off-road or quarantine | **Missing** (vehicles only; equipment has it) | Add the second-person rule for consistency. |

### F. Vehicle and equipment requirements

| Step | Live app (_to verify_) | Demo | Evidence |
|---|---|---|---|
| Adopt from library, publish by a second person | Yes | **Supported but not seeded.** The library has MOT, insurance and tax (statutory), plus LOLER and equipment servicing. **There's no vehicle servicing or conversion-certificate requirement.** Nothing is adopted in the seed. | `0008_library_ambulance_v1.sql:29-33`, `apps/api/src/modules/requirements/requirements.controller.ts:183-459` |
| Attach as inspection regime | Yes | **Supported for equipment** (LOLER, service, calibration, pre-use, PAT). Vehicle requirements are attached automatically when published. | `apps/api/src/modules/fleet/vehicles.controller.ts:945-1007` |
| Certificate upload and second-person verification | Green with expiry | **Supported** | `evidence.controller.ts:297-386`, `VehicleDetail.tsx:539-580` |
| Expiry alerts and escalation | Owner → lead → manager | **Supported.** Auto-applied requirements have **no owner**, so reminders go straight to managers. | `packages/domain/src/recompute.ts`, `escalations.ts` |
| Expired statutory item blocks in planner, no override | Yes | **Partial.** It blocks **allocation**, with no override. **The planner doesn't show the vehicle as blocked, and it can still be put on a shift.** | `readiness.ts:41-84`, `jobs.controller.ts:1785-1805` |

| Gap | Demo | Suggested demo option |
|---|---|---|
| Ready-to-use vehicle and equipment requirements | **Not seeded** | Seed adopted and published MOT, insurance, tax, LOLER and servicing on the seeded vehicles and stretcher, with a mix of green, amber and red. |
| Servicing by date or mileage affects readiness | **Supported.** Overdue by date or mileage blocks allocation. **"Due soon" isn't shown in the planner**, and no maintenance plans are seeded. | Seed maintenance plans. Show due-soon and overdue in the planner lane. |

---

## Focus area 3: incidents, audits and governance

### G. Incident reporting and resolution

| Step | Live app (_to verify_) | Demo | Evidence |
|---|---|---|---|
| Report | Type, date/time, title, location, description (no names), job refs, immediate action, NHS-funded | **Supported.** People references must be job or booking references, so names are refused. Future dates are refused. The report form sends no structured location. | `apps/api/src/modules/governance/incidents.controller.ts:47-172`, `packages/contracts/src/governance.ts:782-820` |
| Still at risk → alert | Manager and governance lead immediately | **Partial.** A critical in-app alert goes to the registered manager and governance lead straight away. **Email or push only arrives through escalation after about a day.** | `incidents.controller.ts:124-149` |
| Triage | Types, harm, lead, location | **Supported.** Priority, harm, category, named lead and protection steps. The deadline is the next working day. Staff reports have one type only. | `incidents.controller.ts:198-247`, `packages/rules/src/incidents.ts:86-89` |
| Stages | Stage column; not observed | **Supported.** Triage → Make safe → Assess reporting duties → Investigate → Respond → Actions → Learning confirmed → Closed, with blocking rules at each step. **Closing doesn't need a second person.** | `packages/rules/src/governance.ts:142-200` |
| Actions → evidence → second-person verify | Yes | **Supported.** The verifier must not be the owner or the person who submitted the evidence, enforced by the database too. Action history is append-only. | `apps/api/src/modules/governance/audits.controller.ts:1016-1133` |
| CQC notification | Draft in app, submit via portal, record reference | **Supported.** Reporting duties are suggested with a legal basis and deadline, and the CQC notifications register needs review by someone other than the preparer. **The two routes aren't linked.** Portal submission is out of scope by design. | `packages/rules/src/incidents.ts:179-305`, `apps/api/src/modules/governance/regulatory.controller.ts:750-945` |
| Reporter progress | "Reports you have made" | **Partial.** Shows the stage only, with **no outcome**. | `apps/web/src/pages/compliance/ReportIncident.tsx:160-182` |

| Gap | Demo | Suggested demo option |
|---|---|---|
| Second-person closure | **Missing** | Closure needs someone other than the lead. |
| Deadlines by harm level | **Partial.** Triage is always 1 working day, and action deadlines are set by hand. | Default deadlines by harm (values to be validated). |
| Duty of candour | **Supported**: flag, decision and 5 steps, with closure blocked until done. **No deadlines.** The governance lead can't make the candour decision (only the registered manager and director). | Add step deadlines after validating against the regulation. |
| Learning into reports and meeting packs | **Partial.** Learning is recorded (shown only for NHS-funded events) but not used in any report or pack. | A themes and lessons section in the governance meeting pack and the management pack. |
| Outcome to reporter | **Missing** | A short outcome message, visible to the reporter. |

### H. Audits and corrective actions

| Step | Live app (_to verify_) | Demo | Evidence |
|---|---|---|---|
| Template drafted, second-person publish | AC-07 | **Supported in the API.** Publish and activate both need someone other than the author. **There's no screen to write a template or a new version.** Seeded AC-01…11 have one control each, and only AC-07 is active. | `audits.controller.ts:145-371`, `seed.ts:30-108` |
| Schedule (auditor, owner, due), calendar | Yes | **Supported**, including repeat every N months and month and week calendars. | `audits.controller.ts:390-426`, `apps/web/src/pages/compliance/Audits.tsx` |
| Record responses (method, sample, recorder) | Yes | **Supported.** Append-only, and locked once submitted. | `audits.controller.ts:440-548` |
| Submit → findings → Inspection view | Yes | **Supported.** A failed critical control makes the whole audit non-compliant. Every Inspection view is logged. | `audits.controller.ts:550-668`, `inspection.controller.ts` |
| Action per failure | Yes | **Supported.** Created automatically, with a deadline by severity: 7, 14, 30 or 60 days. | `packages/rules/src/audits.ts:76-79` |
| Accept / return with reason | Owner | **Supported, done by the named reviewer** (not the auditor). Decisions are append-only. | `audits.controller.ts:670-736` |
| Re-audit | Yes | **Supported.** Scheduled automatically after the last action deadline. | `audits.controller.ts:645-658` |
| Second-person verify before close | Yes | **Supported.** **An audit with no failures closes without reviewer acceptance.** | `packages/domain/src/governance.ts:95-125` |

| Gap | Demo | Suggested demo option |
|---|---|---|
| Auditor independence or conflict check | **Partial.** The only rule is reviewer ≠ auditor. | Warn or block if the auditor owns the audited area or location. |
| Escalate overdue actions and re-audits | **Missing.** These are calculated live and never saved as alerts. There's no director stage. | Save them as alerts so escalation applies; add an optional director stage. |
| Ready-to-run onboarding and vehicle audits | **Partial** | Seed multi-control templates for recruitment and onboarding, and for vehicles and equipment, published by a second person. |
| Rolling annual programme | **Partial.** Repeat every N months per audit only. | An annual programme view across the five key questions. |
| Every open action has owner and due date | **Supported.** Both are required by the database. | — |
| Exportable timeline per person, vehicle or incident | **Partial.** Audit-log CSV filtered by record ID only. | A combined timeline for each record (who, what, when, why) with a PDF export. |

---

## Cross-cutting strengths to preserve (present in the demo)

- **Second-person rules:**
  - evidence verification;
  - publishing requirements, checklists and audit templates;
  - action verification;
  - audit review;
  - return to service;
  - CQC notification review;
  - meeting minutes;
  - policies;
  - fit and proper checks.

  Each endpoint does its own check; there's no shared helper.
- **Sensitive-view logging:** DBS, occupational health and personal data; safeguarding and harassment events; the Inspection view; exports; evidence downloads. The audit log is hash-chained and can't be changed by the app.
- **Role-limited access:** every route declares its permission, and the database enforces row-level security.
- **Clear status labels:** a word, an icon and a colour everywhere.

## Demo issues found during this review (not fixed)

1. A crew-app vehicle check with an N/A answer is rejected by the server (see headline 4).
2. Uploaded files tagged HR or criminal-offence can be seen by every evidence verifier, including the Fleet and Governance leads (`apps/api/src/modules/evidence/evidence.mapper.ts:13-24`).
3. The training screen tells users records are verified against the register, but no such workflow exists.
4. `docs/WORKFLOWS.md` describes things the code doesn't do:
   - the uploader is notified of a rejection;
   - a vehicle servicing requirement is in the library.

---

## Assumptions to verify before presenting as requirements

These values are encoded in the demo or suggested by the reviewer. Each needs checking against current official guidance before we treat it as a requirement.

| Item | Current demo value | Check against |
|---|---|---|
| CQC notifications (Reg 16 death, Reg 18 incidents) | "Next day" target | CQC Regulations 16 and 18 notification guidance ("without delay") |
| Planned manager absence notification | 28 days before | CQC Regulation 14 / absence notification guidance |
| Duty of candour | Flag at moderate harm or worse; 5 steps; no deadlines | Regulation 20 and CQC duty of candour guidance (notifiable safety incident definition, timing of notice and written follow-up) |
| RIDDOR | 10 days for specified injuries; 15 days for over-7-day injuries | HSE RIDDOR guidance |
| ICO personal data breach | 72 hours | ICO / UK GDPR Article 33 |
| Safeguarding referral | 24 hours | Local authority safeguarding procedures (vary by area) |
| Commissioner notification | 2 working days for moderate harm or worse on NHS-funded work | The relevant NHS contract and commissioner requirements |
| PSIRF / LFPSE | Learning response required for NHS-funded events | NHS England PSIRF and LFPSE guidance |
| Schedule 3 information | Item list | Schedule 3, HSCA 2008 (Regulated Activities) Regulations 2014 |
| Training intervals (BLS and manual handling yearly, safeguarding every 3 years, etc.) | Library defaults | Skills for Health core skills framework / intercollegiate safeguarding guidance |
| Supervision every 8 weeks | Library says 2-monthly | Internal policy decision, not a statutory figure |
| Vehicle statutory items (MOT, tax, insurance) and LOLER every 6 months | Library defaults | DVSA / DVLA guidance; LOLER 1998 (6 months for lifting people) |

---

## Part 2: live app verified (12 Nov 2026, all 11 profiles)

### Access by profile

**No profile was asked for an authenticator code**, although the sign-in page says managers, directors, administrators, HR, governance and auditors need one. The deployment runs with `DEV_DISABLE_MFA=true` (the default in `docker-compose.coolify.yml`).

| Profile | Navigation |
|---|---|
| Registered manager, Director | Dashboard, Inspection, Report an incident, Alerts, Staff, Vehicles and assets, Compliance, Premises safety, Work planner, Reports, Speak up, Settings |
| Org admin | Dashboard, Report an incident, Reports (none available), Speak up, Settings |
| HR lead | Dashboard, My record, Report an incident, Alerts, Staff, Compliance, Reports (4), Speak up |
| Governance lead | Dashboard, Inspection, My record, Report an incident, Alerts, Staff, Vehicles and assets, Compliance, Premises safety, Reports (9), Speak up, Settings |
| Auditor | Dashboard, Inspection, Alerts, Staff, Vehicles and assets, Compliance, Premises safety, Reports, Speak up, Settings (cannot report incidents) |
| Dispatcher | Dashboard, My record, Report an incident, Alerts, Staff (roles and restrictions only), Vehicles and assets (read-only), Compliance, Work planner, Reports, Speak up |
| Fleet lead | Dashboard, My record, Report an incident, Alerts, Vehicles and assets, Compliance, Work planner, Reports (2), Speak up |
| Premises lead | Dashboard, My record, Report an incident, Alerts, Compliance, Premises safety, Reports (1, no export), Speak up |
| Crew (Alex Morgan, Sam Taylor) | Home, My record, Report an incident, Compliance, Speak up |

Typing the address of a blocked page shows "Your role does not give access to this page", so role limits hold even outside the menus.

### Reviewer notes checked against the live app

| Reviewer note | Live result |
|---|---|
| Role checks depend on the library; roles show "Nothing mapped" | **Confirmed.** "Our requirements (0): Nothing adopted yet." All 14 roles say "Nothing mapped: nobody can be approved for this role." For Jordan Reed: "Driver has no requirements set up, so nothing can be checked and nobody can be approved for it." No Start checks button appears. |
| Add person fields and starting status | **Confirmed.** The form is "Add a staff member" and also asks for the role to check for. |
| Schedule 3 checks; DBS and health hidden from most roles | **Confirmed.** Recruitment tab shows all 8 Schedule 3 items as "Red – Missing: No requirement covers this yet". Governance and Auditor see no Schedule 3, DBS or role-check panel. Manager and HR do. |
| Evidence unverified until reviewed; no self-verification | **Confirmed (wording only).** "You cannot verify documents you uploaded yourself." The queue is empty, so verify and reject couldn't be watched. |
| Role approvals retained | **Confirmed.** Alex Morgan has Driver and Care assistant, "Seeded synthetic approval". **No revoke control.** |
| Training matrix empty | **Confirmed.** "No requirements are mapped to roles yet." Group training has no courses to choose ("Record training for 0 people" is disabled). |
| Supervision request, booking, types | **Confirmed.** Types are One to one, Clinical supervision, Return to work, Probation review. No bookings exist. |
| 7 of 9 checklist items critical; second-person publish | **Confirmed.** "Daily vehicle inspection (version 1), 9 items, 7 critical, Published"; drafted by "unknown". |
| Crew check not visible in web | **Confirmed.** Every vehicle shows "No inspections." The web app has no defect reporting for crew ("use the mobile app"). |
| Defect report fields, up to 6 photos, repairer notes | **Confirmed.** It does have "Anything else the repairer should know" (correction to Part 1). Its label reads "(optional) (optional)". |
| Defects unassigned | **Confirmed.** No owner column. |
| Critical defect blocks vehicle and planner | **Confirmed.** AMB-03 "Red – Blocked – 1 open stop-use defect"; the planner's vehicle list marks it blocked. Fleet lead, Manager, Director and Dispatcher get the alert. |
| Return to service by a different person | **Not observable.** The only defect is still "Reported – awaiting repair". |
| Vehicle requirements (MOT, insurance, tax, LOLER) | **Confirmed not set up.** No vehicle has documents; STR-0001 says "Grey – No inspection regime set up"; no maintenance plans exist. |
| Incident stages | **Not observable.** "No events." The report form and the "still at risk" option match the brief. |
| Audit template AC-07 published; others draft | **Confirmed.** AC-07 is active; AC-01–06 and AC-08–11 are "Draft – awaiting a second person to publish". There is no way to write a new template, only Copy. |
| Audit, actions, re-audit | **Confirmed.** AUD-102 (4 pass, 1 fail) has ACT-218 and ACT-219, both overdue. AUD-103 re-audit is overdue and not started. AUD-102 and AUD-103 aren't linked on screen. |
| Overdue actions escalate | **Not escalating.** The overdue items appear in Alerts for the Manager and Governance lead, but every Alerts page says "No notification rules name your role", and no deputies or Speak Up guardian are set. |

### New issues found only in the live app

1. **Authenticator codes are off in the deployment** even though the sign-in page promises them. Fine for a demo, but the wording misleads, and it must not reach any non-demo environment.
2. **Staff records with real-looking names** were added on the live site today by the HR lead login: "Kiran" (ST-0072) and "Spandana Nadendla" (ST-0045), both Checks in progress. The project rules say synthetic data only. Please confirm these are test names, or remove them.
3. **Seeded data contradicts itself.** Alex Morgan is "Approved for role: Driver", but the planner says "Not ready — Licence does not cover C1 vehicle; No driving licence details on record; Driving licence not verified". The seed bypasses the approval gates.
4. **Misleading text on a vehicle's Documents tab:** "Every published vehicle requirement is already on this vehicle" is shown when nothing has been published.
5. **The overdue re-audit (AUD-103) shows for the Manager but not the Director,** and Governance sees "You own it". Worth checking the alert audience rules.
6. **HR, Fleet lead and Dispatcher cannot open Settings,** so they can't see the requirement library their work depends on. Governance can see it but has no Adopt button.

### What couldn't be observed live, and why

| Area | Reason |
|---|---|
| Start checks, evidence verify/reject, role approval flow | Nothing is mapped to roles, and no documents exist. |
| Training verification, matrix status colours | No courses and no mappings. |
| Supervision outcomes | No bookings. |
| Vehicle check detail, photos, amendments | No checks submitted (they come from the mobile app). |
| Repair, sign-off, return to service | The only defect hasn't been repaired. |
| Incident triage, stages, duties, candour, closure | No events. |
| Escalation emails or pushes | Can't be seen in the web app; the notification rules are empty. |

None of these can be shown without creating records, which this review didn't do. A seeded demo scenario (see headline 1) would make every one of them viewable.

---

## Part 3: reviewer's workflow notes reconciled with the findings

The reviewer's eight-workflow summary (12 Nov) is mostly right. Where the code does more than the live app could show, or the note needs correcting, it's listed below. **Agree** means the code and the live app back the note.

| # | Reviewer's improvement | Verdict | Detail |
|---|---|---|---|
| 1 | Setup is a single point of failure; ship standard checks per role | **Agree.** The library isn't broken, though, just never adopted. | The library holds AMB-STF-01…11; the seed adopts and maps none. |
| 1 | Per-stage due dates and escalation | **Agree** | Onboarding items have no due date (`packages/rules/src/recurrence.ts:74-75`). |
| 1 | Requested, chased and received log for references and DBS | **Partly built** | References already have requested and received dates. There's no "chased on", and DBS has no "applied on". |
| 1 | Rejected evidence loops back to the uploader | **Agree** | The reason is stored, but nothing is sent and no task is created. |
| 1 | One exportable file per person | **Agree** | Only the organisation-wide pack and the data protection access-request export exist. |
| 2 | Ready-made training per role | **Agree** | There's no driving assessment item in the library either. |
| 2 | Plan sessions, invite, mark attendance | **Agree** | |
| 2 | Bulk verification | **Agree, and the gap is bigger.** | Training records have no verification step at all and don't feed the matrix. |
| 3 | Recurring supervision schedule (every 8 weeks; probation at 3 and 6 months) | **Agree** | 8 weeks and 3/6 months are policy choices, not statutory. |
| 3 | Escalate missed supervisions | **Agree** | |
| 4 | Nobody reviews the check on the web | **Partly.** The web has an Inspections tab, but it shows only time, outcome and failed codes. | Add who did it, odometer, reasons, photos and linked defect. |
| 4 | Flag vehicle used without a check today | **Agree** | Shift start is blocked without a passed check and clean, but nobody is warned in advance. |
| 4 | Non-critical failures go nowhere | **Partly.** They create a MINOR defect, but with no owner or repair-by date. | |
| 4 | Make pre-shift clean part of the check | **Partly.** It's already a hard requirement at shift start (separate record). | ACT-218 shows the gap in the audit data, not a gap in the gate. Showing it as a check item is a presentation choice. |
| 4 | Photo for each failed item | **Partly.** The crew app already captures them. | Not shown on the web and not copied onto the defect. |
| 5 | Defect has no owner | **Agree** | No owner field (`schema.prisma` Defect). |
| 5 | Critical defects need a review-by date and escalation | **Agree** | Generic alert escalation exists (Fleet lead after 1 day, manager after 7), but there's no target date. AMB-03 has been blocked since 22 Oct. |
| 5 | Blocking through a defect doesn't prompt job reallocation | **Disagree (code).** | A stop-use defect already releases future jobs, sends a critical "needs reassignment" alert to control and lists the affected jobs (`packages/domain/src/dispatch.ts:405-458`). It couldn't be seen live because no jobs were booked. Improvement: show the affected jobs on the defect page. |
| 5 | Link defect and the check that found it | **Partly.** Linked in the data both ways. | Not shown on screen. |
| 6 | Vehicle and equipment requirements pre-loaded | **Agree** | Also add a vehicle servicing item, which the library lacks. |
| 6 | Overdue service doesn't block | **Partly wrong.** | Overdue servicing by date or mileage **does** block allocation with no override (`packages/rules/src/readiness.ts:174-185`). What's missing is a planner warning, plus seeded maintenance plans. An expired MOT also doesn't show as blocked in the planner. |
| 7 | Investigation stages need defining | **Already defined in code** | Triage → Make safe → Assess reporting duties → Investigate → Respond → Actions → Learning confirmed → Closed, with checks at each step. Not visible live because there are no events. **Closure by a second person is missing.** |
| 7 | Harm-driven deadlines | **Partly** | Reporting-duty deadlines already come from harm. Triage is fixed at 1 working day, and investigation and action deadlines are manual. |
| 7 | No duty of candour step | **Disagree (code).** | It's built: flagged at moderate harm or worse, the decision is recorded, the 5 steps are recorded with dates, and closure is blocked until done. It couldn't be seen live (no events). **But the reviewer's "within 10 working days" is not a legal deadline**; see the regulatory notes below. |
| 7 | Learning goes nowhere | **Agree** | Learning is recorded but not in any report or pack, and only shown for NHS-funded events. |
| 7 | Outcome note to reporter | **Agree** | |
| 8 | Auditor isn't independent | **Agree** | AC-07 was published by the Governance lead, who is also AUD-102's auditor. The only rule today is reviewer ≠ auditor. |
| 8 | Overdue audit work isn't escalated | **Agree** | Overdue actions and audits are calculated live, never saved as alerts, so escalation skips them. There's no director stage. |
| 8 | Only 1 of 11 templates live | **Agree** | The others are single-control drafts. There's also no screen to write a template. |
| 8 | Rolling 12-month programme | **Agree** | |
| All | Owner and due date on every open item | **Agree** | Actions already require both. Defects, auto-applied requirements and onboarding checks don't. |
| All | One timeline per record, exportable | **Agree** | The audit log has the data but is filtered by exact record ID only, so an event's actions don't show under the event. |
| All | Ship ready-made setup data | **Agree.** The top priority. | |
| All | Keep second person, view logging, role limits, honest labels | **Agree.** All confirmed live. | |

### Regulatory notes (checked 12 Nov 2026)

| Topic | What the official source says | Effect on the demo |
|---|---|---|
| Duty of candour (Regulation 20, HSCA 2008 (Regulated Activities) Regulations 2014) | Notify "as soon as reasonably practicable". In person, with a true account, the further enquiries planned and an apology, all recorded. Then a written follow-up with the results of enquiries and an apology. If the person can't be contacted, keep a record of the attempts. **No fixed number of days.** Source: [CQC Regulation 20](https://www.cqc.org.uk/guidance-regulation/providers/regulations-service-providers-and-managers/health-social-care-act/regulation-20/regulation-20-in-full) and [what you must do](https://www.cqc.org.uk/guidance-regulation/providers/regulations-service-providers-and-managers/health-social-care-act/regulation-20/what-you-must-do). The NHS Standard Contract (SC35) requires compliance with Regulation 20 but sets no day count. | Don't encode "10 working days" as law. Offer it as an **organisation policy target** (configurable, default off or 10 working days, labelled "local policy"). Add a "could not contact: attempts recorded" route if it's not already among the 5 steps. |
| CQC death notification (Regulation 16, Registration Regulations 2009) | "Without delay", including the circumstances of the death. Source: [CQC Regulation 16](https://www.cqc.org.uk/guidance-regulation/providers/regulations-service-providers-and-managers/cqc-registration-regulations/regulation-16). | The demo's "next day" target is stricter than the wording. Label it "without delay (target: next day)". |
| CQC other incidents (Regulation 18) | "Without delay": serious injury, abuse or allegation, police-reported incidents, events that stop safe service. Source: [CQC Regulation 18](https://www.cqc.org.uk/guidance-regulation/providers/regulations-service-providers-and-managers/cqc-registration-regulations/regs-regulation-18). | Same labelling as above. |
| Supervision every 8 weeks; probation at 3 and 6 months | Not statutory. | Configurable policy settings. |

The other rows in "Assumptions to verify" (RIDDOR, ICO, safeguarding, commissioner, PSIRF, training intervals, LOLER) are still to check before any of them is presented as a requirement.

---

## Combined improvement backlog

Ordered by value and dependency. **Batches 1–3 are implemented; Batches 4–5 stay deferred until Coolify sign-off of 1–3.**

**Batch 1: make the demo work from day one (seed data only, no new features) — DONE**

1. **Starter configuration.** The seed adopts library items, has a second seeded user publish them, and maps them:
   - Staff checks per role: Driver, Care assistant, ECA, Technician, Paramedic.
   - Training requirements per role, and a matching course catalogue (add a driving assessment item).
   - MOT, insurance and tax on every vehicle; LOLER and servicing on STR-0001; maintenance plans by date and mileage.
   - Multi-control audit templates for vehicles and equipment, and for recruitment and onboarding, published by a second person.
2. **Records at every stage, so each workflow can be shown:**
   - a candidate with checks part-done, one rejected document and one awaiting verification;
   - a group training session awaiting verification;
   - booked, held and missed supervisions;
   - a submitted vehicle check with one non-critical failure;
   - a defect at "Repaired, awaiting sign-off";
   - an incident at Investigate, with candour in progress;
   - a CQC notification draft.
3. **Fix seed contradictions**, for example Alex Morgan approved as a Driver with no licence.

**Batch 2: quick fixes — DONE**

4. Fix the vehicle-check N/A bug (`Vdi.tsx` against `inspections.controller.ts` — FAIL-only reason).
5. Fix the misleading text: the Documents tab wording, "(optional) (optional)", and the sign-in page promising authenticator codes while MFA is off.
6. Show the full check on the web: who did it, odometer, reasons, photos and linked defect, plus the defect-to-check link both ways.
7. Add a Revoke button for role approvals (the API exists).

**Batch 3: ownership, deadlines and escalation — DONE**

8. Defect owner, defaulting to the Fleet lead, plus a review-by date by severity that escalates when passed.
9. Save overdue actions, audits and re-audits as alerts so the existing owner → lead → manager escalation applies (`sync-overdue-alerts` worker). Director stage still optional / Batch 4 polish.
10. Reference and DBS chase log (requested, chased, received) with API + History UI; seeded for Jordan Reed.
11. Missed-supervision alerts on close + sync; 8-week cycle and overdue probation-review alerts.
12. "No check before first job" alert when a started shift has a job and no VDI.
13. Non-critical check failures get an owner and repair-by date; the failed-item photo is copied to the defect.
14. Planner shows overdue servicing / expired documents as blocked; putting such a vehicle on a shift is refused.

**Batch 4: governance depth — DEFERRED**

15. Incident closure by a second person.
16. A short outcome note to the reporter.
17. A candour policy target (configurable, labelled as local policy), and the candour decision opened to the Governance lead if wanted.
18. A lessons and themes field, fed into the governance meeting pack and the management pack, for all events, not only NHS-funded ones.
19. An auditor independence check: the auditor isn't the owner, and warn if they published the template.
20. A rolling 12-month audit programme across the five key questions.
21. A screen to write audit templates.

**Batch 5: records and training workflow — DEFERRED**

22. One timeline per person, vehicle and incident, exportable as PDF, with viewing and export logged.
23. Training records that verify against the register (a whole session at once, by a second person), linked to requirements so the matrix updates.
24. Planned training sessions with invitations and attendance marking.
25. Rejected evidence notifies the uploader with the reason and creates a re-upload task.

### Next step

Redeploy / re-seed Coolify so Batches 1–3 are reviewable live, then sign off before starting Batch 4 or 5.

---

## v36 UI gaps deferred (until Batches 1–3 / shell sign-off)

These v36 prototype screens or workflows stay **out of scope** until product asks for them. APIs may be Partial or missing; do not build them in the IA reshape:

| v36 area | Why deferred |
|---|---|
| Contractors & visitors (`#41`) | No first-class product API |
| HR shifts & rota (`#34`) as a separate product surface | Planner/shifts are control-centric; not an HR rota |
| Planned training sessions, invitations, bulk verify | Batch 5 |
| Absence / leaver depth beyond existing staff records | Batch 5 / later HR |
| Candidate portal as a separate app | Same self-service APIs; dedicated surface later |
| Demo-only: view-as, time machine, guided tour, shared localStorage | Not product features |
| Batch 4 governance polish (second-person close, candour step targets, auditor ≠ owner, rolling programme, template authoring UI) | Already deferred |
| Per-entity timeline PDF; evidence rejection → re-upload task | Batch 5 |
