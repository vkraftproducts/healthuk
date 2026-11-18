# Implementation plan – Exora paper forms into Healthcare Hub UK

Date: 18 Nov 2026. Status: **planned, not started**. Owner decisions still open are in section 1; each work package says what it assumes until they are made.
Source documents (owner's, in `/mnt/user-data/uploads` of the 18 Nov chat; ask the owner to re-attach): Crew application form 2026, Interview assessment form, Driving assessment, Employee details form, Health questionnaire (11/2010) with equality monitoring, Statement of confidentiality + confidentiality agreement, ICT & digital communications code of conduct, Working Time Regulations 48-hour opt-out. Plus three screenshots of the current routine-check app: the vehicle "Standard" routine check (35 items, time taken, vehicle photo, notes) and the crew pre-shift fitness declaration (temperature band, four declarations, signature).
Board with the plan and every existing workflow: https://claude.ai/artifact/BSk8e8pkQ6tLYQ2ND93UCu. Word list of all workflows: `C:\HealthUK\healthuk\Claude outputs\Healthcare_Hub_workflows.docx`.

## 0. Principles (apply to every package)
- **Reuse before building.** Each form lands in an existing workflow (onboarding pipeline, candidate portal, requirements + evidence, policies, workforce checks, daily checks, crew app, rota). New tables only where no existing record fits.
- **The three house rules stay.** Only verified evidence turns green, verified by someone other than the person who entered it. Safety gates are never overridable. History is append-only: corrections are new entries with who and why.
- **Typed forms, not a form builder.** Each paper form becomes a typed record with a zod contract, so it can drive rules and reports. The exceptions are two configurable lists: the daily check list (already versioned) and the fitness declaration items (new, versioned the same way).
- **Sensitive data:** health answers, immunisations, equality monitoring and bank/NI details are special category or high risk. Use separate tables, their own permission, RLS, an audit entry for every read, and retention rules. Update the DPIA and ROPA (`docs/compliance/DPIA_template.md`, `ROPA.md`).
- **Patterns to copy** (as in the b8 work): migrations copy `0050_cqc_self_audit.sql` (uuid v7, `organisation_id`, version + `bump_version()`, CHECKs, RLS block, grants); immutable logs use `forbid_mutation()`. Controllers copy `apps/api/src/modules/v36/cqc-self-audit.controller.ts` (`@RequirePermission`, `withTenant`, `audit()` on every write, four-eyes as `HubError('FOUR_EYES_REQUIRED', 409, …)`). Contracts go in `packages/contracts/src/v36.ts` and `routes-v36.ts` (POST/PATCH only, no PUT). Web uses `WfCard`/`DataTable`/`RowActions`/`WfTag`/`ActionDialog`.
- **Migration rule learned in b8:** any migration that changes existing rows must lift FORCE RLS and any guard trigger for its own statements and restore them. Always test the upgrade with the b7/b8 replay (HANDOVER-CLAUDE §1), never only on a fresh database.
- Migration numbers start at **0060** (0059 is the live-updates backfill for the v36 tables, b10).

## 1. Owner decisions (ask before the package that needs them)

**Decided 18 Nov 2026 (owner):** D2, D4, D5, D7 as assumed below. Still open: D1, D3, D6.
| # | Question | Needed by | Assumed until decided |
|---|---|---|---|
| D1 | Bank, NI, UTR and pay: store in the hub (restricted) or export to payroll only? | P3.4 | Store restricted, encrypted columns, CSV export for payroll |
| D2 ✔ | DVLA points limit: 3 (interview form) or 6 (current app/v36)? | P2.2, P2.3 | Organisation setting `dvlaPointsLimit`, default 6; Exora sample org set to 3 |
| D3 | Who may read health questionnaire answers: occupational health only, or the RM too? | P3.1 | New role OCCUPATIONAL_HEALTH only; RM sees the outcome and adjustments |
| D4 ✔ | Keep the COVID questions on the fitness declaration? | P1.4 | Items are configurable; the seeded list has no COVID items and keeps temperature band, alcohol, drugs/medicines |
| D5 ✔ | Which of the 35 vehicle items are critical (a fail = stop-use defect)? | P1.3 | Brakes, tyres, lights/stop lamps, indicators, steering-related, seat belts, stretcher locking brackets, ramp, windscreen, handbrake, oxygen cylinder & piping |
| D6 | Who may carry out a driving assessment? | P2.3 | A person holding the competency "Driving assessor" (C4), never the candidate |
| D7 ✔ | Is a typed name + drawn signature + time + document hash acceptable for these signatures (HR adviser)? | X1 | Yes |

## 2. Cross-cutting pieces (build first, used by several packages)

### X1. Signature capture
- Web component `apps/web/src/v36/Signature.tsx`: canvas pad (pointer events, clear, minimum stroke length) plus typed full name. It produces a PNG `Blob` and the name.
- Mobile component in `apps/mobile/src/ui/` (react-native canvas or SVG path capture), same output.
- Storage: the PNG is uploaded through the existing evidence pipeline (`/evidence/uploads` → `/complete`, channel `STAFF_APP`/`CANDIDATE_PORTAL`) as an evidence item of type SIGNATURE. The signed record stores `signature_evidence_item_id`, `signed_name`, `signed_at` and `document_sha256` (hash of the exact text or version signed).
- Tests: the component emits nothing until there's a stroke and a name; the API refuses a signed record without both.

### X2. Signed copy as PDF on the staff file
- A worker job (`apps/worker`) renders a signed form (text, answers, signature image, hash, time) to PDF and stores it as an evidence item linked to the person. Reuse the PDF tooling used by evidence packs / management packs.
- Shown in Staff › profile › Documents. Immutable.

### X3. Candidate portal "To do"
- The candidate profile (v36 "Candidate (portal)", Jordan Reed in sample data) gets a **To do** list: forms to complete, documents to upload, policies to sign.
- Driven by a `candidate_task` view computed from: an application not yet submitted, missing requirement evidence, unsigned required policies, a health questionnaire opened after an offer, starter details after approval.
- No new table if it can be derived; otherwise `candidate_task` (kind, subject id, done_at).

### X4. Permissions and roles (`packages/contracts/src/rbac.ts`, synced by `system-roles.ts`)
- New permissions: `recruitment.application.manage`, `staff.health.view`, `staff.health.manage`, `staff.payroll.view`, `staff.payroll.manage`, `fleet.fitness.view`.
- New system role `OCCUPATIONAL_HEALTH` (`staff.health.*` only).
- RM, Director, HR lead: `staff.payroll.view`; HR lead also `staff.payroll.manage`.
- Every read of health or payroll data writes an audit entry (`audit()` with action `*.viewed`).

### X5. Retention rules (seed, approved by a second person as today)
- Unsuccessful applications and interview records: 6 months after the decision.
- Equality monitoring: 3 months if not appointed, otherwise anonymised statistics only.
- Health questionnaire: occupational health retention policy (assume 6 years after leaving). Payroll: 6 years after leaving. Signed forms: with the HR file.

## 3. Phase 1 – quick wins (~1 week)

### P1.1 Signed acknowledgements: confidentiality statement + agreement, ICT code of conduct
- **DB 0060:** `ALTER TABLE policy_version ADD requires_signature boolean NOT NULL DEFAULT false`. Add to `policy_acknowledgement`: `signed_name text`, `signature_evidence_item_id uuid`, `document_sha256 text`. It is append-only, so adding columns is fine; existing rows stay null.
- **API:** `POST /policies/{id}/acknowledge` accepts `{signedName, signatureEvidenceItemId}` when the version requires a signature. It refuses without them, computes `document_sha256` from the version's file, and queues the X2 PDF.
- **Requirement link:** new library template `ORG-STF-SIGN` "Signed policy: <policy>". It is met automatically when the current version is acknowledged with a signature. This is a system-verified kind, like an acknowledgement, not evidence, so the "someone else verifies" rule doesn't apply; state this in the template's basis text. It appears on People / readiness as a check. A material change to the policy re-opens it, as G4 already does for acknowledgements.
- **Web:** Policies › Read and sign dialog with X1. My work and the candidate portal list "Policies to sign".
- **Mobile:** `Policies.tsx` gets the signature step.
- **Seed:** the three documents as policies (sample text written fresh, not copied word for word), `requires_signature = true`, reader group all staff. Alex Morgan has signed; Jordan Reed hasn't.
- **Tests:** API refuses an acknowledgement without a signature; the requirement turns green after signing; a new material version turns it back. Web test for the dialog.

### P1.2 Working Time Regulations 48-hour opt-out
- **DB 0061:** `working_time_opt_out` (id, org, staff_id, signed_at, signed_name, signature_evidence_item_id, document_sha256, manager_user_id, manager_signed_at, withdrawal_notice_on date null, ends_on date null = notice + 3 months, version). Unique: one open row per staff. CHECK `manager_user_id <> staff's user`.
- **API:** `POST /staff/me/working-time-opt-out` (self-sign), `POST /working-time-opt-outs/{id}/countersign` (manager, four-eyes), `POST /working-time-opt-outs/{id}/withdraw` (staff gives notice; `ends_on` = +3 months), `GET /working-time-opt-outs`.
- **Rules (`packages/rules` `rotaWarnings`):** add the 17-week rolling average of planned + actual hours (shift_time entries when present). Over 48 with no opt-out in force: a **warning** at allocation, open-shift fill and swap approval ("Lee Davies would average 49.5 h over 17 weeks and has no opt-out"). Daily and weekly rest warnings stay as they are. An opt-out never removes rest rules. It is voluntary, so it is **never** a red or missing requirement.
- **Web:** Staff profile › Working time card (status, signed date, notice, ends). Shifts › Hours shows the 17-week average column.
- **Tests:** average maths with a 17-week window; warning shown without an opt-out and not with one; withdrawal ends it after 3 months; manager can't countersign their own.

### P1.3 Vehicle routine check (check list v4 "Standard")
- **DB 0062:** `vdi_template ADD requires_vehicle_photo boolean NOT NULL DEFAULT false`. `vdi ADD started_at timestamptz` (time taken = `captured_at - started_at`) and `vehicle_photo_evidence_item_id uuid`.
- **Contracts:** VDI submit takes `startedAt` and `vehiclePhotoEvidenceItemId`; the DTO returns `durationSeconds`.
- **API:** submit refuses a missing vehicle photo when the template requires it, and refuses `startedAt` after `capturedAt` or more than 2 hours before.
- **Mobile `Vdi.tsx`:** record `startedAt` when the screen opens, add a "Photo of vehicle" step before submit, Notes field (exists).
- **Web:** Daily checks › History shows "Time taken 2 min 25 s" and a vehicle photo thumbnail. Detail view lists items like the screenshot.
- **Seed:** check list v4 "Standard" with the 35 items from the screenshot (Brakes … Straps), critical flags per D5, drafted by the Fleet lead and published by the RM. Keep v3 history.
- **Not ported:** the old app's "Remove routine check". Checks are never deleted; corrections are amendments (D6 rule).
- **Tests:** duration computed; photo required; critical fail still raises a stop-use defect.

### P1.4 Fit-for-duty declaration before a shift
- **DB 0063:** `fitness_declaration_template` (versioned like `vdi_template`: items `[{code,label,mustBe:true}]`, `temperature_bands` `[{code,label,ok}]`, active, published_by ≠ drafted_by). `fitness_declaration` (org, staff_id, assignment_id, template_id, temperature_band, answers jsonb, all_ok bool, signed_name, signature_evidence_item_id, captured_at, client_submission_id unique), append-only (`forbid_mutation`).
- **Gate:** `POST /shifts/{id}/start` and the crew assignment start require today's declaration for that assignment with `all_ok`. New check in the shift gate list "Fit for duty declaration" (pending → pass/fail). A fail is safety-critical, so no exception. A declaration that isn't OK raises an alert to control/dispatcher: "Alex Morgan declared not fit for duty for AMB-01 07:00". It stores only the answers, no medical detail.
- **API:** `POST /fitness-declarations` (crew, own assignment only, idempotent), `GET /fitness-declarations?date=` (control, `fleet.fitness.view`), template draft/publish/retire like the VDI templates.
- **Mobile:** new screen `FitForDuty.tsx` shown on MyShift before the vehicle check; offline queue like the other crew submissions.
- **Web:** Work planner day view marks crew "Declared fit 06:41" / "Not declared". Records by date gets a "Fitness declarations" type.
- **Seed:** template v1 per D4 (temperature bands NORMAL 34–37.3 °C ok, HIGH > 37.3 not ok, LOW < 34 not ok; "Not under the influence of alcohol"; "Not under the influence of drugs, including prescription or over-the-counter medicines that could affect my ability"). Today's declarations for the 07:00 crews.
- **Tests:** shift can't start without a declaration; a "No" answer blocks and alerts; crew can't declare for someone else.

## 4. Phase 2 – recruitment (~2 weeks)

### P2.1 Crew application form (candidate portal)
- **DB 0064:**
  - `recruitment_link` (token hash, role applied for, expires_at, created_by, max_uses). A public link per advert: no open endpoint without a token, rate-limited.
  - `job_application`: personal details; right to work yes/no + restriction text + expiry; driving (full licence, categories, years held, endorsements text, previous passenger-vehicle driving); experience text; qualification flags (first aid, M&H, safeguarding, IPC, PTS/ambulance, other); employment history jsonb `[{employer, title, from, to, reasonForLeaving}]`; referees jsonb (2: name, email, relationship); availability (FT/PT/bank, days[], weekends/overtime, earliest start); emergency contact; declaration + consent timestamps and privacy-notice version; status SUBMITTED / SHORTLISTED / INTERVIEW / OFFERED / REJECTED / WITHDRAWN; staff_id once converted.
- **API:**
  - `POST /public/applications` (token) and `GET /public/applications/form?token`.
  - `GET /applications` and `POST /applications/{id}/status` (reason on reject).
  - `POST /applications/{id}/convert`: creates the CANDIDATE staff record, invites the candidate user to the portal, and starts checks for the role.
- **Mapping on convert:**
  - Driving "yes" → also start checks for Driver (licence, DVLA, driving assessment).
  - Each referee → a reference request (email via the notification outbox with a one-time referee link; the referee form creates a REFERENCE staff record "awaiting verification").
  - Employment history fills the AMB-STF-04 record draft.
  - Availability goes to Shifts as the person's availability note.
- **Web:** public `/apply/:token` page (no sign-in), Onboarding › Applications list (new first view before Pipeline), application detail with Convert / Reject.
- **Retention:** X5.
- **Tests:** an invalid or expired token is refused; convert creates exactly one staff member and the right check instances; reject needs a reason; referee link works once.

### P2.2 Interview assessment
- **DB 0065:** `interview_assessment` (application_id or staff_id, interview_at, interviewer_user_ids uuid[], employment type BANK/FULL_TIME/PART_TIME, factors jsonb for the 7 factors `{score: GOOD|ACCEPTABLE|UNSATISFACTORY, comment}` (attire/speech, flexibility of hours, CQC knowledge, teamwork, job knowledge and skills, overall experience/CQC, overall impression), available_hours text, offer YES/NO/MAYBE, recorded_by, version). Interviewers ≠ the candidate.
- **Pre-employment checks section:** not stored. The screen shows live requirement status for registration (HCPC etc.), ID, qualifications, application signed, DBS, DVLA points vs D2, right to work, and further training needed.
- **API:** `POST /interview-assessments`, `PATCH` while offer is MAYBE, `GET`. Offer YES moves the application to OFFERED and the staff lifecycle to CHECKS_IN_PROGRESS, and opens the P3.1 questionnaire task.
- **Web:** Onboarding › candidate › Interview tab.
- **Tests:** offer YES transitions; NO closes the application with a reason; DVLA points over the limit flagged.

### P2.3 Driving assessment
- **DB 0066:** `driving_assessment` (staff_id, licence_last4, licence_expires_on, documents_checked text, eyesight_ok bool (20.5 m plate), vehicle_id, items jsonb for the 20 items `{code, grade: S|A}`, assessor_user_id, assessed_on, comments, outcome PASS/ATTENTION computed (any A → ATTENTION)). Append-only; a re-assessment is a new row.
- **Rules:** the assessor must hold the competency "Driving assessor" (D6) and must not be the candidate. PASS satisfies the existing "Driving assessment" requirement (system evidence, verified by the assessor's record, since the assessor is the second person). ATTENTION leaves it unmet, so the person can't be allocated as Driver (existing E3 gate) and HR sees "Reassessment needed". The licence number and expiry cross-check the latest DVLA check (C1).
- **Web:** Staff › Workforce checks › Driving assessments card plus a form dialog. Staff profile shows the latest result.
- **Tests:** an assessor without the competency is refused; any A → requirement not met; PASS → met.

## 5. Phase 3 – sensitive data (~2 weeks)

### P3.1 Health questionnaire (after an offer only)
- **DB 0067:** `health_questionnaire` (staff_id, opened_at (only after offer), submitted_at, answers jsonb (24 yes/no + days absent + details per question), lived_abroad, needle_stick (+ follow-up), height_cm, weight_kg, declaration signature (X1), status OPEN/SUBMITTED/REVIEWED, reviewed_by (OH), outcome FIT/FIT_WITH_ADJUSTMENTS/NOT_FIT/MORE_INFO, adjustments text (visible to RM/HR), review_note (OH only)). RLS + `staff.health.view`. Answers in a column encrypted with pgcrypto (key from env) or a separate restricted schema.
- **Gate:** the API refuses to open the questionnaire before an offer is recorded (Equality Act 2010 s60).
- **API:** candidate `GET/POST /staff/me/health-questionnaire`, OH `GET /health-questionnaires`, `POST /{id}/review`. Each OH read is audited.
- **Outcome:** writes the OH_CLEARANCE staff record (exists) and satisfies ORG-STF-03 "Occupational health – fit for the role". FIT_WITH_ADJUSTMENTS adds the adjustments text; NOT_FIT blocks approval. Needle-stick "yes" offers OH a link to H1 (never automatic).
- **Web:** candidate portal form; Staff › Occupational health queue (OH role only).
- **Tests:** opening before an offer is refused; HR without the permission gets 404; every read is logged; outcome turns the requirement green.

### P3.2 Immunisations
- **DB 0068:** `immunisation_record` (staff_id, vaccine TETANUS/POLIO/RUBELLA/TB_TEST/BCG/DIPHTHERIA/HEP_A/HEP_B/CHICKENPOX/COVID19, dose label, given_on, result text, evidence_item_id (blood results), recorded_by). Restricted like P3.1.
- **Requirement:** "Hepatitis B immunisation recorded" for clinical roles, status only. DEN-STF-08 shows the pattern.
- **Tests:** restricted access; the course is complete after 3 doses + blood test.

### P3.3 Equality and diversity monitoring
- **DB 0069:** `equality_monitoring` with **no** staff_id or application id: org, recruitment round / role, submitted_at, answers jsonb (protected characteristics, each with "prefer not to say"), appointed bool set later via an opaque token the candidate holds.
- **Reports:** counts only, with small-number suppression (fewer than 5 shown as "<5"); never shown to interviewers.
- **Retention:** X5.
- **Tests:** no way to join to a person; suppression works.

### P3.4 Employee details and payroll
- **DB 0070:** `staff_payroll` (staff_id unique, ni_number (format-checked, encrypted), bank_name, account_name, sort_code + account_number (encrypted), utr, employment_status BANK/FULL_TIME, pay_rate_hourly numeric, rate_entered_by, rate_authorised_by ≠ entered_by, effective_from, version). History table append-only. Staff has no date of birth or sex today: add `date_of_birth` to `staff_payroll` (needed for payroll/HMRC); record sex only if the payroll export needs it.
- **API:** starter submits their own details after approval (portal task); HR verifies; the manager enters the rate; a second person authorises; `GET /payroll/export.csv` (`staff.payroll.view`, audited).
- **Web:** Staff profile › Payroll card (masked: sort code ••-••-12), restricted.
- **D1:** if the owner chooses export only, keep the form and export, and don't store bank fields.
- **Tests:** masking; four-eyes on the pay rate; export audited; no access without the permission.

## 6. Sample data
Use fictional people only. Add to `packages/db/scripts/v36/build-v36-data.py` with fixed ids `U('<table>','<code>')` and dates through `D()`/`T()`:
- One open recruitment link.
- Two applications: one converted into Jordan Reed's journey, one rejected.
- An interview (offer YES) and a driving assessment (Ellis Grant PASS, one with an Attention item).
- Signed confidentiality and ICT policies for most staff.
- Two opt-outs (one withdrawn with notice).
- Check list v4 with today's checks showing time taken.
- Today's fitness declarations.
- OH outcome for Jordan Reed: fit with adjustments.

Every new "always" seed step that touches guarded rows uses the DO-block pattern from b8 (`HANDOVER-CLAUDE §4`).

## 7. Order, estimates and done criteria
| Order | Package | Size | Depends on |
|---|---|---|---|
| 0 | Finish web tests and the API test fixtures (HANDOVER-CLAUDE §3.1–3.2) | 1–2 days | – |
| 1 | X1 signature, X2 PDF, X4 permissions | 2 days | – |
| 2 | P1.1 signed policies | 1 day | X1, X2 |
| 3 | P1.3 check list v4 | 1 day | D5 |
| 4 | P1.4 fitness declaration | 2 days | X1, D4 |
| 5 | P1.2 opt-out + 17-week average | 1–2 days | X1 |
| 6 | X3 portal To do, P2.1 application | 3–4 days | X4 |
| 7 | P2.2 interview, P2.3 driving assessment | 2–3 days | P2.1, D2, D6 |
| 8 | P3.1 health, P3.2 immunisations | 3 days | P2.2, D3 |
| 9 | P3.3 equality, P3.4 payroll, X5 retention | 2–3 days | D1 |

A package is done when:
1. contracts, domain and API builds pass;
2. api and web `tsc --noEmit` are clean, and web `eslint src --quiet` shows only the old `brand.tsx` error;
3. one API test per endpoint, including the four-eyes or permission refusal;
4. the seed rebuilds and `seed:v36` runs twice on a fresh database **and** on the b8 replay;
5. the screen is checked at 1440 px with the v36 look (WfCard tables, v36 pills, "8 Jun 2026" dates);
6. the DPIA/ROPA entry is updated for P3 items;
7. files are synced to the PC with md5 verification, with no commit unless the owner approves.
