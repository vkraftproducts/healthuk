# Registered manager: test scenarios

Every workflow a **Registered manager** can carry out in Healthcare Hub, grouped by the left-hand menu.
Each row is one test: do the steps, then check the expected result. Synthetic data only.

## Before you start

| Item | Value |
| --- | --- |
| App | http://localhost:5173 (local) or the Coolify web URL |
| Manager sign-in | `manager@example.test` / `Hub-Dev-Password-2026!` |
| Organisation | Exora International Ltd / London / Ambulance service |
| Reset data | `docker compose down -v`, then `pnpm db:bootstrap`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:seed:sectors` |
| Optional demo data | `pnpm demo:crew` (shifts, jobs, staff, vehicles, risks, events for today) |

Many steps need **a second person** (the hub never lets someone approve their own work). Use another
browser profile or a private window with one of these (same password):

| Login | Role | Use it to |
| --- | --- | --- |
| `director@example.test` | Director | Approve the manager's policies, verify the manager's evidence and actions |
| `governance@example.test` | IPC / governance lead | Verify actions, review notifications, approve minutes, publish templates |
| `hr@example.test` | HR and training lead | Verify staff evidence, decide staff requests |
| `fleet@example.test` | Fleet lead | Release defects and quarantined vehicles the manager repaired or quarantined |
| `dispatcher@example.test` | Dispatcher | Ask for allocation exceptions for the manager to decide |
| `crew@example.test` | Crew member | Report incidents, raise speak-up concerns |
| `other.manager@example.test` | Manager in "Other organisation" | Check that Exora data never shows up |

Seeded records used below: staff Alex Morgan (ST-0042), Sam Taylor, Jordan, Lee; vehicles AMB-01, AMB-02,
AMB-03 (AMB-03 blocked by a critical ramp defect); audit AUD-102 with actions ACT-218 and ACT-219, re-audit
AUD-103; active audit template AC-07. The planner has no shifts or jobs until you plan them (or run
`pnpm demo:crew`).

**Menu the manager should see (in order):** Dashboard, Inspection, Report an incident, Alerts, Staff,
Vehicles and assets, Compliance, Premises safety, Work planner, Reports, Speak up, Settings.
"My record" must **not** appear.

Result column: write Pass / Fail and a note. Status badges always show an icon, a colour word and a reason
(for example "Red – select to list"); colour is never the only signal.

---

## 1. Sign-in, header and sidebar (RM-GEN)

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-GEN-01 | Sign in | Open the app, enter the manager email and password, Sign in | Lands on "Home dashboard"; sidebar shows the 12 items above; user block shows "Dev Manager / Registered manager" |
| RM-GEN-02 | Wrong password | Sign in with a wrong password | Sign-in refused with an error; no access |
| RM-GEN-03 | Show password | Tick "Show password" | Password text becomes visible; untick hides it |
| RM-GEN-04 | My record hidden | Look at the sidebar; type `/me` in the address bar | Not in the menu; page says "Your role does not give access to this page." with "Go to your home page" |
| RM-GEN-05 | Breadcrumb | Open each menu item | Header reads "Exora International Ltd / London / Ambulance service / <page>" (no page name on the Dashboard) |
| RM-GEN-06 | Breadcrumb back | Open Staff, then a staff profile, then click the breadcrumb | Goes back one page; when the page was opened directly (pasted URL), goes to the Dashboard |
| RM-GEN-07 | Alerts link | Check the header "Alerts N (M critical)", click it | Opens Alerts; N = open, not snoozed alerts; "(M critical)" only when M > 0 |
| RM-GEN-08 | Refresh | Click "Refresh" | "Last updated HH:MM" changes; page figures are not reloaded by this button |
| RM-GEN-09 | Live status | Watch the header; make a change in a second window (for example report an incident as crew) | Shows "Live" with a green dot; lists and figures update without reloading |
| RM-GEN-10 | Server down | Stop the API while signed in | Within 60 s badge shows "Red – source unavailable" and "Reconnecting… figures may be out of date"; recovers when the API is back |
| RM-GEN-11 | Org switcher | Open the "Organisation" dropdown | Only "Exora International Ltd" is listed |
| RM-GEN-12 | Skip link | Press Tab once on any page, then Enter | "Skip to main content" appears and moves focus to the page body |
| RM-GEN-13 | Sign out | Click "Sign out" | Shows "You have signed out."; going back does not show data |
| RM-GEN-14 | Branding | Look at sign-in page and sidebar | Pulse Cross logo, "Healthcare Hub", "by VKRAFT" badge; tab title "Healthcare Hub by Vkraft" |
| RM-GEN-15 | Isolation | Sign in as `other.manager@example.test`; try an Exora staff or vehicle URL copied from the manager's session | "Not found, or you do not have access." / "This staff record is not available."; no Exora data anywhere |

## 2. Dashboard (RM-DASH) – `/`

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-DASH-01 | Page loads | Open Dashboard | "Home dashboard", subtext mentions "(Registered manager)"; tiles, Action required, Module status, Today in operations, Evidence coverage; footer "Internal measures on this dashboard are not CQC ratings." |
| RM-DASH-02 | Tiles shown | Look at the tiles | Ambulance tiles: "Overdue tasks", "Due in 30 days", "Blocked vehicles", "Jobs today". No "Staff unverified" or "Audits overdue" tiles |
| RM-DASH-03 | Tile = list | Click "Overdue tasks" | Action list shows only overdue rows; the number of rows equals the tile figure; badge says "showing below"; title "Action required – Overdue tasks" |
| RM-DASH-04 | Tile toggle off | Click the same tile again | List goes back to all rows |
| RM-DASH-05 | Each tile | Repeat RM-DASH-03 for every tile | Count always equals rows; a tile with 0 shows "Green – none" |
| RM-DASH-06 | Blocked vehicles | Click "Blocked vehicles" | AMB-03 listed ("Critical defect open – remains until repaired and released"); link opens the vehicle page |
| RM-DASH-07 | Location filter | Choose Location = London | Figures and list update at once (no submit button) |
| RM-DASH-08 | Service filter | Choose a service | Figures and list update |
| RM-DASH-09 | Owner = Me | Choose Owner = Me | Only the manager's rows; owner shows "<name> (you)"; vehicle, defect and job rows hidden |
| RM-DASH-10 | Owner = someone else | Choose another person | Only their rows |
| RM-DASH-11 | Date range | Set Deadline from / to around a known deadline | Rows outside the range drop off; rows with no deadline (blocked vehicles, defects) and critical findings stay |
| RM-DASH-12 | Bad date range | Set "Deadline to" before "Deadline from" | Message "The end date is before the start date, so the date range is not applied."; list unchanged |
| RM-DASH-13 | Clear filters | Set filters, click "Clear filters" | All filters reset; link disappears |
| RM-DASH-14 | Module filter | Click "Fleet" in Module status | Chip "Filter: Fleet"; Action required shows Fleet only; other modules still shown in the panel |
| RM-DASH-15 | Clear module filter | Click "Clear filter" (or the module again) | All modules listed again |
| RM-DASH-16 | Order | Look at the list | Red first, then Amber, then Grey; earliest deadline first within each |
| RM-DASH-17 | More than 8 rows | When there are more than 8 rows, click "View all (N)", then "Show fewer" | Expands to all; collapses to "Showing the 8 most urgent of N." |
| RM-DASH-18 | Export | Click "Export" | `action-required.csv` downloads (Module, Item, Owner, Owner id, Deadline, State, Reason); message "Export downloaded (logged)."; entry in Settings > Audit log |
| RM-DASH-19 | Drill-downs | Click one row of each kind | Staff → staff profile; vehicle/defect → vehicle page; audit → audit run; action → Compliance Actions; policy → Policies; correspondence → Registration; event duty → Events; job → Work planner; premises → Premises |
| RM-DASH-20 | Today in operations | Read the panel | "Jobs awaiting allocation", "Crew acknowledgements due", "Critical findings open", note "Critical findings remain visible until verified closed." |
| RM-DASH-21 | Evidence coverage | Read the panel | "X% (n verified and current of d applicable; …)" or "No applicable requirements."; "Internal measure — not a CQC rating" |
| RM-DASH-22 | Live update | In a second window, verify some evidence or release a defect | Tiles and list change without reload |
| RM-DASH-23 | Source failure | Stop the API and reload | "Source unavailable. The dashboard could not be loaded. Figures are not shown rather than shown out of date." |

## 3. Inspection (RM-INSP) – `/inspection`

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-INSP-01 | Page loads | Open Inspection | "Inspection view", "Read-only. Your viewing is recorded in the audit log…"; no buttons |
| RM-INSP-02 | CQC rating box | Read "Rating published by CQC" | Shows the recorded rating with location and date, or "No CQC rating recorded." Never a calculated rating |
| RM-INSP-03 | Coverage | Read the coverage line | "Evidence coverage: X% (n of d) – Internal measure — not a CQC rating" |
| RM-INSP-04 | Key questions | Scroll | Sections Safe, Effective, Caring, Responsive, Well-led, each with summary, "Open actions from audits: N", gaps, audits table |
| RM-INSP-05 | No personal details | Read the gaps lists | Staff gaps show "Staff record (details hidden): Not verified"; no names, DBS or health details |
| RM-INSP-06 | Audit results | Read an audits table | Result badges Compliant / Partly compliant / Non-compliant or "Not yet reviewed"; at most 20 |
| RM-INSP-07 | Policies | Read Well-led | Policies listed as "CODE Title (version N)" or "(not published)" |
| RM-INSP-08 | View is logged | Open Settings > Audit log, Area = Compliance | An "inspection view" entry for each visit |
| RM-INSP-09 | After a change | Record a CQC rating (RM-COMP-REG-06), reopen Inspection | New rating shown exactly as entered |

## 4. Report an incident (RM-REP) – `/report`

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-REP-01 | Types list | Open "What are you reporting?" | Incident, Near miss, Accident or injury, Safeguarding concern, Harassment or sexual harassment, Complaint (no dental or care-home types) |
| RM-REP-02 | Minimum report | Fill Short title (3+ chars) and What happened (10+ chars), Send report | "Report sent."; green receipt "Your reference number is EVT-…", "…will be triaged by the end of the next working day", "Triage is due by <date time>"; form clears |
| RM-REP-03 | Full report | Fill every field (time, place, references "J-1234, BK-5678", done straight away), send | Receipt shown; report appears under "Reports you have made" with "Amber – Waiting for triage" |
| RM-REP-04 | Still at risk | Tick "Someone is still at risk now…", send | Receipt says the registered manager and governance lead have been told; header shows a critical alert; Alerts lists "EVT-…: someone is still at risk…" as Critical |
| RM-REP-05 | Complaint fields | Choose Complaint | "Date received" (today), "How it was received" (Phone/Email/Letter/In person/Web/Other), consent checkbox appear; switching type hides them |
| RM-REP-06 | Complaint report | Send a complaint | Receipt; the event later shows acknowledge-by and respond-by dates |
| RM-REP-07 | Each type | Send one report of every type | All accepted; each shows in Compliance > Events with the right type |
| RM-REP-08 | NHS-funded | Tick "This was NHS-funded care", send | Accepted; the event needs a PSIRF learning response before closing (RM-EVT-14) |
| RM-REP-09 | Title too short | Title "ab" | Browser blocks submit |
| RM-REP-10 | Whitespace title | Title of spaces only | Server rejects with a field error |
| RM-REP-11 | Description too short | What happened "short" | Blocked (10 characters minimum) |
| RM-REP-12 | Future time | Set "When did it happen?" to tomorrow | "The captured time is in the future" |
| RM-REP-13 | Name in references | References "John Smith" | Rejected: "Use a job or booking reference (for example J-1234), never a name" (field label may show "0" – known issue) |
| RM-REP-14 | Too many references | Enter 21 references | Rejected (20 maximum) |
| RM-REP-15 | Blank time | Leave the time empty | Saved with the time of sending |
| RM-REP-16 | Double click | Click "Send report" twice quickly | Only one EVT reference created |
| RM-REP-17 | My reports | Look at "Reports you have made" | Reference, Title, Reported, Progress; becomes "Green – Triaged – <status>" after triage (RM-EVT-05) |

## 5. Alerts (RM-ALR) – `/alerts`

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-ALR-01 | Page loads | Open Alerts | "Your alerts" table (Status, What, Area, Why you see it, Raised, Due, Actions) and "Who is told about what" |
| RM-ALR-02 | Order | Look at the list | Most serious first (Critical, High, Medium, Low), then oldest |
| RM-ALR-03 | Show filter | Try each "Show" option (Compliance items due or expiring, Overdue actions, Overdue audits, New incidents and events, Data protection breaches, Published policies, Vehicles, jobs and retention) | List narrows to that area each time |
| RM-ALR-04 | Only mine | Tick "Only things I own or was told about" | Rows marked "Your role covers this area" disappear |
| RM-ALR-05 | Open | Click "Open" on each kind of alert | Goes to the record (staff, audit, event, policy, action list, planner, vehicles, settings) |
| RM-ALR-06 | Acknowledge | Click "Acknowledge", confirm | Row leaves the list; header count drops; audit log entry |
| RM-ALR-07 | Include acknowledged | Tick "Include acknowledged alerts" | The acknowledged alert shows with "(acknowledged)" |
| RM-ALR-08 | Snooze | Click "Snooze", choose 7 days, reason "Waiting for garage", confirm | Status shows "(reminders paused until <date>: Waiting for garage)"; leaves the header count; stays in the list |
| RM-ALR-09 | Snooze reason too short | Reason "ok" | "Snooze reminders" stays disabled |
| RM-ALR-10 | Snooze options | Open the "Pause reminders for" list | 1, 3, 7, 14, 30 days |
| RM-ALR-11 | Derived alerts | Find an overdue action or new event row | Only "Open" (no Acknowledge or Snooze) |
| RM-ALR-12 | Already resolved | Open Acknowledge in two tabs; resolve the item in one; confirm in the other | "The alert is already resolved" shown in the dialog |
| RM-ALR-13 | Cancel / Escape | Open a dialog, press Escape | Dialog closes, nothing changes |
| RM-ALR-14 | Who is told | Read the bottom section | One line per rule, for example "<Area>: told to <roles>, in the hub only"; note about Settings, Notifications |

## 6. Staff (RM-STF) – `/staff`

### 6.1 Register and requests

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-STF-01 | Register loads | Open Staff | Tabs Register, Training matrix, Group training, Supervision bookings; "Staff register" with Staff no, Name, Approved roles, Lifecycle, Restrictions, Compliance |
| RM-STF-02 | Search | Search "Alex", then "ST-0042" | Alex Morgan found both ways |
| RM-STF-03 | Lifecycle filter | Try each Lifecycle option, including Leaver | List filters; "Current staff" hides leavers |
| RM-STF-04 | Role filter | Choose an approved role | Only staff approved for it |
| RM-STF-05 | No match | Search "zzzz" | "No staff match these filters." |
| RM-STF-06 | Add staff (candidate) | Add: ST-0900, name, base London, Role to check for = Decide later, Add | "Staff record created as a candidate."; shows in the register as Candidate |
| RM-STF-07 | Add with role | Add ST-0901 with a role chosen | "Staff record created; checks started for <Role>."; lifecycle "Checks in progress" |
| RM-STF-08 | Duplicate number | Add ST-0042 again | "That staff number is already in use." |
| RM-STF-09 | Bad number | Staff number "12345" | "Check the details: the staff number looks like ST-0042." |
| RM-STF-10 | Lower case | Staff number "st-0902" | Saved as ST-0902 |
| RM-STF-11 | Staff requests | As crew, ask for a date change / review / supervision in the crew app or My record; as manager open "Staff requests waiting for a decision" | Request listed with Who, Request, Details, Reason |
| RM-STF-12 | Accept request | Accept, optional note | Request closes; for a date change "The new date is applied now and recorded in the due-date log with you as approver." |
| RM-STF-13 | Accept supervision | Accept a supervision request | "Booked for" date-time required before confirming |
| RM-STF-14 | Decline request | Decline with reason | Request closes; reason sent to the staff member |
| RM-STF-15 | Correction requests | As crew, request a correction; as manager mark "Applied", and reject another with a note | Each leaves the queue; reject requires a note |

### 6.2 Staff profile – `/staff/<id>`

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-STF-20 | Profile loads | Open Alex Morgan | Breadcrumb "Staff / ST-0042"; Roles, Lifecycle, Restrictions, Job title, Location, Line manager, Start date, Contract, Readiness badge; tabs Overview, Recruitment, Training, Supervisions, Appraisals, Documents, History |
| RM-STF-21 | Requirements table | Overview tab | Each requirement with Verified, Next date, Status, actions Documents / Upload evidence / Request review |
| RM-STF-22 | Upload evidence | Upload a PDF with an expiry date for a requirement | "Awaiting verification"; requirement does not turn green |
| RM-STF-23 | Can't verify own upload | Open Documents on that requirement | "You uploaded this: another person must verify it" |
| RM-STF-24 | Second person verifies | As HR, verify it with the confirmed expiry date | Requirement turns green (or amber if due soon) for the manager |
| RM-STF-25 | Reject evidence | As manager, reject evidence uploaded by someone else, with a reason | State "Rejected" with reason; requirement stays not met |
| RM-STF-26 | Request review | "Request review" with a reason | Request appears in "Review and supervision requests" as "Waiting for a decision"; second request on the same item refused |
| RM-STF-27 | Start role checks | "Checks for a role", pick a role, "Start checks for <Role>" | "Checks started. Each item is awaiting evidence."; "x of n checks still need verified evidence." |
| RM-STF-28 | Role with no requirements | Pick a role with nothing mapped | "<Role> has no requirements set up, so nothing can be checked and nobody can be approved for it…" |
| RM-STF-29 | Approve blocked | Try "Approve for <Role>" before checks are verified | Button disabled, tooltip "Every check must be verified first" |
| RM-STF-30 | Approve for role | After all checks are verified by others, Approve with a reason | Role appears on the profile; patient-facing roles also need a complete Schedule 3 file |
| RM-STF-31 | Approve – four eyes | Verify every check yourself (as manager), then try to approve | "You verified every check for this role yourself. A different person must approve it." |
| RM-STF-32 | Approve – Schedule 3 incomplete | Patient-facing role with missing Schedule 3 items | "…the Schedule 3 staff file is incomplete (n items)." with the list |
| RM-STF-33 | Lifecycle moves | "Change lifecycle" through Candidate → Checks in progress → Ready for review → Approved for role → Active | Only allowed moves offered; each needs a reason; blocked moves give "Approve the person for at least one role first" / "n required check(s) … not verified yet." |
| RM-STF-34 | Suspend and reactivate | Active → Suspended → Active | Badge changes; future shifts flagged on suspend |
| RM-STF-35 | Suspended can't be approved | Try approving a suspended person | "This person is suspended and cannot be approved for a role." |
| RM-STF-36 | Leaver | Move a test person to Leaver | Warning "A leaver loses access to the app immediately."; all edit controls hidden afterwards; no lifecycle moves left |
| RM-STF-37 | Apply restriction | "Apply restriction or suspend": No driving, end date, reason | In force in History; planner refuses driving allocation for this person |
| RM-STF-38 | Lift restriction | History > Restrictions > Lift with reason | "Lifted – <reason>"; second lift gives "Already lifted" |
| RM-STF-39 | Book supervision (request) | "Book supervision": date, supervisor, reason | Request joins the staff requests queue; manager cannot confirm a booking they asked for |
| RM-STF-40 | History tab | Open History | Lifecycle history, Role approvals, Restrictions, Driving licence records |

### 6.3 Record sections (Recruitment, Training, Supervisions, Appraisals, Documents tabs)

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-STF-50 | Reference | Add record: referee, organisation, relationship, requested date, outcome Pending, Save | "Saved." and listed as Current |
| RM-STF-51 | Satisfactory reference without date | Outcome Satisfactory, no received date | "A satisfactory reference needs the date it was received" |
| RM-STF-52 | Employment gap | Two jobs with a 4-month gap, no explanation | "There is a gap of more than 3 months before this job (…). Explain the gap in writing." |
| RM-STF-53 | Right to work time-limited | Outcome Time limited, no end date | "A time-limited right to work needs the date the permission ends"; follow-up date defaults to end minus 28 days |
| RM-STF-54 | DBS valid | Enhanced with barred list, 12-digit certificate, decision Clear | Saved; note "A DBS certificate has no expiry. The date shown is the local policy review date." |
| RM-STF-55 | DBS bad number | 11 digits | "A DBS certificate number has 12 digits" |
| RM-STF-56 | DBS disclosure | Disclosure filled, decision Clear | "The certificate discloses information, so the decision cannot be "clear"" |
| RM-STF-57 | DBS restricted view | Open DBS section, then Settings > Audit log | Viewing is logged |
| RM-STF-58 | Driving licence | Categories B and C1, photocard expiry, check method, 3 points | Saved; Driver eligibility shows category checks |
| RM-STF-59 | Licence errors | 25 penalty points; licence number "ABC" | Rejected; "Expected a 16-character DVLA driver number" |
| RM-STF-60 | Emergency driver | Tick emergency driver qualified, no expiry | "Add the expiry date of the emergency response driver qualification" |
| RM-STF-61 | Professional registration | HCPC, number, expiry | Saved |
| RM-STF-62 | Training record + certificate | Add training, then "Upload certificate" for the matching requirement | Record saved; certificate awaiting verification ("Someone else verifies the certificate before it counts.") |
| RM-STF-63 | Competency | Outcome Not yet competent | Saved and shown |
| RM-STF-64 | Supervision / appraisal / objective | Add one of each | Saved in their tabs |
| RM-STF-65 | Induction / probation / OH | Add induction, probation (Extended), OH fitness (Fit with adjustments), OH detail | Saved; OH detail restricted and logged |
| RM-STF-66 | Personal details | Add date of birth, address, phone | Saved in the restricted section; view logged |
| RM-STF-67 | Correct a record | "Correct" an existing record, save | "Corrected. The earlier record is kept in history."; old row "Superseded by a correction"; correcting it again refused |
| RM-STF-68 | Empty form | Save with nothing filled | "Fill in: <labels>." |
| RM-STF-69 | Schedule 3 panel | Recruitment tab | Each item Recorded and verified / not yet verified / Needs attention / Missing; summary badge |
| RM-STF-70 | Driver eligibility | Choose category C1 for someone holding only B | "Not eligible to drive category C1" with failing "Licence category" check |

### 6.4 Training matrix, group training, supervision bookings

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-STF-80 | Matrix totals | Training matrix tab | "Totals by requirement" with Met, Due soon, Overdue, Missing, "Met of required" |
| RM-STF-81 | Show people | "Show people" on a requirement | List ordered Overdue, Missing, Due soon, Met; "Open" goes to the profile |
| RM-STF-82 | Filters | Role, Requirement, "Only people with something overdue or missing" | Matrix narrows; empty message when nobody matches |
| RM-STF-83 | Cell detail | Click a cell | Status, Required, Next date, Why; Documents button; profile link |
| RM-STF-84 | Group training | Course, today's date, register ref, tick 3 people, "Record training for 3 people" | "Training recorded for everyone ticked. Each record awaits verification by HR." |
| RM-STF-85 | Group training rules | Future session date; retired course; tick a leaver | Future date refused; "That course is retired…"; leaver listed under "Not recorded" |
| RM-STF-86 | Book supervision | Supervision bookings > Book: person, supervisor Me, date tomorrow, type One to one | "Supervision booked for <name>."; row "Booked" |
| RM-STF-87 | Booking rules | Past date; person = supervisor | "Book a date from today onwards"; "A person cannot supervise themselves" |
| RM-STF-88 | Record outcome – held | "Record outcome", It was held, attended, wellbeing check | Status "Held, record written"; record on the person's file |
| RM-STF-89 | Record outcome – cancelled/missed | Cancelled with reason and rebook date | "Cancelled: <reason> (rebooked)"; reason required |
| RM-STF-90 | Status filter | Show Booked / Held / Cancelled / Missed | List filters |

## 7. Vehicles and assets (RM-FLT) – `/vehicles`

### 7.1 Vehicles register and vehicle page

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-FLT-01 | Register loads | Open Vehicles and assets | Tabs Vehicles, Equipment, Defects, Inspection checklists, Fuel and expenses; AMB-01..03 listed; AMB-03 "Blocked" |
| RM-FLT-02 | Status filter | Status = Blocked, Available, Quarantined, Off road | List filters |
| RM-FLT-03 | Add vehicle | Registration "SY21 ABC", callsign "AMB-09", Type Ambulance, Owned, base London, category C1, seats 2, wheelchair 1, stretcher, Add | Success message about requirements starting "awaiting evidence"; vehicle listed |
| RM-FLT-04 | Add vehicle errors | Bad registration, callsign "A", VIN with "O", Leased without end date, weight 100 | Listed under "Fix these before saving:" with the exact messages |
| RM-FLT-05 | Duplicate | Add with AMB-01's registration or callsign | "Another vehicle already has that registration" / "…uses that callsign" |
| RM-FLT-06 | Weight hint | Gross weight 3600 kg with category B | Hint "Needs C1" |
| RM-FLT-07 | Vehicle page | Open AMB-01 | Breadcrumb, summary line, headline badge; tabs Register details, Maintenance and odometer (default), Status and readiness, Defects, Inspections, Documents |
| RM-FLT-08 | Edit details | "Edit details", change seats, Save details | Saved; registration and callsign cannot be changed here |
| RM-FLT-09 | Odometer | Record reading 12000 today | "Reading recorded." |
| RM-FLT-10 | Odometer flags | Record a lower reading; a jump of 5000 miles; future date | Flagged "Odometer decreased" / "implausible jump"; future date "The reading date is in the future" |
| RM-FLT-11 | Review reading | "Confirm or correct" a flagged reading: correct to a value with reason | "Corrected to <n> mi by <name>: <reason>"; reviewing again refused |
| RM-FLT-12 | Maintenance plan | Status and readiness / Maintenance: add "Annual service", 365 days, 12000 miles, last done date and odometer | "Maintenance plan added."; Due and "Which limit comes first" shown |
| RM-FLT-13 | Plan errors | No interval; miles without odometer at last service | "Give a date interval, a mileage interval, or both"; "Give the odometer at the last service…" |
| RM-FLT-14 | Record service done | "Record service done": garage, date, odometer | Plan due date moves on; garage of 1 character refused |
| RM-FLT-15 | Take off road | "Take AMB-01 off the road": reason Under repair, expected back next week, details | Badge "Off road – …"; unstarted jobs go back to the planner; status history row |
| RM-FLT-16 | Put back on road | "Put AMB-01 back on the road" | Available again (if nothing else blocks it) |
| RM-FLT-17 | Quarantine / lift | Quarantine with reason, then lift | History rows "Quarantine started / ended" |
| RM-FLT-18 | No change | Try to take an off-road vehicle off the road again | "No change" |
| RM-FLT-19 | Move base | "Move AMB-01 to another base" (needs a second location) | Base history row; moving to the same base "Already based there" |
| RM-FLT-20 | Readiness check | Day today, 09:00–12:00, seats 2, wheelchairs 3, stretcher | Result Ready / Restricted / Blocked with the checks table; To before From gives "The end time must be after the start time." |
| RM-FLT-21 | Documents | Documents tab: add MOT requirement with expiry; upload the MOT | "Requirement added…"; upload awaits verification by someone else |
| RM-FLT-22 | Inspections tab | Open Inspections | Daily inspections and cleaning records (from the crew app) |

### 7.2 Defects

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-FLT-30 | Defect list | Defects tab | AMB-03 critical stop-use defect first; filters Show (Open / Returned to service) and Severity |
| RM-FLT-31 | Report minor defect | Report a defect on AMB-01: Minor, "Scuffed step", no stop use | "Defect reported."; vehicle stays Available; next action "Classify and set a repair deadline" |
| RM-FLT-32 | Report critical | Critical on AMB-02 | "Stop use now" forced on; "Blocked until repaired and returned to service." with affected jobs; vehicle Blocked; control alerted |
| RM-FLT-33 | Classify | Classify the minor defect: Minor with repair deadline | Deadline shown; Minor without deadline refused "A minor defect needs a repair deadline when classified" |
| RM-FLT-34 | Escalate to stop use | Classify with "Stop use until repaired…" | Vehicle blocked at once; jobs sent back |
| RM-FLT-35 | Start repair | "Start repair" with plan | Progress "Being repaired" |
| RM-FLT-36 | Sign off repair | "Sign off repair" with what was repaired | "Repaired – awaiting return to service"; vehicle still blocked |
| RM-FLT-37 | Repairer can't release | As the manager who signed off, look at the row | "Someone other than the repairer must return it to service." |
| RM-FLT-38 | Release by second person | As fleet lead, "Return to service": tick the check box, reason | "Returned to service"; vehicle Available if nothing else blocks it |
| RM-FLT-39 | Send back for repair | On a signed-off defect, "Send back" with reason | Back to "Being repaired"; still blocked if stop-use |
| RM-FLT-40 | AMB-03 seeded defect | Work the AMB-03 ramp defect through start → sign off (manager) → release (fleet lead) | AMB-03 becomes Available; dashboard "Blocked vehicles" drops by 1 |
| RM-FLT-41 | Critical can't downgrade | Look for Classify on a critical defect | No Classify button |
| RM-FLT-42 | Equipment defect | Defect on Equipment | Equipment names visible in the picker (known issue: may be blank) |
| RM-FLT-43 | Photos | Attach 7 photos | Only the first 6 uploaded |

### 7.3 Equipment, checklists, fuel and expenses

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-FLT-50 | Add equipment | Asset tag STR-04, Stretcher, SWL 250, gives Stretcher, kept On a vehicle AMB-01 | "Equipment added. Add its inspection regimes…"; duplicate tag refused |
| RM-FLT-51 | Edit equipment | "Edit": change serial and location | "Save asset" updates the row |
| RM-FLT-52 | Inspection regime | "Add inspection regime": LOLER, published requirement | Regime badge shown, awaiting evidence; adding LOLER again disabled "(already set up)" |
| RM-FLT-53 | Quarantine equipment | "Quarantine" with reason | "Quarantined – <reason>"; vehicle capability re-checked |
| RM-FLT-54 | Release – own quarantine | As the manager who quarantined | "You quarantined <tag>: someone else must release it." |
| RM-FLT-55 | Release – second person | As fleet lead, release with evidence file and reason | Back "In service"; without a file "Upload the repair or inspection evidence" |
| RM-FLT-56 | Checklist draft | Inspection checklists > "Draft a new checklist": name, type, 3 items (1 critical) | Row "Draft – awaiting a second person to publish" |
| RM-FLT-57 | Can't publish own | Look at the manager's own draft | "You drafted <name>: someone else must publish it." |
| RM-FLT-58 | Publish by second person | As fleet lead or governance, Publish | "Published – crews use this"; older version for the same type retired |
| RM-FLT-59 | New version / retire | "New version" then "Retire" on an old one | New draft created; retired checklist can't be started by crews |
| RM-FLT-60 | Submit claim | Fuel and expenses > Submit: AMB-01, Fuel, £45.20, 30 litres, odometer, receipt | "Claim submitted. Someone else approves it."; fuel without litres refused |
| RM-FLT-61 | Own claim | Look at the manager's own claim | "Someone else must approve your claim." |
| RM-FLT-62 | Approve / reject | Approve a crew claim; reject another with a reason | Status Approved / Rejected "By <name> – <note>"; deciding twice "Already decided" |
| RM-FLT-63 | Duplicate warning | Submit two identical claims, open the second | "This claim looks like a duplicate of another one: check before deciding." |
| RM-FLT-64 | Export claims | Approved from/to, "Export approved claims (CSV)" | CSV downloads; message "Export of approved claims downloaded." |

## 8. Compliance (RM-COMP) – `/compliance`

Tabs: Evidence review, Audits, Actions, Policies, Risk register, Events, Feedback, Registration, Governance meetings,
Fit and proper, NHS contracts, CQC notifications, Evidence pack. Opening `/compliance` with no tab shows Audits.

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-COMP-01 | Tabs | Open Compliance | All 13 tabs; arrow keys move between them; URL changes to `?tab=…`; browser Back returns to the previous tab |
| RM-COMP-02 | Unknown tab | Go to `/compliance?tab=nonsense` | Falls back to Audits |

### 8.1 Evidence review

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-EVR-01 | Queue | Open Evidence review | "Evidence waiting for review (n)"; "(k of these are yours)" when relevant |
| RM-EVR-02 | View document | "View" on a clean upload | Opens in a new tab |
| RM-EVR-03 | Verify | "Verify" someone else's upload, confirm the expiry date | State "Verified by <you> on <date>"; requirement turns green |
| RM-EVR-04 | Expiry required | Verify an expiring item with the date cleared | Confirm disabled |
| RM-EVR-05 | Reject | "Reject" with reason | "Rejected", reason shown; requirement stays not met |
| RM-EVR-06 | Own upload | Look at an item the manager uploaded | "You uploaded this: another person must verify it" |
| RM-EVR-07 | Upload limits | Upload a .exe or a file over 25 MB | Refused; failed scan shows "The file failed the virus or type check and was not kept." |

### 8.2 Audits and audit run

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-AUD-01 | Schedule list | Audits tab | "Audit schedule" with AUD-102 (Submitted – actions open) and AUD-103 (Scheduled); calendar below |
| RM-AUD-02 | Calendar | "Next month", "Previous month", "Week view" | Audit codes on their due days; overdue marked "(overdue)" |
| RM-AUD-03 | Schedule an audit | Template AC-07, title, due date, auditor Me, owner Me, Repeat Every 3 months | "Audit scheduled."; appears in schedule and calendar |
| RM-AUD-04 | Schedule errors | Period to before from; reviewer = auditor | "The period ends before it starts"; "The reviewer must not be the auditor" |
| RM-AUD-05 | Templates | "Audit templates" table | AC-07 "Green – Active – can be scheduled"; others "Grey – Draft – awaiting a second person to publish" |
| RM-AUD-06 | View controls | "View controls" on AC-07 | Version, author, methods, sample size, controls with "(critical control)" |
| RM-AUD-07 | Publish a draft | "Publish v1" on a seeded AC draft | Becomes "Amber – Published – awaiting activation" |
| RM-AUD-08 | Activate | "Activate" (as another user if the manager published it) | "Green – Active"; now offered in "Schedule an audit" |
| RM-AUD-09 | Copy | "Copy": code AC-99, title | New draft template; duplicate code "That code is already used" |
| RM-AUD-10 | Retire | "Retire" a template with reason | "N/A – Retired – <reason>"; no longer offered when scheduling |
| RM-AUD-11 | Open audit run | Click the audit you scheduled | Header (Stage, Due, Period, Auditor, Owner, Sample, Controls), Outcome panel, Record a response, Record the sample |
| RM-AUD-12 | Record sample | Population, method, dates, type Vehicle, tick AMB-01 and AMB-02 | "Sample recorded."; re-sampling recent items needs a reason |
| RM-AUD-13 | Record responses | One Pass; one Fail with note; one N/A with note | "Response saved." each; Fail/N/A without a note refused |
| RM-AUD-14 | Submit too early | Leave a control unanswered | "Answer every control before submitting (n still to answer)." |
| RM-AUD-15 | Submit | Answer all, "Submit for review" | Stage Submitted; findings worked out; Fail creates a draft action for the owner with default deadline |
| RM-AUD-16 | Auditor can't review | As auditor, look for Accept | Not shown ("The auditor cannot review their own audit") |
| RM-AUD-17 | Review AUD-102 | As manager (not the auditor), "Accept" AUD-102 | "Green – Accepted by the reviewer"; a recurring audit schedules its next run |
| RM-AUD-18 | Return with reason | On another submitted audit, "Return with reason" | "Amber – Returned by the reviewer – answer and resubmit"; auditor can answer again |
| RM-AUD-19 | Add observation | After submission, "Add an observation", severity High | Added as a failed finding; outcome updated |
| RM-AUD-20 | Raise action from finding | "Raise action": Corrective action, owner, deadline | "Raised: ACT-…"; listed under the audit's Actions |
| RM-AUD-21 | Schedule re-audit | "Raise action" with Type Re-audit | Re-audit run scheduled |
| RM-AUD-22 | History | Read "Evidence and decision history" | Results never change after corrective action |

### 8.3 Actions

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-ACT-01 | List | Actions tab | ACT-218 and ACT-219 owned by the manager ("(you)") with Deadline, State, Next step |
| RM-ACT-02 | Filters | Owner Me, Source Audit finding, State Open, Overdue only | List narrows; "Clear filters" resets; verified actions only with State = Verified |
| RM-ACT-03 | Upload evidence | ACT-218 > "Upload evidence" | "Evidence submitted. The action stays open until a verifier accepts it."; state "Ready for verification" |
| RM-ACT-04 | Can't verify own | ACT-218 as manager | "Awaiting a verifier" (no Verify button) |
| RM-ACT-05 | Verify by second person | As governance lead, "Verify" ACT-218 with what was checked | "Verified"; AUD-102 closes when all corrective actions are verified |
| RM-ACT-06 | Reject evidence | As governance lead, "Reject" with reason | "Evidence rejected"; back to the owner; manager uploads again ("Add evidence") |
| RM-ACT-07 | Verify someone else's | As manager, verify an action owned by another user with evidence from someone else | "Verified" with the manager as verifier |
| RM-ACT-08 | Change owner/deadline | "Change owner or deadline" with reason | Saved in the action history; past deadline "The deadline is in the past"; no change keeps confirm disabled |
| RM-ACT-09 | Re-audit action | ACT-219 "Complete the re-audit" | Opens AUD-103; action closes only when the re-audit run is closed (watch: may not be closable from the screen) |
| RM-ACT-10 | Source links | "Open the audit/event/…" on actions of each source | Goes to the right page |

### 8.4 Policies

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-POL-01 | List | Policies tab | "Policies and SOPs" with Owner, Current, Acknowledged, You, actions |
| RM-POL-02 | Add policy | Code POL-TEST, title, type Policy, owner Me, summary, readers Crew member, PDF | "Policy created as draft version 1. Send it for review when it is ready."; duplicate code refused |
| RM-POL-03 | Send for review | Workflow > "Send for review v1" | Stage "In review" |
| RM-POL-04 | Can't approve own | As manager (author) | "You wrote v1, so someone else must approve it." |
| RM-POL-05 | Approve by director | As director, "Approve v1" | "Approved – not yet published" |
| RM-POL-06 | Publish | "Publish v1" (optional effective date) | "Published"; readers notified; "You" column for crew "You need to read and acknowledge this" |
| RM-POL-07 | Send back to draft | On In review or Approved, "Send back to draft" | Back to Draft, approval cleared |
| RM-POL-08 | Acknowledge | As crew, "Read and acknowledge" | Acknowledged count goes up for the manager |
| RM-POL-09 | Critical instruction | Type Critical instruction; acknowledge without ticking the box | Confirm blocked until "I have read and understood this critical instruction" is ticked |
| RM-POL-10 | Readers and chase | "Details" > readers panel > "Remind those outstanding" | "Reminder sent to everyone who has not acknowledged (logged)." |
| RM-POL-11 | New version – material | "New version", material change ticked; publish via director | Everyone must acknowledge again |
| RM-POL-12 | New version – minor | Material change unticked | Existing acknowledgements carry forward ("Acknowledged (minor change since)") |
| RM-POL-13 | One draft at a time | Try a second new version while one is in progress | "A new version is already in progress" |

### 8.5 Risk register

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-RSK-01 | Add risk | "Add a risk": hazard, who, L4×I4 before, L2×I3 with controls, controls, owner, review date | "Risk added to the register."; badges "High (4 × 4 = 16)" and "Medium (2 × 3 = 6)" |
| RM-RSK-02 | Scoring bands | Try scores 4, 9, 19, 25 | Low (Green), Medium (Amber), High (Red), Extreme (Red) |
| RM-RSK-03 | Review | "Review": change controls and next review date | Review history entry; "Review by" updated |
| RM-RSK-04 | Raise action | "Raise an action" | "1 open" link to Actions; severity follows the residual rating; try a past deadline (not blocked – note it) |
| RM-RSK-05 | Close / archive | "Close" with reason; tick "Show closed risks" | Leaves the open register; shown as Closed with reason |
| RM-RSK-06 | Reopen | "Reopen" a closed risk | Back in the open register |
| RM-RSK-07 | Overdue review | Risk with a past review date | "Red – Review overdue – was due …" |

### 8.6 Events and event detail

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-EVT-01 | List | Events tab | Open events with Type, Harm, Stage, Lead, Happened, Flags; filters Show and Type |
| RM-EVT-02 | Record event | "Report an event": Incident, title, time, harm No harm, description | "Event recorded."; opens the new event |
| RM-EVT-03 | Candour flag | Record Incident with Moderate harm | Flag "Amber – Possible duty of candour – a person must decide" |
| RM-EVT-04 | Complaint / safeguarding blocks | Tick Complaint, then Safeguarding | Extra fields appear; safeguarding details required |
| RM-EVT-05 | Triage | Open an incident reported on "Report an incident", "Triage this report" (priority, harm, category, owner, protection steps) | Triage details shown; reporter sees "Triaged" |
| RM-EVT-06 | Triage overdue | Report older than one working day | "Red – Triage overdue – was due …" |
| RM-EVT-07 | Move stage blocked | Try "Move to <next>" before triage | Disabled with "Complete triage … before moving on." |
| RM-EVT-08 | Move through stages | Move Triage → Make safe → Assess reporting duties → Investigate → Respond → Actions → Learning confirmed → Closed with notes | Each move needs a note; blockers listed under "Before this can close" |
| RM-EVT-09 | Reopen stage | "Reopen: back to <prev>" with reason | Goes back one stage; nothing removed |
| RM-EVT-10 | Candour decision | "Record decision": Yes, reason 10+ chars | Decision listed; "Steps still to do" appears |
| RM-EVT-11 | Candour steps | Record each step (told in person, apology, written notice, support, findings) | Steps listed in order; future date refused; closing blocked until all recorded |
| RM-EVT-12 | Suggested duties | "Add suggested duties" | Duties added as "Amber – Decision needed" |
| RM-EVT-13 | Reporting duty | "Add a reporting duty" (RIDDOR), "Decide" Required, "Record submission" with reference | "Green – Submitted <date>"; "Not required" shows "N/A – Decided not required" |
| RM-EVT-14 | PSIRF | NHS-funded event: "Record learning response" | Closing allowed only after it is recorded |
| RM-EVT-15 | Complaint handling | Complaint event: "Record acknowledgement", "Record response" (Upheld, escalation rights told), "Reopen complaint" | Dates shown against targets; reopen clears outcome and returns to Investigate |
| RM-EVT-16 | Safeguarding section | Open a safeguarding event | "Safeguarding (restricted)" details shown; view logged |
| RM-EVT-17 | Event action | "Raise an action" | Action listed; learning cannot be confirmed until it is verified |
| RM-EVT-18 | History | Read History | Each stage change with name and note |

### 8.7 Feedback

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-FBK-01 | Record feedback | Compliment, today, source, rating 5, summary, themes "punctuality, communication" | "Feedback recorded."; future date refused |
| RM-FBK-02 | Themes | Read "Themes across feedback and complaints" | Counts per theme incl. complaints; average rating |
| RM-FBK-03 | Assign action | "Assign action" on a feedback row | Action in the Actions tab (source Feedback); "Open actions" count goes up |
| RM-FBK-04 | Date format | Look at "Received" dates | Should be UK format (known issue: shows ISO dates) |

### 8.8 Registration and CQC rating

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-COMP-REG-01 | Record | Registration tab | Provider reference, Nominated individual, Conditions, Registered activities, Insurance, Business continuity plan |
| RM-COMP-REG-02 | Update record | Change Provider reference, reason, "Save registration record" | "Registration record saved. The previous version is kept in the history."; history row |
| RM-COMP-REG-03 | Change registered manager | Change "Registered manager" and save | Draft CQC notification "Change of provider details" appears in CQC notifications |
| RM-COMP-REG-04 | Location change | "Record a location change": location, manager, effective from, reason | "Saved." / "Saved. The manager changed, so a draft CQC notification was created for review." |
| RM-COMP-REG-05 | Correspondence | Read "Regulatory correspondence" | Rows with deadline/overdue badge, or "No correspondence." |
| RM-COMP-REG-06 | Record a CQC rating | Overall Good, published date, key question ratings, https link | "Rating recorded. Display it within 21 days of publication."; badge "Amber – Display … by <date>" |
| RM-COMP-REG-07 | Record display | "Record display": premises and website dates, photo | "Green – Displayed where required"; date before publication refused |
| RM-COMP-REG-08 | No website | Tick "We have no website" | Website fields disabled |

### 8.9 Governance meetings, fit and proper, NHS contracts, CQC notifications, evidence pack

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-GOV-01 | Meeting pack | "Build the meeting pack" | Figures for Incidents, Complaints, Actions, Audits, Risks, CQC notifications, Policies; "Needs attention" badges |
| RM-GOV-02 | Record meeting | Type Clinical governance, title, held on, chair, attendees, minutes, quorate | "Meeting recorded as draft minutes. Someone else approves them." |
| RM-GOV-03 | Approve minutes | As manager on own minutes; then as governance lead | Manager: "You wrote these minutes, so someone else must approve them."; second person: "Green – Approved by <name>" |
| RM-GOV-04 | Meeting action | "Raise an action from <code>" | Action in the Actions tab (source Governance meeting) |
| RM-FPP-01 | Record check | Director name, role, checked on, tick items, outcome Fit and proper | "Check recorded. The next review is due in 12 months."; Directors table Green |
| RM-FPP-02 | Incomplete check | Leave items unticked, no self-declaration | Amber state listing missing items |
| RM-FPP-03 | Own check | Record a check with the manager's own name (if the manager is listed as a director) | "Someone else must record your own fit and proper check" |
| RM-NHS-01 | Record contract | Commissioner, reference, service, type, start/end, notice 6 months | "Contract recorded."; state Green / Amber when notice date reached; duplicate reference refused |
| RM-NHS-02 | Change contract | "Change": new end date | Saved; end before start refused |
| RM-CQC-01 | Draft notification | "Draft" from an event that may need notifying, or the form | "Draft saved. Someone else reviews it…" |
| RM-CQC-02 | Review own draft | As the manager who drafted it | "Someone else must review this." |
| RM-CQC-03 | Review and submit | Governance lead "Review"; manager "Record submission" with date and CQC reference | "Green – Submitted to CQC on …" (Amber if after target) |
| RM-CQC-04 | Not required / return | "Not required" with reason; "Return to draft" | "N/A – Decided not to be notifiable"; back to draft |
| RM-PACK-01 | Request evidence pack | Evidence pack: From/To, Key question All, Inspection, defaults ticked, "Request pack" | "Requested. The pack is built in the background…"; row in "Your exports" |
| RM-PACK-02 | No sections | Untick all sections | "Choose at least one section to include." |
| RM-PACK-03 | Download | When ready, "Download" | "Download started (logged)."; PDF/ZIP contains only verified evidence |
| RM-PACK-04 | Too many exports | Request 4 quickly | "Wait for your earlier exports to finish" |

## 9. Premises safety (RM-PRM) – `/premises`

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-PRM-01 | Register | Open Premises safety | "Premises safety register"; footnote about verification |
| RM-PRM-02 | Add item | "Add premises item": London, Fire safety, "Fire alarm test", frequency source, interval 1 month, responsible Me, schedule (if any) | "Premises item added with its schedule." or "…Link a schedule to it…" |
| RM-PRM-03 | Admin-only site | Infection-control item at an admin-only location | "Save item" disabled until the confirmation box is ticked |
| RM-PRM-04 | Edit | "Edit": change room and contractor | Saved; history row "Edited"; name under 3 characters keeps Save disabled |
| RM-PRM-05 | Link schedule | "Link a schedule" with first due date | Status follows the requirement; past date refused |
| RM-PRM-06 | Upload / verify evidence | "Upload evidence"; second person verifies via the document count | Item turns green only after verification |
| RM-PRM-07 | Not applicable | "Mark not applicable" with reason 10+ chars | "N/A – Approved as not applicable"; reason under 10 chars refused; "Mark applicable" reverses |
| RM-PRM-08 | Record finding | "Record a finding": deadline, severity, what was found | Action added to the Actions tab (source Premises item) |
| RM-PRM-09 | Status calculation | Item with interval and last assessed date long ago | "Red – Overdue since …"; within 30 days "Amber – Due …" |
| RM-PRM-10 | Oxygen at a base | Medical gases item at a base with vehicles | "Deployment-critical: ambulances at this base depend on it" |
| RM-PRM-11 | History | "History" | Added, Edited, Applicability decided, Schedule linked, Finding recorded |

## 10. Work planner (RM-PLN) – `/planner`

Start by planning a shift and booking a journey (the seed has none), or run `pnpm demo:crew`.

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-PLN-01 | Empty day | Open Work planner | "No shifts planned for this day."; filters Date and Location; Day/Week toggle |
| RM-PLN-02 | Plan a shift | Plan a shift: London, AMB-01, today 07:00–19:00, driver, second crew Technician | "Shift planned."; crew readiness shows Ready / Restricted / Not ready per person |
| RM-PLN-03 | Blocked vehicle | Open the Vehicle list | AMB-03 under "Not available (cannot be planned)" with reason |
| RM-PLN-04 | Shift rules | 17-hour shift; same person twice; end before start; overlapping vehicle | "A shift is at most 16 hours"; "The same person cannot fill two crew places on one shift"; "The shift must end after it starts"; clash message |
| RM-PLN-05 | Book a journey | Customer, booking ref BK-1001, London, today, pickup window, addresses, Walking, crew 2, Book | "Journey booked. It is now waiting for allocation."; chip in "Unallocated jobs" |
| RM-PLN-06 | Booking ref with a name | Booking ref "John Smith" | Browser hint "Letters, numbers and hyphens only…" |
| RM-PLN-07 | NHS booking | Contract NHS without eligibility | "NHS work needs the eligibility criteria and who assessed them" |
| RM-PLN-08 | Stretcher weight | Mobility Stretcher, no weight | "Stretcher and bariatric journeys need the patient weight"; weight 400 kg shows "Check before allocating" warning |
| RM-PLN-09 | Return journey | Tick return journey with return window | Two jobs created (addresses swapped); return before outward end refused |
| RM-PLN-10 | Repeating booking | Every week Mon/Wed until next month | "Journeys booked for each date in the series…" |
| RM-PLN-11 | Validate assignment | Select the job, "Assign here" on the shift | 8 checks shown (Staff clearance, Driving licence, Competence, Vehicle roadworthy, Vehicle suitable, Equipment, Time conflict, Shift gate) |
| RM-PLN-12 | Allocate | All pass: "Allocate and notify crew" | "<job> allocated to <callsign>; the crew has been notified." |
| RM-PLN-13 | Blocked allocation | Expired licence driver, missing competence, stretcher job on a vehicle with no stretcher | Fail rows with reasons; "Allocate" disabled; safety failures say "…cannot be overridden" |
| RM-PLN-14 | Approve exception | Competence failing at policy level: "Approve exception", reason 10+ chars, valid until ≤ 7 days | "Exception recorded with you as the named approver."; check shows "Exception approved" |
| RM-PLN-15 | Decide dispatcher request | Dispatcher asks for an exception; manager "Approve" or "Refuse" in "Exceptions waiting for a decision" | Approved / refused with name; refusal reason required |
| RM-PLN-16 | Drag and drop | Drag a job chip onto a shift row | Same as "Assign here" |
| RM-PLN-17 | Manage shift – add crew | "Manage shift" > Add crew member, role, times | "Crew member added. They have been told about the shift." |
| RM-PLN-18 | Swap crew | "Swap" with replacement and reason | Replacement takes the role; readiness shown |
| RM-PLN-19 | Stand down | "Stand down" with reason | Assignment withdrawn/ended |
| RM-PLN-20 | Move job | "Move to another shift" with reason | Checks re-run; job moves or stays with "Cannot move: …" |
| RM-PLN-21 | Take off shift / cancel job | "Take off shift"; "Cancel job" | Job back to unallocated; cancelled job removed (cannot be undone) |
| RM-PLN-22 | Change vehicle | "Change vehicle on <callsign>" | Replacement needs its own VDI and cleaning before the crew sets off |
| RM-PLN-23 | Cancel shift | "Cancel shift" on a planned shift | Crew stood down; jobs back to the planner; alert "<job> needs a new crew" |
| RM-PLN-24 | Week view | Switch to Week | Vehicles × 7 days; day header opens that day |
| RM-PLN-25 | Shift gate | Allocate before the shift starts / after start without VDI | "Pending – VDI and cleaning are not due until the shift starts" / "Shift has not been started" |

## 11. Reports (RM-RPT) – `/reports`

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-RPT-01 | Report list | Open the "Report" dropdown | Workforce readiness, Supervision and appraisal, Fleet availability, Overdue audits and action ageing, Incident and complaint trends, Policy acknowledgement, Premises compliance, Journey punctuality (NHS item only with the NHS pack) |
| RM-RPT-02 | Run each report | Choose each report, default dates, "Run report" | Measure cards with Counted / Out of / Period / Includes; tables; "Internal measure — not a CQC rating" |
| RM-RPT-03 | Location filter | Location London | Figures change accordingly |
| RM-RPT-04 | Bad dates | From after To; range over 366 days | "The report could not be run. Check the dates (at most 366 days)." |
| RM-RPT-05 | Export CSV | "Export CSV" | `<id>.csv` downloads; "CSV downloaded (logged)."; audit log entry |
| RM-RPT-06 | Cross-check | Compare Fleet availability with the dashboard "Blocked vehicles" tile | Same numbers |
| RM-RPT-07 | Management pack | Month = last month, "Request pack" | "Requested…"; row in "Your management packs"; "Download PDF" when DONE |
| RM-RPT-08 | Future month | Month = next month | "That month has not started yet" |

## 12. Speak up (RM-SPK) – `/speak-up`

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-SPK-01 | Tabs | Open Speak up | Raise a concern, My concerns, Concerns, Themes, Harassment prevention |
| RM-SPK-02 | Named concern | Category Bullying, summary 10+ chars, Send concern | "Your concern has been received." with SPK reference and acknowledge-by date; listed under My concerns |
| RM-SPK-03 | Anonymous concern | Tick "Raise it anonymously", send | Progress code shown once "XXXX-XXXX-XXXX"; not under My concerns; audit actor "The system" |
| RM-SPK-04 | Check progress | Enter the code, "Check progress" | Status badge and feedback; wrong code "No concern matches that code…" |
| RM-SPK-05 | Concerns list | Concerns tab, Show filters | Raised by "Anonymous" or name; status badges (overdue Red after 7 days) |
| RM-SPK-06 | Acknowledge | "Open" > "Acknowledge" with date and handler | "Acknowledged"; manager as handler of own concern refused "The handler cannot be the person who raised it" |
| RM-SPK-07 | Start / note | "Start looking into it"; "Add a note" (Note / Feedback given / Detriment check) | Status "Being looked into"; notes in History |
| RM-SPK-08 | Anonymous feedback | "Write feedback for the raiser" | Raiser sees it with the progress code |
| RM-SPK-09 | Close | "Close": outcome, closed on, what was found | "Closed"; named concern needs feedback recorded first; detriment check due in 90 days |
| RM-SPK-10 | Record concern received another way | Phone, date, raised by, summary | "Concern recorded." |
| RM-SPK-11 | Themes | Themes tab, choose quarter | Counts per category; below 3 shown as "fewer than 3" |
| RM-SPK-12 | Harassment steps | Harassment prevention tab | Five steps with badges |
| RM-SPK-13 | Risk assessment | "Start a new assessment", 2 risks, Save draft | "Draft saved. Someone else must approve it."; manager sees "Someone else must approve this."; second person approves |

## 13. Settings (RM-SET) – `/settings`

Tabs: Organisation and locations, Users and roles, Requirement library, Notifications, Support access, Audit log,
Import and export, Data protection, Integrations.

### 13.1 Organisation, users, library

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-SET-01 | Organisation details | "Edit details": rename, sector packs | Saved; switching off a pack in use refused with the list |
| RM-SET-02 | Add location | "Add location": "Croydon", Registered with CQC | "Location added."; duplicate name refused |
| RM-SET-03 | Archive / restore location | Archive Croydon with reason; restore | State changes; archiving the only active location or one with staff/vehicles refused |
| RM-SET-04 | Users list | Users and roles | Own row "(you)", no Change, "You cannot revoke your own access" |
| RM-SET-05 | Invite | Email, name, role Crew member, location, "Send invitation" | "Invitation created…"; status "Invited – not signed in yet"; inviting an existing user refused |
| RM-SET-06 | Change role | "Change" for a user: new role, reason | Role changed; history kept; own role cannot be changed |
| RM-SET-07 | Revoke | "Revoke access" with reason (5+ chars) | Status "Left"/no access; last registered manager cannot be revoked |
| RM-SET-08 | Reset MFA | "Reset MFA" with reason | "MFA reset for <name>…" |
| RM-SET-09 | Roles | Expand "N permissions" on each role | Standard roles marked "Standard (cannot be changed)" |
| RM-SET-10 | Adopt from library | Requirement library > Pack Ambulance > "Adopt" an item | Added to "Our requirements" as Draft |
| RM-SET-11 | Publish own draft | "Publish" on own draft | Disabled, tooltip "Another person must publish what you drafted"; second person publishes → "Published v1" |
| RM-SET-12 | Map to role | "What each role needs": add a published requirement to a role | Everyone with the role gets it "awaiting evidence"; "Remove" stops it counting |
| RM-SET-13 | Dental/care home adoption | Pack Dental, Adopt | Specialist name and organisation required |

### 13.2 Notifications, support, audit log, import and export

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-SET-20 | Notification rules | Change "Show as due soon", tick roles, "Save notification settings" | Saved; Alerts "Who is told about what" reflects it |
| RM-SET-21 | Warnings and escalation | Warning days "60, 30, 7", escalation days, guardian, "Save alert settings" | "Alert settings saved."; guardian shown on Speak up |
| RM-SET-22 | Deputy | Add a deputy (lead, deputy, from, to), Save | Deputy listed; lead = deputy or To before From does nothing (known issue: no message) |
| RM-SET-23 | Grant support access | Support user email, reason 10+, 2 hours, "Grant access" | "Support access granted…"; banner while active |
| RM-SET-24 | End support access | "End access now" with reason | "Support access ended…" |
| RM-SET-25 | Audit log filters | Area, Who, From/To, Record reference | Entries narrow; manager's own actions shown "(you)" |
| RM-SET-26 | Check audit trail | "Check the audit trail" | "Audit trail intact: no entry has been changed or removed." |
| RM-SET-27 | Export audit log | "Export to CSV" | CSV downloads; the export is itself logged |
| RM-SET-28 | CSV import preview | Records Staff, upload a CSV with 3 good rows and 1 bad | "Preview ready. Nothing has been created yet."; rows Valid/Error |
| RM-SET-29 | Commit import | "Import N ready rows" | "Import finished…"; staff appear in the register |
| RM-SET-30 | Roll back import | "Roll back this import" | "Rolled back…" |
| RM-SET-31 | Import errors | Missing columns; empty file; unknown location | "Missing columns: …"; "The file has no data rows"; `Location "<x>" not found` |
| RM-SET-32 | Workbook staging | Stage a sheet, Propose mapping, second person Approve, Publish as draft | Draft library template created only after another person approves |
| RM-SET-33 | Full export | "Request full export" | "Export requested…" |

### 13.3 Data protection and integrations

| ID | What to test | Steps | Expected result |
| --- | --- | --- | --- |
| RM-DP-01 | Retention rule | "Change" a rule (months, basis) | Back to "Requires approval"; manager "Someone else must approve your change."; second person approves |
| RM-DP-02 | Retention review | "Review <category>", then "Keep" with date and reason, then "Close" | Review recorded; closing without a decision refused |
| RM-DP-03 | Legal hold | "Place hold" (whole organisation, reason 10+) | "Legal hold placed…"; "Release" with reason ends it |
| RM-DP-04 | Subject request | Log an Access request about a staff member | "Request logged. The response is due within one calendar month." |
| RM-DP-05 | Request workflow | Asked for identity → Identity verified → Start work → Build export → Complete | Clock pauses while waiting for identity; export built; completing needs what was provided |
| RM-DP-06 | Extend / refuse | "Extend" to a new due date; "Refuse" with exemption | Due date changes within the limit; refused shows green closed |
| RM-DP-07 | Disclosure | "Record disclosure" | "Disclosure recorded. It cannot be edited or deleted."; search finds it |
| RM-DP-08 | Breach | "Record breach" | "Breach recorded. The 72-hour ICO clock is running from discovery." |
| RM-DP-09 | Breach workflow | Record containment → Assess (high risk forces "Report to the ICO") → Record ICO report → Close with lessons | Each step in order; closing early refused with the missing step |
| RM-DP-10 | DP complaint | "Log complaint", "Record acknowledgement", "Record outcome" | Acknowledge within 30 days; outcome closes it |
| RM-INT-01 | Connect mock | Integrations: "Connect (mock)" on Vehicle telematics | "<name> connected (mock)." |
| RM-INT-02 | Mock sync | "Run mock sync", with and without faulty records | "mock sync finished."; Recent runs show applied/flagged/skipped |
| RM-INT-03 | Payroll / calendar | Connect, "Download hours CSV", "Download calendar file" | Files download; not connected gives "Connect the … first" |
| RM-INT-04 | Disconnect | "Disconnect" | "<name> disconnected." |

---

## Known issues to watch while testing

Found while preparing this list. Raise them as defects if you can reproduce them.

1. Report an incident: a bad reference shows the field as "0" instead of the field name.
2. Report a defect on equipment: equipment names may be blank in the picker.
3. Training matrix: one state can show as "Missing or not verified" when it is really awaiting verification.
4. Staff: there is no button to revoke a role approval; moving to Leaver always ends access immediately.
5. Feedback: dates show as 2026-11-10 instead of UK format.
6. Actions: re-audit actions (for example ACT-219) may not be closable from the screen.
7. Risk register: "Raise an action" accepts a deadline in the past.
8. Settings, Notifications: "Add deputy" does nothing with no message when lead = deputy or dates are reversed;
   notification save errors are not shown.
9. Settings, Data protection: a legal hold with only one of the two dates filled covers the whole organisation.
10. Settings, Import and export: the full export says to download from Reports, but Reports only lists management packs.
11. Settings, Users: revoke accepts a 3–4 character reason in the dialog but the server needs 5.
