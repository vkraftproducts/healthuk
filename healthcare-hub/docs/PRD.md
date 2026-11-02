# Product Requirements Document — Healthcare Hub

Version 1.0 (derived from Development Brief v0.1 and Concept Wireframes, 22 Oct 2026)
Requirement IDs (e.g. `HR-02`, `JOB-03`) match the brief and are used in commits and tests.

---

## 1. Summary

Healthcare Hub brings workforce readiness, fleet safety, healthcare governance (CQC
evidence), premises safety and work allocation into one system. The home dashboard tells
the registered manager **what needs attention, who owns it, when it is due, and whether it
prevents safe deployment**. A crew app (Android/iOS) gives staff their shift, jobs, checks
and policy acknowledgements.

First deployment: independent ambulance and patient transport service (England, CQC-regulated),
pilot scale 100 staff, 50 vehicles, 10 locations, 500 jobs/day. The core must support dental
and care-home **sector packs** later without code forks.

### 1.1 Goals

- G1: No unsafe or legally invalid crew/vehicle can be allocated or start a shift.
- G2: Every requirement has an owner, a deadline, verified evidence and a visible status.
- G3: Audit → finding → action → verification → re-audit is one connected, immutable trail.
- G4: An inspection evidence pack can be produced for a location/period in minutes.
- G5: Strict isolation between organisations, and between HR/clinical/operational data.

### 1.2 Non-goals (initial build)

E-prescribing, eMAR, dental charting, resident care plans, payroll, automated clinical
triage, route optimisation, CQC portal submission, NHS integrations, clinical decision
support. Software **supports** compliance; it does not certify care or predict a CQC rating.

### 1.3 Success metrics (pilot)

- 0 allocations that violate a blocking rule (verified by audit query).
- 100% of dashboard counts reconcile to underlying records (UAT-08).
- p95 dashboard and job actions < 2 s at pilot load (NFR-02).
- ≥ 90% of crew complete VDI + cleaning in app within 30 days of launch.
- Inspection pack export for one location/quarter < 5 min.

---

## 2. Users and roles

| Role                             | Primary needs                                 | Default access (see SECURITY_COMPLIANCE §2 for full matrix)                    |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| Director / Registered manager    | Overview, approvals, escalations, exports     | Org overview, governance approval, risk escalation, exports                    |
| HR & training lead               | Recruitment, clearance, training, supervision | Staff evidence; clinical job details hidden                                    |
| Dispatcher / Control             | Bookings, allocation, live jobs               | Availability, clearance result, job data; **no** DBS content, salary, OH files |
| Fleet lead                       | Vehicles, equipment, defects, VDI             | Assigned assets, defects, inspections, maintenance                             |
| Premises lead                    | Premises register, checks, contractors        | Assigned premises items                                                        |
| IPC / Clinical / Governance lead | Audits, policies, risks, incidents            | Compliance module, audit approvals                                             |
| Crew member                      | Shift, jobs, checks, policies, own profile    | Own data and assigned jobs only                                                |
| Auditor / External reviewer      | Time-boxed evidence review                    | Read-only, approved scope, exports separately controlled                       |
| Platform admin (supplier)        | Support                                       | Break-glass only: time-limited, authorised, logged                             |

Users can belong to multiple locations with different roles per location.

---

## 3. Information architecture

Left nav (wireframes): **Dashboard · Staff · Vehicles and assets · Compliance · Premises
safety · Work planner · Reports · Settings**. Header: organisation switcher, breadcrumb
`Organisation / Location / Service`, date, Refresh, last-updated time and source health.

Organisation model: `Organisation → Locations → Service types & registered activities`.
Vehicles/equipment move between locations with dated history. Group dashboard may
aggregate authorised organisations without exposing patient/HR records across boundaries.

---

## 4. Functional requirements by module

Each module lists requirements, then user stories with acceptance criteria (AC).
"MUST" = required for its phase; "SHOULD" = required unless descoped in DECISIONS.md.

### 4.1 Platform & access (SYS-01, SEC-01)

- MUST enforce org/location/role permission server-side on every record, attachment,
  search, report and API.
- MUST support multi-location membership with role per location.
- MUST revoke leavers immediately (sessions + device tokens) while retaining authorship.
- MUST provide time-limited, approved, logged privileged support ("break-glass") access.
- MUST require MFA for privileged roles (manager, HR, governance, admin, auditor).

