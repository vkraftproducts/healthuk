# Healthcare Hub workflows

Nov 4, 2026 · Kiran Kadiyala

## How to read this

This document describes every workflow Healthcare Hub must support, for every profile, as it should
work once the fixes are done. It is the brief for the code changes: if a step here cannot be done on
screen, the build is not finished.

It is based on the PRD, the rules engine (status colours and gates), the security and role spec, the
web and mobile UI specs, the 99 findings in the defect register (`docs/DEFECT_REGISTER.md`), and the
November 2026 research on CQC and UK law for independent ambulance services.

Each workflow lists: why it matters; who; before you start; steps; what the system does
automatically; rules; if something goes wrong; records kept; how we will test it; fixes (register
findings and research items this workflow closes).

Three rules apply everywhere and are not repeated in each workflow:

1. Only verified evidence turns anything green. Uploading a file or typing a record makes it
   "awaiting verification". A different person with the right role verifies it.
2. Safety gates cannot be overridden. An expired licence, missing insurance or MOT, or a critical
   defect blocks allocation and shift start. Only policy-type checks can have a time-limited
   exception, approved by a named person with a reason.
3. History is kept. Approvals, decisions, evidence versions, date changes and audit results are never
   edited or deleted; corrections are added as new entries with who and why. Every sensitive action is
   written to the tamper-evident audit log.

All dates and times show in UK time (for example 4 Nov 2026, 14:30). Every status shows text and an
icon as well as a colour. Every confirm or approval step is an in-app dialog with a reason field,
never a browser pop-up.

## Roles

Eleven profiles, plus self-service for every staff member. A person can hold different roles at
different locations. Privileged roles (manager, director, admin, HR, governance, auditor) must use
multi-factor sign-in.

| Profile                                     | What they are for                                                                      | Main jobs in the app                                                                                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered manager                          | The person CQC holds accountable for the location. Sees everything for their locations | Approves staff for roles, signs off audits and actions, owns the registration record, approves policies and exceptions, reviews the dashboard daily                    |
| Director                                    | Board-level oversight; the nominated individual is usually a director                  | Same view as the registered manager; approves organisation-level decisions; is subject to fit and proper checks                                                        |
| Organisation administrator                  | Runs the account, not the care                                                         | Organisation details, locations, services, users and roles, support access, imports, integrations, notification rules. No access to staff files, clinical or HR detail |
| HR and training lead                        | Recruitment and the staff file                                                         | Candidates, Schedule 3 checks, DBS, right to work, references, training matrix, supervision, appraisal, restrictions, leavers, verifying HR evidence                   |
| Fleet lead                                  | Vehicles and equipment                                                                 | Vehicle register and documents, maintenance, equipment and LOLER, defects and return to service, fuel and expenses, verifying licences and vehicle evidence            |
| Premises lead                               | The bases and buildings                                                                | Premises register, fire, water, gas, electrical, oxygen storage, contractors, premises evidence                                                                        |
| Governance lead (IPC, clinical, governance) | Quality and safety                                                                     | Audits and actions, policies, risks, incidents, complaints, safeguarding, duty of candour, CQC notifications, evidence pack, data protection decisions                 |
| Dispatcher (control)                        | Daily operations                                                                       | Bookings, shifts, allocation, dispatch, job progress, exceptions. Sees only approved roles and restrictions of staff, never DBS or health detail                       |
| Crew member                                 | Front-line staff, mainly in the mobile app                                             | Shift readiness, vehicle checks, cleaning, my jobs, defects, expenses, policies to acknowledge, own profile and certificates                                           |
| Auditor (external reviewer)                 | Read-only inspection, for example a mock inspection or commissioner review             | Reads records, evidence, audits, policies, registration, audit log and reports; never changes anything; no sensitive HR detail unless granted                          |
| Platform support (break-glass)              | The software supplier's support staff                                                  | No access by default. Time-limited read-only access, granted by the organisation with a reason, fully logged                                                           |
| Any staff member (self-service)             | Everyone with a staff record                                                           | See own file and status, upload own certificates, ask for corrections, acknowledge policies, report an incident or concern, raise a speak-up concern                   |

Two separation-of-duty rules apply across all profiles: nobody verifies evidence they uploaded, and
nobody approves themselves (for a role, a lifecycle move, a return to service or an exception).

## A. Setup and access

These workflows have to be done before anything else works. A new organisation that skips them would
show no requirements, so everyone would look compliant when nothing has been checked (findings 1, 2,
97).

### A1. Sign in and choose an organisation

Why: CQC and UK GDPR expect access limited to people who need it, every access attributable to a
named person. Privileged roles must use MFA (SEC-01).

Who: every profile. Before you start: invited (A3), Microsoft work account (in development, a test
user exists for every role).

Steps:

1. Sign-in page: "Sign in with your organisation account". In development it lists one test user
   for every profile: Registered manager, Director, Organisation administrator, HR lead, Fleet lead,
   Premises lead, Governance lead, Dispatcher, two Crew members, Auditor, and the dental and care-home
   users.
2. Managers, directors, administrators, HR, governance and auditors must complete MFA; if not, they
   see "Your role needs multi-factor sign-in" and nothing else.
3. One organisation: straight in. More than one: choose from a list showing each organisation and
   their role there. Kept for the session.
4. If the remembered organisation is not one they belong to, silently switch to their first
   organisation and show a short note.
5. Home page: Dashboard for managers and leads, Work planner for dispatchers, My work for crew and
   other staff, the Inspection view for auditors.

System: records sign-in (who, when, organisation) in the audit log; builds the menu from the role, so
pages they cannot use are not listed.

If something goes wrong:

- No account: "No account found for this sign-in. Ask your administrator to invite you." Not "Source
  unavailable".
