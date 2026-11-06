# Healthcare Hub defect register

Nov 4, 2026 · Kiran Kadiyala. Found in the browser ("Seen") or by comparing server routes with web
screens ("Code"). The workflows that close each finding are in `docs/WORKFLOWS.md`.

## Findings

| #   | Severity | Where                       | What is wrong                                                                                                                           |
| --- | -------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Critical | Reports                     | "Staff fully ready 100%, 3 of 3" when no requirement exists                                                                             |
| 2   | Critical | Staff profile, Planner      | Active Drivers have no requirements ("N/A"); planner still offers them as crew                                                          |
| 3   | Critical | Demo data                   | `pnpm demo:data` verifies each requirement with a placeholder PDF                                                                       |
| 4   | Critical | Evidence                    | No screen to open, download, see uploader/verifier, verify or reject                                                                    |
| 5   | Critical | Requirement library         | No screen to browse, adopt, publish, map to roles; dental and care-home adoption impossible                                             |
| 6   | High     | Staff profile, Recruitment  | Add-record forms cannot attach a document; checker typed as a raw user id                                                               |
| 7   | High     | Vehicles                    | No vehicle evidence upload; no off-road, move base, add maintenance plan, record maintenance done, publish/retire inspection checklist  |
| 8   | High     | Settings, Users             | No change role or location limit (invite exists)                                                                                        |
| 9   | High     | Sign-in page                | Only 8 test users; admin, Director, Premises lead, second crew, dental and care-home missing                                            |
| 10  | High     | Alerts                      | No alert centre or snooze (ALERT-01 to 04)                                                                                              |
| 11  | High     | Data protection             | Breaches cannot be assessed, reported, closed; subject requests cannot progress; no disclosure or retention log                         |
| 12  | High     | Events                      | No duty of candour decision, reporting obligations or complaint progress                                                                |
| 13  | Medium   | Planner                     | Second crew lists the driver; no swap vehicle, end crew assignment, change job status                                                   |
| 14  | Medium   | Staff                       | No correction requests, training matrix, due-date change with approver, readiness over a date window                                    |
| 15  | Medium   | Staff profile               | "Request review" and "Book supervision" missing                                                                                         |
| 16  | Medium   | Navigation                  | Every page listed for every role                                                                                                        |
| 17  | Low      | Top bar                     | Shows "Example organisation" instead of Meadowbank; breadcrumb looks fixed                                                              |
| 18  | Low      | Audit templates             | AC-07 titled "Premises and equipment" but used as vehicle cleaning audit                                                                |
| 19  | Process  | Testing                     | No browser end-to-end tests                                                                                                             |
| 20  | High     | Compliance                  | HR, Fleet, Dispatcher, Crew see "Source unavailable. Could not load audits." (403)                                                      |
| 21  | High     | Vehicles                    | Crew "Could not load vehicles"; Governance, Dispatcher, Auditor "Could not load expenses"                                               |
| 22  | High     | Crew on web                 | Every page denied; manager heading; no pointer to the mobile app                                                                        |
| 23  | Medium   | Dashboard                   | Manager heading for every role; same tiles regardless of permission                                                                     |
| 24  | Medium   | Premises                    | No premises items in demo data                                                                                                          |
| 25  | Medium   | Settings                    | Auditor cannot reach Audit log                                                                                                          |
| 26  | Medium   | Reports                     | Fleet and Dispatcher have no Export or Request pack and no explanation                                                                  |
| 27  | Critical | Evidence                    | Upload leads to "Newer evidence awaiting review" with no way to review; Documents tab empty                                             |
| 28  | High     | Upload permission           | Governance's upload form had no visible fields                                                                                          |
| 29  | High     | Dental, care home           | Profiles show no requirements; draft audit templates cannot be activated; admins see "Could not load audits"                            |
| 30  | Medium   | Sector logins               | Not on the sign-in page                                                                                                                 |
| 31  | Critical | Dashboard                   | Clicking a module filters the whole dashboard and hides critical reds                                                                   |
| 32  | High     | Dashboard                   | Clear filter does not clear                                                                                                             |
| 33  | Medium   | Dashboard                   | Owner shows Assigned/Unassigned; dates as 2026-10-29                                                                                    |
| 34  | Medium   | Dashboard                   | No module or organisation filter; breadcrumb not switchers; wrong service name                                                          |
| 35  | Low      | Dashboard                   | Critical findings open 0 while a critical stop-use defect is open                                                                       |
| 36  | Critical | Defects                     | Mark repaired in one click, no repair details or evidence                                                                               |
| 37  | Critical | Dialogs                     | Browser pop-ups in 8 places (return to service, quarantine, N/A, lift restriction, feedback)                                            |
| 38  | High     | Defects                     | No vehicle column, no report defect on web, no photo, no affected jobs                                                                  |
| 39  | High     | Vehicle detail              | No VIN, ownership, base, insurance, tax, MOT; template publishing text with no screen                                                   |
| 40  | High     | Maintenance                 | No add maintenance plan                                                                                                                 |
| 41  | Medium   | Vehicles list               | Every vehicle "42,000 mi" while detail says "No readings"; types "Wav", "Pts vehicle"                                                   |
| 42  | Medium   | Add vehicle                 | Generic error with no field named; browser validation pop-ups                                                                           |
| 43  | Medium   | Add vehicle                 | No VIN, ownership, licence category, permitted loads, insurance                                                                         |
| 44  | High     | Equipment                   | No add, detail, serial, model, assigned vehicle or regimes                                                                              |
| 45  | Medium   | Fuel and expenses           | No add or approve on web                                                                                                                |
| 46  | Critical | Staff                       | Candidate with no records approved for Driver and Approved for role by one manager                                                      |
| 47  | Critical | Staff                       | Active Driver with no licence, DBS, right to work or references shows "N/A"; planner treats as cleared                                  |
| 48  | High     | Staff                       | Driving licence saved as raw text, no number, document, verifier, edit; not in History                                                  |
| 49  | High     | Staff forms                 | Generated labels, lower-case options, free-text course codes, no certificate upload                                                     |
| 50  | High     | Staff profile               | No upload renewal, request review, book supervision; forms inline without confirm dialogs                                               |
| 51  | Medium   | Staff header                | No location or line manager; "N/A – overall compliance"                                                                                 |
| 52  | Medium   | Training                    | No training matrix                                                                                                                      |
| 53  | Medium   | Add staff                   | Only number, name, job title, base                                                                                                      |
| 54  | Critical | Audits                      | Nowhere to record responses; audit cannot be carried out                                                                                |
| 55  | Critical | Policies                    | Cannot add, review, approve or publish                                                                                                  |
| 56  | Critical | Events                      | Cannot report an incident, near miss, safeguarding concern or complaint                                                                 |
| 57  | High     | Risks                       | Cannot add or review a risk                                                                                                             |
| 58  | High     | Audits                      | No schedule, calendar, open/edit/clone template                                                                                         |
| 59  | High     | Audit page                  | Owner "You"; no header details, observations, assign action, reviewer dialog; no link to failing item                                   |
| 60  | High     | Actions                     | Cannot create, reassign or re-date                                                                                                      |
| 61  | Medium   | Registration                | Read-only and empty                                                                                                                     |
| 62  | Low      | Evidence pack               | No location, service, framework version choice                                                                                          |
| 63  | Low      | Feedback                    | Complaint is a feedback type separate from Events                                                                                       |
| 64  | High     | Premises                    | Unpublished templates offered; "TEMPLATE_NOT_PUBLISHED" raw error                                                                       |
| 65  | High     | Premises                    | No next due, evidence, edit, link schedule later; action owner "—"                                                                      |
| 66  | Critical | Planner                     | Driving licence passes with only an unverified typed record                                                                             |
| 67  | High     | Planner                     | Shift planned on a blocked vehicle with no warning                                                                                      |
| 68  | High     | Planner                     | Same person as driver and second crew gives a misleading error                                                                          |
| 69  | High     | Planner                     | Cannot add second crew; no request exception; raw codes shown                                                                           |
| 70  | Medium   | Book a journey              | Missing appointment time, patient reference and contact, weight, stairs, escort, infection, communication, equipment, skills, recurring |
| 71  | Medium   | Validate assignment         | Shift gate FAIL instead of PENDING before shift start                                                                                   |
| 72  | Critical | Reports                     | Workforce readiness 100% (3 of 3)                                                                                                       |
| 73  | Medium   | Fleet report                | Stop-use defect text and Open defects column disagree                                                                                   |
| 74  | Critical | Settings                    | No requirement library, sector packs, due-date and warning rules, notifications, deputies                                               |
| 75  | High     | Users and roles             | No change role or location; break-glass in invite list; roles cannot be opened; raw "ACTIVE"                                            |
| 76  | High     | Data protection             | Breach row has no action; form keeps values; same gap for requests and legal holds                                                      |
| 77  | Medium   | Retention                   | Rules "Requires approval" with no action                                                                                                |
| 78  | Medium   | Organisation                | Cannot edit name, add service or registered activity                                                                                    |
| 79  | Medium   | Audit log                   | Raw codes, actor "USER", entity not named, no filters, browser time                                                                     |
| 80  | —        | Dispatcher staff view       | Works as specified                                                                                                                      |
| 81  | High     | Dispatcher, Crew Compliance | Only Policies tab but page shows "Could not load audits"                                                                                |
| 82  | High     | Crew on web                 | No report defect/incident, upload certificate or acknowledge policy on web                                                              |
| 83  | Critical | HR lead                     | Moved a person with no checks to Active                                                                                                 |
| 84  | Medium   | HR lead                     | Fleet and Incident reports run although HR is refused Vehicles; reports not role-limited                                                |
| 85  | High     | Fleet, Governance           | No verify screen                                                                                                                        |
| 86  | High     | Governance                  | Cannot stage the workbook or approve the mapping                                                                                        |
| 87  | High     | Organisation administrator  | Can revoke own access and the manager's; can archive the only location; no confirm                                                      |
| 88  | Medium   | Organisation administrator  | Dashboard tiles for refused pages                                                                                                       |
| 89  | Medium   | Fleet lead                  | Ambulance with category B and no vehicle weight (over 3.5 t needs C1)                                                                   |
| 90  | Medium   | HR, Fleet, Dispatcher, Crew | Compliance no tab selected, "Could not load audits"; HR cannot report an incident or feedback                                           |
| 91  | Low      | Auditor                     | Licence penalty points visible to an external auditor                                                                                   |
| 92  | Medium   | Unknown users               | "Could not load your account" instead of "account does not exist"                                                                       |
| 93  | Medium   | Governance, Administrator   | Only the Registered Manager sees "Verify audit chain"                                                                                   |
| 94  | Critical | Dental                      | Draft audit template published and activated in one click, no specialist, no second person                                              |
| 95  | High     | Dental, care home           | Ambulance modules everywhere                                                                                                            |
| 96  | High     | Dental                      | Only ambulance roles; staff Active with no role show "N/A – nothing required"                                                           |
| 97  | High     | Dental, care home           | Every tile "Green – none" with nothing set up                                                                                           |
| 98  | Medium   | Care home                   | No service or registered activities                                                                                                     |
| 99  | Medium   | Org switch                  | Stale organisation stays selected after switching users                                                                                 |