**US-SYS-1** As an HR lead, when I mark a staff member as leaver, they lose access instantly.
AC: next API call with their token returns 401; mobile cached data is wiped on next contact;
their historic VDIs still show them as author.

### 4.2 Home dashboard (DASH-01, ALERT-01..04) — wireframe 01

- KPI tiles: **Overdue tasks**, **Due in 30 days**, **Blocked vehicles**, **Jobs today**
  (plus Unverified count in module status). Counts shown separately, never merged.
- "Action required" table: Item, Owner, Deadline, State (e.g. `RED – blocked`,
  `RED – overdue`, `AMBER – due soon`), with _View all_ and _Export_.
- Module status panel: Staff (unverified), Fleet (blocked), Compliance (overdue),
  Premises (due today); click drills into exact requirements.
- Today in operations: jobs awaiting allocation, crew acknowledgements due.
- Filters: organisation, location, service, module, owner, date range.
- Shows last successful refresh and explicit "source unavailable" state.
- Critical findings stay visible until **verified closed**. A critical red keeps the
  module red regardless of percentages.
- Optional evidence coverage = verified current applicable ÷ all applicable, showing
  numerator, denominator, exclusions, labelled "Internal measure — not a CQC rating".

**US-DASH-1** As a registered manager I open the dashboard and see each overdue item with
its exact reason, owner and next action. AC: every tile number equals the count of rows
returned by its drill-down (UAT-08); colours always accompanied by text.

### 4.3 Staff & recruitment (HR-01..04) — wireframe 02

- Lifecycle: `CANDIDATE → CHECKS_IN_PROGRESS → READY_FOR_REVIEW → APPROVED_FOR_ROLE →
ACTIVE → SUSPENDED | LEAVER`. Only HR/management approve.
- Profile tabs: Overview, Recruitment, Training, Supervisions, Appraisals, Documents, History.
- Requirement rows: Requirement, Verified by, Next date, Status — e.g. identity & right to
  work, two references, DBS suitability review, driving licence entitlement, moving &
  handling competence, supervision.
- Records: identity/contact (restricted), recruitment file incl. employment history gaps,
  references (2 by default, with approved-alternative rationale), DBS (eligibility, level,
  barred list, certificate no./date, Update Service consent, risk decision, **policy review
  date — not expiry**), right to work (method, checker, restrictions, follow-up if needed),
  driving licence categories/restrictions/expiry/periodic checks, professional registration
  (HCPC/NMC/GDC) + indemnity, contract/role/manager/pattern, induction, probation,
  OH fit-for-duty **status** (clinical detail stored separately and restricted), training
  matrix by role, supervision, appraisal, objectives.
- Role/service change recalculates required training and clearance (HR-03).
- Suspension/restriction applies immediately to future allocations.
- Staff self-service: request corrections, upload certificates, book/acknowledge tasks.
- Dispatcher sees only "approved roles and restrictions" — never DBS/OH documents.
- Intervals (references, appraisal, refreshers) labelled with their basis
  (law / guidance / contract / local policy). DBS has **no** universal expiry.

**US-HR-1** As a crew member I upload my renewed licence. AC: status becomes
`AMBER – awaiting verification` (if old still valid) or `GREY – unverified` (if expired);
never green until a Fleet reviewer verifies.

### 4.4 Vehicles & equipment (FLT-01..08)

- Vehicle register (reg, VIN, type, ownership, base, seats, wheelchair capacity, stretcher,
  permitted loads, insurance/use cover, tax, MOT/test, service history, availability).
- Maintenance by date **and** mileage — whichever first; flag stale or decreasing odometer.
- Equipment register (asset ID, serial, model, location/vehicle, SWL, accessories,
  instructions, maintenance, calibration, inspection regimes). Per-asset regime: LOLER
  thorough examination, servicing and pre-use checks are **separate** schedules.
- VDI per vehicle per shift: named checker, odometer, checklist items (tyres, lights,
  brakes, fluids, restraints, ramps/lifts, accessibility kit, safety kit, clinical kit),
  pass/fail/N/A with reasons and photos. Immutable; corrections are amendments.
- Cleaning: pre-shift confirmation required; between-patient and enhanced cleaning.
- Defects: severity (`CRITICAL`, `MAJOR`, `MINOR`), photo, stop-use, affected future jobs
  auto-identified, repair work, **separate** authorised return-to-service.
- Fuel/expenses with receipt, approval, duplicate flag, CSV export.
- Asset quarantine recalculates vehicle capability (FLT-08). Hired vehicles/crews
  meet the same checks.

