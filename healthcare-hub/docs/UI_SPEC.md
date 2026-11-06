# Web UI specification

Source: Concept wireframes 01–06 (fictional data). Brand placeholder "HEALTHCARE HUB".
Desktop-first (1280–1920), usable at 1024; responsive down to tablet. WCAG 2.2 AA.

## Global layout

- Left sidebar nav: Dashboard, Staff, Vehicles and assets, Compliance, Premises safety,
  Work planner, Reports, Settings; organisation name at bottom ("Exora").
- Top bar: breadcrumb `Organisation / Location / Service` (each a switcher), current date,
  **Refresh** button, "Last updated HH:MM | All sources available" (or warning per source).
- Footer label on every screen during pilot: none (wireframe footers are doc-only).

## Status badge component (`<StatusBadge>`)

Always renders **icon + text + colour**, e.g. `● RED – blocked`, `▲ AMBER – due soon`,
`✓ GREEN – approved`, `? GREY – unverified`, `– Not applicable`. Text uses the reasonText.
Check-result variant: `PASS` / `FAIL` / `PENDING` with icons. Never colour-only; contrast ≥ 4.5:1.

## Screens

### 01 Home dashboard (`/`)

Title "Home dashboard", subtitle "An action-led overview for the registered manager and
operations team." Row of 4 KPI tiles (Overdue tasks, Due in 30 days, Blocked vehicles,
Jobs today) — each clickable to a filtered list. **Action required** table (Item, Owner,
Deadline, State) with _View all_ and _Export_. **Module status** card (Staff unverified,
Fleet blocked, Compliance overdue, Premises due today; "Click a module to see the exact
requirements"). **Today in operations** card (jobs awaiting allocation, crew
acknowledgements due; "Critical findings remain visible until verified closed").
Filters drawer: org, location, service, module, owner, date range. Empty, loading
(skeleton) and source-unavailable states.

### 02 Staff profile (`/staff/:id`)

Header: name / staff no (Alex Morgan / ST-0042), role, location, manager, overall readiness
badge (e.g. `AMBER – licence renewal due`). Tabs: Overview, Recruitment, Training,
Supervisions, Appraisals, Documents, History. Overview table: Requirement, Verified (by
role), Next date (label type: "Policy review date" vs "Expiry"), Status. Actions:
Upload renewal evidence, Request review, Book supervision. Info note when viewer is a
dispatcher: "Dispatcher view shows approved roles and restrictions only." Restricted tabs
are hidden **and** server-denied. Staff list (`/staff`): filterable table with readiness.

### 03 Compliance & audit workspace (`/compliance/audits/:id`)

Breadcrumb `Ambulance pack v1 / Safe / Infection prevention / AUD-102`. Header card:
title, owner, due, sample description, source and regulation link, methods. Outcome card
(e.g. `RED – action outstanding`, submitted date, "Closure requires verification").
Findings/controls table: Finding/control, Evidence, Owner, State (AC-07 `4 pass / 1 fail`,
ACT-218 Open, ACT-219 Due 05 Nov). Evidence & decision history timeline. Actions: Upload
evidence, Add observation, Assign action, Submit for review. Reviewer modal: accept/reject
with mandatory reason. Note: "Original audit, findings and source version remain unchanged
after corrective action." Also: requirement library, audit schedule calendar, policies
(with acknowledgement % by version), risk register, events, evidence pack builder.

### 04 Work planner (`/planner`)

Header: date picker, Day/Week view, location. Grid rows "Vehicle / crew" (AMB-01 / Alex +
Sam), columns time slots; cells show job chips (`J-104 allocated`, `J-105 in progress`,
`Break / reserve`, `Available`, `BLOCKED – defect` hatched + text). Right panel:
**Unallocated job** card (J-117: pickup window, journey, mobility, escort, crew needs,
access plan reviewed, required equipment). **Validate assignment** panel: chosen vehicle
and crew, check list with PASS/FAIL/PENDING and reasons, primary button "Allocate and
notify crew" disabled while any non-pending FAIL exists; FAIL rows explain why and offer
"Request exception" only for policy-type checks. Drag-and-drop a job to a row triggers
validation. Keyboard alternative: select job → choose row → validate.

### 06 Workflow views

Not a screen; informs state machines. Allocation flow: Create & assess → Validate →
Dispatch & acknowledge → VDI & cleaning gate → Journey & handover; Fail → Resolve &
reassign (invalid resource stays blocked). Evidence flow: Requirement engine → Evidence &
review → Dashboard & escalation → Correct & verify (history preserved).

### Other screens (same patterns)

Vehicles list/detail (documents, maintenance, VDI history, defects, equipment), Equipment,
Premises register, Events, Reports (each shows definition: denominator, period, inclusion
rule), Settings (org, locations, users/roles, packs, requirement library, notification &
deputies, retention, imports, audit log).

## Interaction rules

- Destructive/approval actions require confirm dialog with reason field where specified.
- Forms: inline zod validation, error summary at top, focus management.
- Tables: sortable, server-paginated, column-visible text statuses, CSV export (audited).
- Times displayed in Europe/London with "BST/GMT" awareness; dates `22 Oct 2026`.