## Fix plan

| Task                                 | What gets fixed                                                                                                                                               | Findings                                                | Research                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| 1 Approval gate                      | Approval and Approved/Active refused until checks verified; no self-approval; confirm; list missing                                                           | 2, 46, 47, 83                                           | Must-have 1                           |
| 2 Licence check                      | Planner fails on no licence, expired photocard, unverified licence, wrong category                                                                            | 66                                                      | Must-have 2                           |
| 3 Honest status                      | No N/A, 100% or "Green – none" with nothing set up                                                                                                            | 1, 47, 72, 97                                           |                                       |
| 4 Requirement library                | Browse, adopt (specialist for dental and care home), publish by second person, map to roles, sector roles, ambulance pack in seed                             | 5, 29, 74, 94, 96                                       | Must-have 16                          |
| 5 Evidence review                    | Evidence panel, download, verify or reject, reviewer not uploader, queue by role, documents tab, honest demo data                                             | 3, 4, 6, 27, 28, 48, 85                                 | Must-have 3                           |
| 6 Dialogs                            | One dialog with reason replacing pop-ups; wraps lifecycle, role, restriction, revoke, archive                                                                 | 37, 50                                                  |                                       |
| 7 Defect repair and release          | Repair details and evidence; different person releases; vehicle column; report on web; affected jobs                                                          | 36, 38                                                  |                                       |
| 8 Dashboard                          | Module filter only filters the list; Clear filter; owner names; UK dates; filters; breadcrumb switchers                                                       | 31–35                                                   |                                       |
| 9 Audits                             | Sample and answers, submit, reviewer decision, schedule, view and clone, safe publish and activate                                                            | 54, 58, 59, 94, 97                                      | Must-have 4                           |
| 10 Policies                          | Create, upload, review, approve, publish, supersede, reader groups, acknowledgement per version                                                               | 55                                                      | Must-have 5                           |
| 11 Incidents and complaints          | Report from any role, triage, obligations, duty of candour, complaint responses, actions                                                                      | 12, 56, 63, 90                                          | Must-haves 6, 7                       |
| 12 Risks and actions                 | Risk register create and review; create, reassign, re-date actions; verify closure                                                                            | 57, 60                                                  | Must-have 8                           |
| 13 Data protection                   | Breach and requests to closure, DP complaints (30 days), legal holds, retention approval                                                                      | 11, 76, 77                                              | Must-have 9                           |
| 14 Settings and users                | Change role and location, safe revoke and archive, sector packs, notification rules, due-date rules, edit organisation, readable audit log, workbook approval | 8, 74, 75, 78, 79, 86, 87, 93, 95                       | Should-have 19                        |
| 15 Registers and forms               | Vehicle register and documents, maintenance, equipment and LOLER, fuel, premises, planner fixes, booking fields, field errors, labels                         | 7, 13, 39, 40, 42–45, 49, 64, 65, 67–71                 | Must-haves 10, 11                     |
| 16 Role-based pages                  | Only show what each role can use, no false "Source unavailable", reports by role, crew self-service, full sign-in list, stale org fallback                    | 9, 16, 20–23, 25, 26, 30, 81, 82, 84, 88, 90–92, 95, 99 |                                       |
| 17 Verify and copy                   | Tests, browser check                                                                                                                                          | 19                                                      |                                       |
| 18 Schedule 3 and driver eligibility | Full staff file, DBS detail, right to work follow-up, DVLA check, C1 vs vehicle weight, emergency driving qualification, add-staff fields                     | 48, 53, 89, 96                                          | Must-haves 1, 2; should-have 24       |
| 19 Training matrix                   | Mandatory training by role, matrix, course picker, certificates                                                                                               | 14, 52                                                  | Must-have 12                          |
| 20 Harassment duty and speak-up      | Harassment risk assessment, policy, training, reporting route; whistleblowing log                                                                             |                                                         | Must-have 15; should-have 22          |
| 21 Registration and governance       | Registration history, rating display, directors fit and proper, meetings, CQC notification drafts                                                             | 61                                                      | Must-have 13; should-haves 17, 25     |
| 22 NHS contract and evidence pack    | Pack by location, service, regulation; PSIRF and LFPSE; DSPT; eligibility and KPIs; framework layer                                                           | 62                                                      | Must-have 14; should-haves 20, 21, 26 |
| 23 Smaller fixes                     | Organisation name, AC-07 title, premises demo data, odometer, fleet report count, care-home services                                                          | 17, 18, 24, 41, 73, 98                                  |                                       |
| 24 Alerts                            | Alert centre, acknowledge, snooze, deputy escalation                                                                                                          | 10                                                      |                                       |
| 25 Staff self-service                | Corrections, due-date change with approver, readiness window, request review, book supervision, header                                                        | 14, 15, 50, 51                                          |                                       |
| 26 Vehicle and planner operations    | Off-road, move base, checklist publish and retire, job status, vehicle swap, end crew assignment                                                              | 7, 13                                                   |                                       |
| 27 Data protection logs              | Disclosures log, retention action log                                                                                                                         | 11                                                      |                                       |
| 28 Browser tests per role            | Sign in as each role and complete each workflow                                                                                                               | 19                                                      |                                       |

Not planned unless asked: Martyn's Law event records, driver hours and fatigue, controlled drugs
licence tracker, real DVLA and DBS integrations, event medical quoting.