- Account revoked: "Your access to this organisation has ended."
- Server down: "We cannot reach the server. Try again", with the time of the last successful refresh.

Test: sign in as each of the 13 test users; each sees only their menu items and organisation's data;
revoked user gets the access-ended message; stale organisation falls back without an error.

Fixes: 9, 16, 30, 92, 99.

### A2. Set up the organisation

Why: top bar, reports and evidence pack must name the real provider, location and service. Sector
packs stop a dental practice seeing ambulance screens.

Who: organisation administrator does it; registered manager or director checks registration details.

Steps:

1. Settings, Organisation: edit legal name, trading name, CQC provider ID, address, main contact. Top
   bar updates at once.
2. Locations: add with name, address, CQC location ID, CQC registered (yes/no), type (ambulance base,
   office only, practice, home). Office-only bases do not get clinical requirements by default.
3. Services: add with name (e.g. Patient transport, High-dependency transfers, Event medical cover),
   code and the locations that run it.
4. Regulated activities: tick the activities each location is registered for.
5. Sector packs: switch on Ambulance, Dental or Care home. Each pack decides modules shown, staff
   roles offered, requirement library and dashboard tiles (section M).
6. Archive a location: Archive, reason, confirm in dialog. If it is the last active location, or it
   still has active staff or vehicles, refuse and say why.

System: every change logged with before and after values; changing a sector pack updates menus for
everyone at next page load.

If something goes wrong: duplicate location names refused; a pack cannot be switched off while records
exist that only that pack uses (list them).

Test: rename the organisation and see it in the top bar; switch off Ambulance in a test organisation
and see Vehicles and Work planner disappear; try to archive the only location and get a clear refusal.

Fixes: 17, 74, 78, 87, 95, 98.

### A3. Invite a user, change their role, revoke access

Who: organisation administrator or registered manager.

Steps:

1. Settings, Users and roles, Invite user: email, full name, role, location(s) (or all), optional link
   to an existing staff record. User shows as Invited.
2. Change role or location: open the user, Change access, new role and locations, reason, confirm.
   Applies at their next request.
3. Revoke: reason, confirm. Sessions and mobile tokens end at once; shifts they are on are flagged to
   control.