**US-FLT-1** As crew I report a critical ramp defect on AMB-03. AC: vehicle immediately
`RED – blocked`; affected jobs listed and flagged to control; dispatcher cannot allocate
AMB-03; only authorised reviewer can release after repair evidence (UAT-02, UAT-03).

### 4.5 Compliance & governance (COMP-01..04, AUD-01..02) — wireframe 03

- **Requirement library**: stable ID, title, applicability (service/location), basis type
  (LAW, REGULATORY_GUIDANCE, PROFESSIONAL_GUIDANCE, MANUFACTURER, CONTRACT, LOCAL_POLICY),
  regulation reference, source URL, source version/date, effective dates, owner, evidence
  type, recurrence, warning thresholds, blocking effect, approval role. Versioned.
- Evidence organised under **Safe, Effective, Caring, Responsive, Well-led** with
  configurable quality-statement headings; historical mappings preserved. One evidence
  item can satisfy many requirements (no duplicate uploads).
- **Applicability register** approved by the registered manager; N/A needs reason,
  reviewer, review date; reported separately.
- **Audit builder**: versioned templates (questions, criteria, sample method/size, period,
  location), clone, runs keep exact template version. Methods: records, observation,
  interview. Outcomes: compliant, partial, non-compliant, not assessed, approved N/A.
- **Audit actions**: each failure → severity, action, owner, deadline; closure requires
  evidence **and** reviewer verification; re-audit scheduled. Original audit unchanged.
- **Sampling record** (AUD-02): population, selection method, date range, sample IDs,
  reviewer, findings; warn on repeated selection of same subjects.
- **Policies/SOPs**: `DRAFT → IN_REVIEW → APPROVED → PUBLISHED → SUPERSEDED/ARCHIVED`;
  mandatory reader groups; acknowledgement per version; material change forces re-ack.
- **Risk register**: hazard, people affected, inherent/residual risk (org-configured
  matrix), controls, owner, review date, linked incidents.
- **Registration record** (COMP-03): conditions, registered locations/activities, RM, NI,
  statement of purpose, insurance, BCP, regulatory correspondence with deadlines.
- **Inspection evidence pack**: choose location/service/framework version/period → indexed
  PDF + ZIP with approvals, evidence dates, open gaps and actions. Logged and restricted.
- Starter audit controls AC-01..AC-11 seeded as **inactive templates** pending approval.

**US-COMP-1** (wireframe 03, AUD-102) IPC lead runs the vehicle cleaning audit on 5
vehicles across 3 shifts; 1 fails. AC: finding AC-07 shows `4 pass / 1 fail`; actions
ACT-218 (investigate) and ACT-219 (re-audit) created with owners/deadlines; audit outcome
`RED – action outstanding`; uploading evidence alone does not close ACT-218 (UAT-04).

### 4.6 Incidents, complaints & events (EVT-01..04)

- One event record links incident/accident/near miss/safeguarding/complaint/defect.
- Workflow: triage → protect → assess reporting duties → investigate → respond → actions
  → verify learning.
- **Reporting obligations** tracked individually (CQC notification, safeguarding authority,
  RIDDOR, insurer, commissioner, ICO breach) each with trigger, basis, deadline, decision,
  submission ref, receipt. No assumption that all events are reportable.
- Duty of candour: separate authorised decision record; system flags, never decides.
- Complaints: acknowledgement/response targets from configured policy, preferences,
  consent to share, outcome, escalation rights; compliments/feedback with themes.
- Safeguarding and HR details restricted.

### 4.7 Premises safety (HSE-01)

- Premises register per location: fire, water/legionella, electrical/gas, COSHH/infection
  (incl. oxygen storage for ambulance bases), people/workplace, building/equipment.
- Each item: location, responsible person, applicability decision, assessment, frequency
  source, next due, evidence, action owner. Admin-only bases don't get clinical controls
  by default. No universal PAT/annual intervals — intervals come from configured source.

### 4.8 Work planner & dispatch (JOB-01..04) — wireframe 04

- Booking: customer/reference, date, pickup window, appointment time, addresses & access,
  patient identifier + minimal contact, mobility, weight (if relevant), stairs, escort,
  infection precautions, communication needs, equipment, required crew skills. Minimise
  free text. Recurring journeys generate individually amendable instances.
- Day view grid: rows = vehicle + crew, columns = time slots; states allocated, in
  progress, break/reserve, available, BLOCKED.