4. Roles: open any role to see its permissions in plain words (e.g. "Approve a staff member for a
   role").

Rules:

- Platform support is never offered in the invite list; only through A4.
- Nobody can revoke or downgrade their own access.
- The last registered manager cannot be revoked or downgraded until another is in place.
- A user linked to a staff record who becomes a Leaver (B6) loses access automatically.

If something goes wrong: inviting an existing email offers "Change access" instead; invalid emails
flagged at the field.

Test: invite a new HR user and sign in as them; change them to Dispatcher and see the menu change;
try to revoke yourself and be refused; revoke them and see their next request rejected.

Fixes: 8, 75, 87.

### A4. Grant support (break-glass) access

Steps: Settings, Support access, Grant access: engineer's email, reason, hours (1 to 8). Engineer sees
banner "Support access, read-only, ends at 16:30". Every page they open is logged. Ends automatically
or early with End access.

Test: grant 1 hour, sign in as support, confirm read-only, end early, confirm access gone.

### A5. Set up the requirement library

Who: governance lead (or registered manager) adopts, edits and maps; a different authorised person
publishes. Before you start: sector packs on (A2).

Steps:

1. Settings, Requirement library: Library (pack templates) and Ours (adopted). Each row: code, title,
   subject (staff, vehicle, equipment, premises), basis (law, regulatory guidance, professional
   guidance, manufacturer, contract, local policy), regulation reference, recurrence, blocking effect,
   status.
2. Open a library item: legal basis and link, recurrence, warning days, evidence needed, who may
   verify, whether it blocks deployment.
3. Adopt: ambulance items copy to Ours as a draft. Dental and care-home items also ask for the name
   and organisation of the validating specialist; without it adoption is refused.
4. Edit our draft: interval, warning days, evidence type, verifying role, due-soon window. Legal basis
   cannot be removed.
5. Publish: a different authorised person confirms in a dialog. Version becomes Effective; earlier
   versions viewable.
6. Map to roles: for each staff role tick the requirements. E.g. Driver: driving licence, DBS, right
   to work, references and employment history, induction, basic life support, safeguarding, moving
   and handling, emergency response driving. Vehicles, equipment and premises use auto-apply rules
   (every vehicle gets MOT, insurance and tax).
7. On publish or mapping, create the requirement for every person/vehicle/asset/premises item it
   applies to, as grey "awaiting evidence", and tell the owners.

Rules: a role with nothing mapped cannot be approved for anyone (B1); changing a mapping takes effect
for everyone holding the role (HR-03); the CQC framework mapping is a separate, versioned layer.

If something goes wrong: publishing your own draft refused ("Another person must publish this"); a
requirement in use cannot be deleted, only retired with a reason.

Test: adopt and publish the ambulance driver set as two different users; map to Driver; every driver
gains the requirements as grey; adopt a dental item without a specialist and be refused.

Fixes: 2, 5, 29, 74, 94, 96; research must-have 16, should-have 26.

### A6. Notification rules and deputies

Who: registered manager or administrator.

Steps:

1. Settings, Notifications: for each kind of item (staff requirement, vehicle document, equipment
   regime, premises item, action, audit, incident obligation, data protection deadline) set who is
   told: the owner, their lead, the registered manager.
2. Warning days (default 90, 60, 30, 14, 7) and escalation rule (e.g. overdue 1 day to the lead,
   7 days to the registered manager). Defaults labelled "product defaults, not CQC rules".
3. Deputies: for each lead, a deputy and the dates they cover.
4. Channels: in-app always, email optional, mobile push for crew.

Rules: notifications never include patient details. Acknowledging or snoozing never changes a due date
or status (ALERT-03).

Test: licence expiring in 30 days alerts the driver and Fleet lead; a deputy receives alerts during
cover.

Fixes: 74; research should-have 19.

### A7. Import staff and vehicles

Settings, Import and export; Staff or Vehicles; download template; upload CSV; preview every row
(will create, duplicate, error with reason); confirm; Roll back undoes the whole import within 24
hours. Imported records never come in as verified; imported requirements are grey.

### A8. Stage the compliance workbook

Upload each sheet as CSV naming prompt code, text, status and KLOE columns. Every row kept with sheet,
row number, prompt code; placeholders marked unresolved; imported statuses kept as "source status"
only. Governance lead classifies (shared, ambulance, dental, care home, GP, out of scope) and maps to a
requirement or audit control, then approves; only approved rows can be published into the library.

Fixes: 86.

## B. Staff and recruitment

### B1. Recruit a candidate and approve them for a role

Why: Regulation 19 and Schedule 3; right-to-work duty (Immigration, Asylum and Nationality Act 2006);
DBS and barred lists (Police Act 1997, SVGA 2006); C1 for vehicles over 3.5 tonnes.

Who: HR lead creates the candidate and records checks; candidate may upload own documents from My
work; HR lead verifies recruitment evidence; Fleet lead verifies driving licences; registered manager
approves the role (HR lead can approve if they did not verify every item themselves).

Before you start: role requirements published and mapped (A5). If not: "Driver has no requirements
set up. Set them up in Settings, Requirement library first" and approval is impossible.

Steps:

1. Staff, Add staff member: staff number, full name, work email, start date, job title, base
   location, line manager, contract type (employed, bank, agency, volunteer), working pattern,
   proposed role(s). Lifecycle: Candidate.
2. Start checks for role: Overview lists every requirement, grey, legal basis on hover. Lifecycle
   Checks in progress.
3. Recruitment tab, Add record with proper form and file attachment:
   - Identity: document type, number (last 4 shown), expiry, photo match confirmed by, date.
   - Right to work: method (manual document check, digital identity service, Home Office share code),
     date checked, checked by (picked from staff), outcome, permission end date if time-limited (sets
     follow-up reminder), copy of evidence.
   - DBS: level, barred lists checked, certificate number, issue date, Update Service subscribed with
     consent and last status check date, outcome (clear, information disclosed); if disclosed a risk
     assessment and decision by a named manager. Review date is local policy, not an expiry (screen
     says so).
   - References: at least two (referee, relationship, dates covered, received date, verified by phone
     who/when, satisfactory) or an approved alternative with reason and approver.
   - Employment history: every job with dates; gaps over 3 months explained; reason for leaving any
     health or social care job.
   - Qualifications and registration: certificate; HCPC or NMC number, check date, next check date.
   - Health fitness: fit, fit with adjustments, unfit (clinical detail restricted).
   - Driving licence: number, categories ticked (B, C1, D1, C, D), restriction codes, photocard
     expiry, DVLA check date and method, penalty points, emergency response driver qualification and
     expiry.
4. Every record with its file is "awaiting verification" in the right reviewer's queue. Nobody
   verifies a record they entered.
5. Ready for review only when every required item is verified; otherwise refuse and list.
6. Approve for role: checklist (each requirement, who verified, when, expiry); all green; reason;
   dialog. Approval may carry an end date.
7. Active on or after start date; re-check items still verified and in date.

System: refuses approval, Ready for review and Active listing exactly what is missing; refuses
self-approval and approval by someone who verified every item alone; badge grey "Checks incomplete"
or red, never green or N/A while anything is missing; audit log and History tab.

If something goes wrong: DBS disclosure blocks approval until a manager risk decision; time-limited
right to work allowed with reminder, blocked once end date passes; unsatisfactory reference blocks
until a further reference or approved alternative.

Test: approve for Driver with nothing done (refused, listing every item); upload all as HR and verify
as HR (refused); verify as Fleet (licence) and a second HR user, approve as manager (allowed); move an
unapproved person to Active (refused).

Fixes: 2, 46, 47, 48, 53, 83; research must-haves 1 and 2.

### B2. Upload and verify evidence

Verifier set per requirement in the library: HR lead (recruitment, training), Fleet lead (licences,
vehicle documents), Premises lead (premises), Governance lead (audit actions).

Steps:

1. On any requirement row, Upload evidence: file (PDF, image), issue date, expiry or review date, note.
   Several requirements can be ticked if one document covers them.
2. Virus-scanned. Row grey "awaiting verification", or amber "newer evidence awaiting review" if older
   verified evidence still in date.
3. Verifier sees it in Review queue (dashboard and Alerts), oldest first.
4. Evidence panel: preview, download, uploader and when, dates entered, earlier versions and decisions.
5. Verify (confirming or correcting expiry) or Reject (reason required).
6. Verify: green "Verified by Finn Lee, 4 Nov 2026, expires 30 Jun 2027". Reject: back to earlier
   status; uploader sees the reason in alerts.
7. Documents tab on staff profiles (and vehicles, equipment, premises) lists every file with status.

Rules: uploader cannot verify; only clean files; expiry required where the requirement expires;
verified evidence never edited, corrections are new versions.

Fixes: 3, 4, 6, 27, 28, 48, 85; research must-have 3.

### B3. Renew something before it expires

Warning points (90, 60, 30, 14, 7 days by default) alert owner and lead; row amber "due soon, expires
30 Jun 2027". Old verified evidence stays valid until its own expiry. Past expiry with nothing new
verified: red "expired"; deployment-blocking items block allocation and flag future jobs to control.

### B4. Restrict, suspend or lift

HR lead or registered manager. Apply restriction: type (no driving, no blue-light driving, no lone
working, no patient contact, no work with children, no night shifts, other with detail), reason, start,
optional end; dialog. Suspend stops all deployment. Lift with reason. Takes effect on all future
allocations; affected current allocations flagged to control; "no driving" is a hard block for Driver;
dispatchers see a restriction exists, never the reason.

### B5. Change someone's role

Start checks for the new role; extra requirements appear grey; verify; approve; revoke the old role
with a reason if no longer applies.

### B6. Leaver

HR lead. Lifecycle Leaver with reason and last working day; ends sign-in and mobile access, removes
from future shifts (flagged to control), keeps history, starts HR file retention (K4).

### B7. Staff ask for a correction to their own record

My work, My profile, Ask for a correction against a field or record, with proof if needed; HR sees it
in Corrections; approves (new version with reason) or declines with reason; person told either way.

Fixes: 14.

### B8. Change a due date

Owner requests; registered manager or a lead approves in a dialog; old date, new date, reason and
approver kept and shown in History. Statutory expiries (licence, MOT, insurance) cannot be moved;
only local-policy due dates.

Fixes: 14.

### B9. Readiness for a period, request a review, book a supervision

Readiness over a date range shows ready or blocked per role with each check and reason (e.g. "Licence
photocard expires 12 Nov, before the end of the period"). Request review sends the profile to the
registered manager with a note (alert). Book supervision opens C2 with the person filled in. Header:
name, staff number, roles, location, line manager, lifecycle, restrictions, readiness badge with
reason.

Fixes: 14, 15, 50, 51.

### B10. Directors' fit and proper checks

Regulation 5. Compliance, Directors: each director with role; enhanced DBS, insolvency and bankruptcy
search, disqualified directors search, employment history, good character evidence, health
declaration; annual review (alert 30 days before); a different director confirms each year.

Fixes: research should-have 17.

## C. Training, supervision and appraisal

### C1. Training matrix

Staff, Training matrix: rows people (filter location, role, team); columns courses their roles need.
Cells: Verified, valid until 12 Mar 2027 (green); Due soon (amber); Overdue or expired (red); Awaiting
verification (grey); Not required (blank).

Mandatory ambulance items mapped by role: safeguarding adults and children at intercollegiate level;
Oliver McGowan tier 1 or 2; IPC; moving and handling incl. equipment; basic or immediate life support;
information governance and data security; Mental Capacity Act and consent; conflict resolution;
emergency response driving for drivers; equality, diversity and the sexual harassment duty (H5).

Click a cell to see the record. Record training: course from catalogue (no free text codes),
completion date, provider, expiry (calculated from interval if blank), certificate; awaiting
verification until HR verifies. Bulk record after a group session with attendees and register. Export
CSV or include in evidence pack.

System: alerts near expiry; blocks allocation if a deployment-critical course has expired;
recalculates on role change. A course not in the catalogue can be added by HR with interval and basis.

Fixes: 14, 49, 52; research must-have 12.

### C2. Book and record a supervision

Book: person, supervisor, date and time, type (one to one, clinical, return to work, probation
review), topics. Both notified; shows on My work. Record: date held, attendance, summary, wellbeing
check, competence concerns, agreed actions (each an action, G3), next due date. Staff member
acknowledges or comments. Cancelled or missed recorded with reason and rebooked. Interval is local
policy. Overdue amber then red; supervision report (L3).

Fixes: 15, 50.

### C3. Annual appraisal

Schedule; self-assessment; manager records performance, objectives, development needs, training to
book; both sign off; next due date. Missed appraisals reported.

### C4. Competency sign-off

Training tab, Add competency: skill (list), assessor, method, outcome (competent, not yet competent),
date, expiry, evidence. E3 checks that someone on the crew holds each skill the booking needs.

Fixes: research should-have 18.

## D. Vehicles and equipment

### D1. Add a vehicle and its documents

Fleet lead adds; a second fleet user or the registered manager verifies documents.

Add vehicle form groups: Identity (registration, callsign, VIN, make, model, year); Type and build
(emergency ambulance, high-dependency, patient transport, wheelchair-accessible, car; BS EN 1789 type;
conversion company and certificate); Ownership (owned, leased, hired with end date); Use (base,
services); Weight and licence (gross vehicle weight in kg; licence category needed shown, C1 above
3,500 kg); Capacity (seats, wheelchair spaces, stretcher, permitted loads/bariatric limit, blue-light
authorised). Each field shows its own error with a summary at the top. On save the vehicle gets its
library requirements (MOT once 3 years old, insurance, tax, service, conversion certificate, equipment
regimes), grey. Documents tab uploads (B2). Header status with reason: Available, Blocked ("MOT
expired 2 Nov 2026"), Off road, Quarantined.

System: blocks allocation if any statutory document missing or expired across the job window; warns
30 days ahead; checks licence categories against vehicle weight (E3).

Test: add a 4,200 kg ambulance, see "Needs C1"; leave insurance unverified and allocate: "Insurance
not verified".

Fixes: 7, 39, 42, 43, 89; research must-have 10.

### D2. Maintenance by date and mileage

Add maintenance plan: name, interval in months and miles, last done date and odometer. Shows next due
date and mileage and which comes first. Odometer readings from inspections, manual entry or
telematics; lower or implausible readings flagged for correction with a reason. Record service: date,
odometer, garage, work done, job sheet attached, next due recalculated. Vehicles list shows latest
odometer reading and its date. Overdue by date or mileage blocks allocation.

Test: 12-month or 12,000-mile plan; reading past 12,000 turns the vehicle red; allocation fails with
"Maintenance overdue by mileage".

Fixes: 40, 41.

### D3. Equipment and LOLER

Add asset: asset ID, category (stretcher, carry chair, tail-lift, ramp, defibrillator, suction, oxygen
regulator, paediatric kit), make, model, serial, safe working load, location (vehicle or store),
instructions. Separate regimes: LOLER thorough examination (6 months), manufacturer service, pre-use
check (each shift, in the crew inspection), calibration. Upload certificates (B2). Asset detail shows
each regime's status, history, vehicle. Quarantine with reason; release after repair with evidence by
a different person. Vehicle capability comes from non-quarantined, in-date equipment.

Test: quarantine AMB-01's stretcher; allocating a stretcher job to AMB-01 fails with "No in-date
stretcher on this vehicle".

Fixes: 44; research must-have 11.

### D4. Report a defect, repair it, return to service

Report: vehicle or equipment, severity (critical, major, minor with guidance), description, photo,
stop use (critical always), reported by, time. Critical or stop-use blocks immediately, alerts control,
lists future allocated jobs. Fleet lead records the repair in a dialog (work, who, date, parts, job
sheet): Repaired, vehicle stays blocked. Return to service by a different authorised person with repair
record, checks ticked, reason. Defects list columns: vehicle, severity with icon, description, reported
by and when, progress, next action, filters. The repairer cannot release; no release without a repair
record.

Fixes: 36, 37, 38.

### D5. Take a vehicle off the road or move its base

Off road: reason (accident, awaiting parts, sold), expected return date; blocked, future jobs flagged.
Back on road with reason. Move base: new base and effective date; history kept.

Fixes: 7.

### D6. Vehicle inspection checklist

Fleet lead drafts; registered manager publishes. One per vehicle type; items (tyres, lights, brakes,
fluids, restraints, ramp or tail-lift, oxygen, suction, defibrillator, paediatric kit, accessibility
kit, safety kit, consumables, cleanliness); critical items (fail creates a critical defect); publish
as a new version (second person); retire old version. Crews get the latest published version.

Fixes: 7.

### D7. Fuel and expenses

Add expense (vehicle, date, category: fuel, parking, tolls, cleaning, other; amount; litres and
odometer for fuel; receipt photo); duplicate flag (same receipt, amount and date); Fleet lead approves
or rejects with reason; approved items export as CSV for a period.

Fixes: 45.

## E. Planning and dispatch

### E1. Book a journey

Form groups: Booking (customer or commissioner, booking reference never a patient name, contract NHS
/ private / insurer, journey date, pickup window, appointment time); Route (pickup, destination, access
notes, return journey); Patient needs (patient reference restricted, minimal contact number, mobility
walking / wheelchair / own wheelchair / stretcher / bariatric, weight, stairs, escort, infection
precautions, communication needs, oxygen or other equipment, mental health considerations); Crew (crew
size, required skills, gender preference if clinically needed); NHS eligibility (criteria met, who
assessed). Recurring journeys: pattern and end date; each date its own job. "Access plan reviewed"
tick. Saved: Booked; Assessed once needs confirmed, appears in Unallocated jobs.

Rules: patient details never in notifications, logs, links or the grid chip (job code, time, status
only). Errors named at the field; pickup window end before start refused; weight above any vehicle's
permitted load warns.

Fixes: 70; research should-have 21.

### E2. Plan a shift and its crew

Plan: location, vehicle, date, start, end. Add crew: role on shift (driver, attendant, clinician) and
own start and end within the shift. Driver list only people approved for Driver; second crew list
excludes anyone already on the shift. Readiness shown as each is picked. Later: Add crew member, Swap
crew member (reason; new person checked), End assignment early (reason).

Rules: blocked, off-road or quarantined vehicle cannot be planned (dialog says why and when due back);
no overlapping shifts per person; plain errors ("Sam Taylor is already on AMB-02 from 07:00 to 19:00").

Fixes: 13, 67, 68, 69.

### E3. Allocate a job (validate assignment)

Checks with pass, fail or pending and a plain reason: Staff clearance; Driving licence (verified,
photocard in date for the whole job, categories cover vehicle weight, emergency driving qualification
for blue lights); Competence; Vehicle roadworthy (no open critical or stop-use defect; MOT, insurance,
tax verified and valid; maintenance not overdue; not quarantined or off road); Vehicle suitable; Equipment;
Time conflict; Shift gate (Pending, not Fail, before the shift starts). A failing check explains how
to fix it (e.g. "Add a second crew member to this shift" with a button opening E2). Policy-type
failures only: Request exception (approver, reason, expiry; approver approves or declines in a dialog).
Statutory and safety-critical checks never offer an exception. Allocate enabled only when nothing fails
without an approved exception. One transaction; re-run at dispatch and shift start; later changes flag
the job red to control.

Test: unverified licence fails "Driving licence not verified"; 4,200 kg vehicle with category B fails
"Licence does not cover C1 vehicle"; overdue supervision set as policy offers exception; open critical
defect offers no exception.

Fixes: 66, 69, 71; UAT-01, UAT-02.

### E4. Run the job

Offered, Acknowledged, En route, Arrived, Patient on board, At destination, Handover complete,
Completed; each with time and who. Not acknowledged in time or running late: control alerted.

### E5. Exceptions

Cancel (reason, crew told); Refused, No access, Aborted (reason and time; dispatcher decides rebook);
Reassign (E3 runs again; old allocation ended with reason); Swap vehicle mid-shift (new inspection and
cleaning needed). History kept; reassigning never unblocks an invalid resource.

Fixes: 13.

## F. Crew app (and crew on the web)

### F0. My work (web) for crew and other staff

My status (readiness with reasons, each requirement with status and expiry); To do (certificates to
renew, policies to acknowledge, supervisions booked, corrections answered); Report (incident or
concern H1, harassment H5, speak up H6, defect D4, expense D7); My shifts and jobs (read only) and a
link to install the app. No manager pages in their menu; no "Source unavailable" from permissions.

### F1–F7 (mobile)

F1 Start a shift: readiness card blocks with reason. F2 Vehicle inspection and cleaning: odometer,
published checklist items, critical fail creates a critical defect and blocks; submitted inspections
are amended, not edited. F3 My jobs: acknowledge, status buttons, refused / no access / aborted;
push notifications never include patient details. F4 Offline defect or incident reports, deduplicated.
F5 Fuel and expenses. F6 Policies to acknowledge; material change returns to "to read". F7 My profile
and certificates: renewed licence amber "awaiting verification" while old valid, grey if old expired,
never green until a Fleet reviewer verifies.

Fixes: 21, 22, 82.

## G. Audits, actions and policies

### G1. Prepare audit templates

Templates list: code, title, CQC key question, version, status (draft, published, active, retired),
and for sector packs "Draft content, specialist validation required" with proposed cadence. Open a
template: purpose, source and regulation link, controls (question, what good looks like, failure
action, critical), sample method and size, methods, frequency. Edit creates a new draft version; Clone
creates a new template. Publish by a different person in a dialog; dental and care-home need the
validating specialist. Activate; Retire.

Fixes: 18, 58, 94, 97.

### G2. Schedule, carry out and review an audit

Schedule (template, location, service, period, due date, auditor, reviewer; recurring; calendar with
overdue red). Sample (population, selection method, date range, IDs; random pick; warn if same subjects
as last time). Results grid: Pass, Fail, N/A (reason), Not assessed (reason); notes; evidence; save as
you go with progress. Submit when all answered; control results and outcome; critical failure makes
non-compliant. Failures create draft actions. Reviewer Accept (locked) or Return with reason.
Re-audit scheduled automatically after action deadlines with the same template version.

Fixes: 54, 59; research must-have 4.

### G3. Manage an action to closure

Create from any source; owner picked; deadline. Reassign owner or change deadline with reason (history
kept). Owner uploads evidence and marks Ready for verification. A different person Closes (verified)
or Returns with reason. Uploading evidence never closes. List filters and owner names, UK dates.

Fixes: 60; UAT-04.

### G4. Policies

Add policy (title, category, owner, document, review date, reader groups); Draft; Send for review;
Approve by registered manager in dialog; Publish with effective date; readers acknowledge per version;
material change requires re-acknowledgement, minor does not; superseded versions readable; list shows
version, review date, acknowledgement %, outstanding; review date alerts.

Fixes: 55; research must-have 5.

## H. Incidents, complaints, feedback, risks, harassment and speak-up

### H1. Incidents

Report from any staff member (type, date, time, place, what happened, people by reference, immediate
actions, photos; reference number). "Someone is still at risk" alerts the registered manager and
governance lead. Triage within 1 working day (severity, harm, category, owner, protection steps linked).
Restricted safeguarding and HR sections. Reporting obligations suggested and decided (CQC notification
Reg 16/18 with draft text; safeguarding referral; RIDDOR; ICO 72 hours opening K1; insurer, commissioner,
LFPSE), each with deadline, decision, reference. Duty of candour decided by the registered manager with
guided steps. Investigate (PSIRF learning response, contributory factors, actions). Close only when
every obligation decided, candour complete if applicable, actions verified.

Fixes: 12, 56, 90; research must-have 6, should-have 20.

### H2. Complaints

Log (how received, date, complainant restricted, about which job/staff/service, summary, desired
outcome, consent). Acknowledge within target (clock); investigate; respond within target (default 20
working days) with escalation rights; outcome; close; reopen.

Fixes: 56, 63; research must-have 7.

### H3. Feedback and compliments

Types, source, date, rating, themes; themes by period; actions from negative themes; counts labelled
"what people raised, not a measure of quality on its own".

Fixes: research should-have 23.

### H4. Risk register

Add risk (title, hazard, people affected, category, inherent and residual likelihood and impact,
controls, owner, review date, links). Sorted by residual score with band text. Reviews kept as history.
Actions from risk. Close or archive with reason.

Fixes: 57; research must-have 8.

### H5. Prevent sexual harassment

Harassment risk assessment in the risk register; policy published and acknowledged; training assigned
to every role; harassment reports through H1 restricted to HR and the registered manager; yearly review
and after each report.

Test: a harassment report is not visible to the dispatcher or other crew.

Fixes: research must-have 15.

### H6. Speak up

Named or anonymous; named guardian (set in settings) acknowledges (anonymous reporters check progress
with a code), investigates, records outcome and feedback; quarterly themes summary to governance
meeting without identifying anyone.

Fixes: research should-have 22.

## I. CQC registration, governance and inspection readiness

### I1. Registration record

Provider (name, CQC provider ID, nominated individual); each location (CQC location ID, address,
registered manager with start date, regulated activities, conditions); statement of purpose versions;
insurance and business continuity plan with dates. Edits saved with effective date and reason, history
kept. Changes needing a CQC notification create an obligation with deadline and draft. Correspondence
log with response deadlines on the dashboard.

Fixes: 61; research must-have 13.

### I2. Display the rating

Record report date and ratings; 21-day task per location and website; upload poster photo and web
link as evidence (B2).

### I3. Governance meeting

Schedule; meeting pack from live data; attendance, discussion, decisions (actions); minutes approved
at next meeting then locked.

Fixes: research should-have 25.

### I4. Evidence pack

Choose location, service, framework version, key questions or regulations, period. Built in background.
Indexed PDF plus ZIP: only verified evidence, gaps listed honestly. Download logged.

Fixes: 62; research must-have 14, should-have 26.

### I5. NHS contract items

DSPT (submission date, status, evidence; IG training against 95%); PSIRF and LFPSE on NHS incidents;
eligibility on bookings; contract KPI report (punctuality, time on vehicle, aborted and cancelled).

Fixes: research should-haves 20, 21.

## J. Premises safety

### J1. Premises register

Add premises item (location, area, item, responsible person and action owner picked from staff,
contractor). Applicability (applies, or not applicable with reason, reviewer, review date). Schedule:
link a published requirement (only published offered) or enter interval and its source. Record
assessment date and reference; next due calculated. Upload certificate (B2); verified turns green.
Findings become actions. Edit later with history. Missed oxygen storage check at an ambulance base is
deployment-critical.

Fixes: 24, 64, 65.

## K. Data protection

K1 Breach: record (title, what, when happened, when discovered, who); 72-hour clock (amber 48, red 72);
contain; assess; ICO decision with reason and reference; people affected; actions; close with lessons;
form clears after save. K2 Subject requests: log, verify identity (clock pauses), extend, gather,
respond, close. K3 Data protection complaints: acknowledge within 30 days, investigate, outcome, ICO
case. K4 Retention and legal holds: rules approved with reason; monthly review batches; holds with
scope; retention action log. K5 Disclosures log: what, about whom, to whom, lawful basis, requested by,
approved by, date, how sent; searchable.

Fixes: 11, 76, 77; research must-have 9.

## L. Oversight

### L1. Dashboard

Four tiles (Overdue tasks, Due in 30 days, Blocked vehicles, Jobs today) with number, status text and
icon, opening their exact list; number equals rows. Action required list (item link, owner name,
deadline, state with reason; View all, Export logged). Module status; clicking a module filters only
the list with a chip; tiles and module status always whole-organisation; Clear filter always works.
Today in operations (critical findings include open critical defects). Filters: organisation, location,
service, module, owner, date range as chips. Evidence coverage labelled "Internal measure, not a CQC
rating". Footer last refreshed and failed sources. Nothing set up shows grey "Not set up", never
"Green, none". Each lead sees their own area's tiles; crew get My work.

Fixes: 23, 31, 32, 33, 34, 35, 88, 97; UAT-08.

### L2. Alerts

Bell count; Alerts list (due soon, overdue, awaiting my review, assigned to me, escalated as deputy or
manager); open goes to the record; Acknowledge or Snooze with reason (status unchanged); escalation by
A6 rules and to deputies. Date-only deadlines judged in UK time to end of day.

Fixes: 10.

### L3. Reports

Only reports the role can use are listed; each figure says what it counts; tables agree with headlines;
Export CSV logged, or say why the role cannot export; monthly management pack PDF. Readiness never
100% with nothing required: "No requirements set up".

Fixes: 1, 26, 72, 73, 84.

### L4. Audit log

When (UK), who (name and role), what in plain words, which record (link), reason; filters; export
logged; Verify audit chain with result and time.

Fixes: 25, 79, 93.

### L5. Inspection (auditor view)

Auditor invited for a set period; Inspection view by key question; no edit controls; DBS and health
detail hidden unless granted; every view logged.

Fixes: 25, 91.

## M. Dental practice and care home differences

| Area                     | Dental practice                                                                                                       | Care home                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modules shown            | Staff, Compliance, Premises, Reports, Settings. No Vehicles, Work planner or crew app                                 | Staff, Compliance, Premises, Reports, Settings. No Vehicles or Work planner (unless the home runs its own transport)                                               |
| Roles                    | Dentist, dental nurse, dental hygienist or therapist, receptionist, practice manager                                  | Registered manager, deputy manager, senior care assistant, care assistant, activities coordinator, cook and domestic staff                                         |
| Staff requirements       | GDC registration, indemnity, hepatitis B immunity, radiation protection training, CPD, DBS, right to work, references | DBS with adult barred list, right to work, references, Care Certificate, moving and handling, medicines competency, safeguarding, Oliver McGowan training          |
| Audits                   | Decontamination and IPC, radiation protection, medical emergencies, clinical records, sharps and waste, complaints    | Medicines, care plans and risk assessments, falls and incidents, nutrition and hydration, IPC, safeguarding and DoLS, fire and environment, dignity and experience |
| Premises                 | Decontamination room, X-ray equipment, compressed air, waste                                                          | Fire evacuation plans per resident, water safety, bed rails, lifting equipment (LOLER)                                                                             |
| Events and notifications | CQC notifications, IR(ME)R radiation incidents, RIDDOR                                                                | CQC notifications incl. deaths, DoLS outcomes, safeguarding                                                                                                        |
| Dashboard tiles          | Overdue tasks, Due in 30 days, Staff unverified, Audits overdue                                                       | Overdue tasks, Due in 30 days, Staff unverified, Audits overdue                                                                                                    |

Out of scope for these sectors: dental charting, care planning, eMAR.

Fixes: 29, 94, 95, 96, 98.

## Role by workflow matrix

Key: Do = starts or carries out. Approve = approves, verifies or signs off. View = can see. Own = only
own records. Blank = no access. Manager = registered manager and director.

| Workflow                               | Manager           | Admin | HR             | Fleet             | Premises        | Governance        | Dispatcher        | Crew and staff | Auditor        |
| -------------------------------------- | ----------------- | ----- | -------------- | ----------------- | --------------- | ----------------- | ----------------- | -------------- | -------------- |
| A2 Organisation setup                  | Approve           | Do    |                |                   |                 |                   |                   |                | View           |
| A3 Users and roles                     | Do                | Do    |                |                   |                 |                   |                   |                | View           |
| A4 Support access                      | Do                | Do    |                |                   |                 |                   |                   |                | View           |
| A5 Requirement library                 | Approve           |       | View           | View              | View            | Do                |                   |                | View           |
| A6 Notification rules                  | Do                | Do    |                |                   |                 |                   |                   |                |                |
| A7 Imports                             | View              | Do    | Do             | Do                |                 |                   |                   |                |                |
| A8 Workbook staging                    | View              | Do    |                |                   |                 | Approve           |                   |                | View           |
| B1 Recruit and approve                 | Approve           |       | Do             | Approve (licence) |                 |                   | View (roles only) | Own (upload)   | View           |
| B2 Evidence review                     | Approve           |       | Approve        | Approve           | Approve         | Approve           |                   | Own (upload)   | View           |
| B3 Renewals                            | View              |       | Do             | Do                | Do              | Do                |                   | Own            | View           |
| B4 Restrictions                        | Do                |       | Do             |                   |                 |                   | View (no reason)  |                | View           |
| B5 Role change                         | Approve           |       | Do             |                   |                 |                   |                   |                | View           |
| B6 Leaver                              | Do                |       | Do             |                   |                 |                   |                   |                | View           |
| B7 Correction requests                 | View              |       | Approve        |                   |                 |                   |                   | Do (own)       |                |
| B8 Due-date change                     | Approve           |       | Do             | Do                | Do              | Do                |                   |                | View           |
| B9 Readiness and review                | Do                |       | Do             |                   |                 |                   | View              | Own            | View           |
| B10 Directors fit and proper           | Do                |       |                |                   |                 |                   |                   |                | View           |
| C1 Training matrix                     | View              |       | Do             |                   |                 | View              |                   | Own            | View           |
| C2 and C3 Supervision, appraisal       | Do                |       | Do             |                   |                 |                   |                   | Own            | View           |
| C4 Competencies                        | Approve           |       | Do             |                   |                 | Do                |                   | Own            | View           |
| D1 Vehicles and documents              | View              |       |                | Do                |                 |                   | View              |                | View           |
| D2 Maintenance                         | View              |       |                | Do                |                 |                   | View              |                | View           |
| D3 Equipment and LOLER                 | View              |       |                | Do                |                 |                   | View              |                | View           |
| D4 Defects and release                 | Approve           |       |                | Do and Approve    |                 |                   | View              | Do (report)    | View           |
| D5 Off road, move base                 | View              |       |                | Do                |                 |                   | View              |                | View           |
| D6 Inspection checklist                | Approve           |       |                | Do                |                 |                   |                   | Do (use)       | View           |
| D7 Fuel and expenses                   | View              |       |                | Approve           |                 |                   |                   | Do             | View           |
| E1 to E5 Planning and dispatch         | View              |       |                | View              |                 |                   | Do                | Own jobs       | View           |
| E3 Policy exception                    | Approve           |       |                |                   |                 |                   | Do (request)      |                | View           |
| F1 to F7 Crew app                      |                   |       |                |                   |                 |                   | View              | Do             |                |
| G1 Audit templates                     | Approve           |       |                |                   |                 | Do                |                   |                | View           |
| G2 Audits                              | Approve           |       |                |                   |                 | Do                |                   |                | View           |
| G3 Actions                             | Approve           |       | Do (own)       | Do (own)          | Do (own)        | Do                |                   | Do (own)       | View           |
| G4 Policies                            | Approve           |       | View           | View              | View            | Do                | Own (read)        | Own (read)     | View           |
| H1 Incidents                           | Approve (candour) |       | Do (report)    | Do (report)       | Do (report)     | Do                | Do (report)       | Do (report)    | View           |
| H2 Complaints                          | Approve           |       |                |                   |                 | Do                | Do (log)          | Do (log)       | View           |
| H3 Feedback                            | Do                |       | Do             | Do                | Do              | Do                |                   |                | View           |
| H4 Risks                               | Approve           |       | Do (own)       | Do (own)          | Do (own)        | Do                |                   |                | View           |
| H5 Harassment prevention               | Do                |       | Do             |                   |                 |                   |                   | Do (report)    | View           |
| H6 Speak up                            | Do (guardian)     |       |                |                   |                 |                   |                   | Do (raise)     |                |
| I1 and I2 Registration, rating display | Do                | View  |                |                   |                 | View              |                   |                | View           |
| I3 Governance meetings                 | Do                |       |                |                   |                 | Do                |                   |                | View           |
| I4 Evidence pack                       | Do                |       |                |                   |                 | Do                |                   |                | View           |
| I5 NHS contract items                  | Do                |       |                |                   |                 | Do                | View (KPIs)       |                | View           |
| J1 Premises                            | Approve           |       |                |                   | Do              | View              |                   |                | View           |
| K1 to K5 Data protection               | Approve           |       |                |                   |                 | Do                |                   | Do (report)    | View           |
| L1 Dashboard                           | View (all)        |       | View (staff)   | View (fleet)      | View (premises) | View (compliance) | View (operations) | My work        | View           |
| L2 Alerts                              | Do                | Do    | Do             | Do                | Do              | Do                | Do                | Do             |                |
| L3 Reports                             | Do (all)          |       | Do (workforce) | Do (fleet)        | Do (premises)   | Do (governance)   | Do (operations)   |                | View           |
| L4 Audit log                           | View              | View  |                |                   |                 | View              |                   |                | View           |
| L5 Inspection                          | Do                |       |                |                   |                 | Do                |                   |                | Do (read only) |

The development sign-in list includes one test user for every column, including Director, Premises
lead and the dental and care-home users, so every row can be tested.