- Allocation = vehicle + time-bounded crew assignment (driver + other roles; multi-crew,
  handovers, swaps, support teams). Never permanently tie a vehicle to one employee.
- **Validate assignment** panel shows each check as PASS / FAIL / PENDING with reason:
  staff competence & licence, vehicle & equipment suitability, no time conflict incl.
  travel and breaks, shift VDI & cleaning (pending until shift start).
- Validation covers the **whole planned job window** (e.g. licence expiring mid-job fails).
- Re-check at dispatch and at shift start. Allocation uses a DB transaction + exclusion
  constraint to prevent double booking.
- Job lifecycle: `BOOKED → ASSESSED → ALLOCATED → OFFERED → ACKNOWLEDGED → EN_ROUTE →
ARRIVED → PATIENT_ON_BOARD → AT_DESTINATION → HANDOVER_COMPLETE → COMPLETED`, plus
  `CANCELLED, REFUSED, NO_ACCESS, ABORTED, REASSIGNED` with reason, actor, timestamps.
- Late or unacknowledged jobs alert control.

### 4.9 Crew mobile app (APP-01..02) — wireframe 05

See `MOBILE_APP.md`. Shift readiness (driving clearance, VDI, cleaning gate), My jobs
(assigned only), job progress, checks & expenses, defect report, policies & messages with
acknowledgement, My profile. Offline drafts with idempotent sync. No interaction required
while driving. Push notifications contain no patient details.

### 4.10 Reports

Workforce readiness & training gaps; supervision planned vs completed; fleet availability,
defects, maintenance; overdue audits & action ageing; incident/complaint trends; policy
acknowledgement by version; premises compliance; journey punctuality, cancellations, aborts;
monthly management pack (PDF). Every metric documents its denominator, period and inclusion
rule. Exports logged.

### 4.11 Administration & settings

Organisations, locations, services, users & roles, sector packs, requirement library
publishing, due-date/warning rules, notification preferences & deputies, retention rules,
integrations (CSV import/export), audit log viewer.

### 4.12 Data import & migration (INT-01, MIG-01..03)

CSV import with preview, duplicate checks, per-row errors, rollback. Compliance workbook
staging: keep sheet/row/prompt code; header rows are structure; placeholders like `ENTER`,
`[ENTER PRACTICE NAME]`, `Default Image` become unresolved placeholders; imported statuses
are "source status" only; legacy KLOE codes kept as references; mapping approved by a
governance reviewer; each item classified (shared/ambulance/dental/care home/GP/out of
scope); only approved versions publish. Full export with attachments and stable IDs.

---

## 5. Non-functional requirements

| ID     | Requirement                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------- |
| NFR-01 | 99.9% monthly availability target; RPO ≤ 1 h; RTO ≤ 4 h; documented manual dispatch fallback              |
| NFR-02 | Pilot load 100 staff / 50 vehicles / 10 locations / 500 jobs/day; p95 < 2 s for dashboard and job actions |
| NFR-03 | WCAG 2.2 AA web + app; text/icon with every colour                                                        |
| NFR-04 | All data hosted in UK (Azure UK South primary, UK West backups/DR)                                        |
| NFR-05 | Encryption in transit (TLS 1.2+) and at rest; private file access via short-lived links                   |
| NFR-06 | Tamper-evident audit log of sensitive access, exports, approvals, rule changes, admin                     |
| NFR-07 | Browser support: last 2 versions Chrome/Edge/Safari/Firefox; iOS 16+, Android 10+                         |
| NFR-08 | Running cost kept low: target ≤ ~£200/month Azure for pilot (see cost estimate)                           |

---

## 6. Release phases (mirrors brief §11; detail in BUILD_PLAN.md)

1. Discovery & content validation (docs, prototype, DPIA plan) — mostly done by these docs.
2. Core platform & compliance — org/access, dashboard, staff, fleet/assets, documents,
   audits, actions, alert engine.
3. Dispatch & crew app — bookings, allocation, gates, mobile checks, offline.
4. Sector packs & integrations — dental, care home, advanced reports, approved integrations.
5. Rollout & support — migration, restore/security tests, phased go-live.

Release gate: UAT-01..08 pass; no open critical safety or data-isolation defects.

---

## 7. Open questions (track answers in DECISIONS.md)

Organisations/services in pilot; existing systems to keep (e.g. FleetX); device types
(company vs BYOD); retention schedule per record category; escalation/deputy cover;
integration priorities; whether dental/care-home packs are in year 1.
