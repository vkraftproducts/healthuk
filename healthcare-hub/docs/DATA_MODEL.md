# Data model

Conventions: UUID v7 primary keys; `organisation_id` on every tenant table; `created_at`,
`created_by`, `updated_at`, `updated_by`; soft archive (`archived_at`) instead of delete for
business records; append-only tables marked **[immutable]** (no UPDATE/DELETE grants).
Enums as Postgres enums via Prisma. Snake_case in DB, camelCase in TS.

## 1. Tenancy & identity

- `organisation` (id, name, sector_packs[], regulator, timezone default Europe/London)
- `location` (org, name, address, type: PATIENT_FACING | ADMIN_ONLY, registered)
- `service_type` / `registered_activity` (org, location, code, name)
- `user` (id, idp_subject, email, display_name, status, last_login_at)
- `membership` (user, org, location nullable=all, role_id, valid_from, valid_to)
- `role` (org nullable=system, key, name) · `permission` (key) · `role_permission`
- `device_session` (user, device_id, platform, push_token, revoked_at)
- `support_access_grant` [immutable] (support_user, org, approved_by, reason, starts, ends)

## 2. Requirements engine

- `requirement_template` (org nullable=library, pack, code e.g. `HR-DBS`, title)
- `requirement_template_version` [immutable once published] (template, version, status
  DRAFT|APPROVED|EFFECTIVE|SUPERSEDED, basis_type, regulation_ref, source_url,
  source_version_date, effective_from/to, subject_type STAFF|VEHICLE|EQUIPMENT|PREMISES|
  SERVICE|ORGANISATION, applicability_rule jsonb, evidence_type, recurrence jsonb,
  warning_days int[], blocking NONE|POLICY|DEPLOYMENT_CRITICAL|STATUTORY|SAFETY_CRITICAL,
  approval_role, framework_mappings jsonb, approved_by, approved_at)
- `requirement_instance` (org, location, template_version, subject_type, subject_id,
  owner_user, deputy_user, due_date, expiry_date, review_date, status, reason_code,
  reason_text, computed_at)
- `applicability_decision` [immutable] (instance or template+subject, decision, reason,
  reviewer, review_date)
- `due_date_change` [immutable] (instance, old, new, reason, approver)
- `framework_heading` (framework_version, key question SAFE|EFFECTIVE|CARING|RESPONSIVE|
  WELL_LED, quality_statement)

## 3. Evidence

- `evidence_item` (org, title, type, retention_class, sensitivity NORMAL|HR|CLINICAL|
  SAFEGUARDING|CRIMINAL_OFFENCE)
- `evidence_version` [immutable] (item, blob_key, sha256, mime, size, scan_status
  PENDING|CLEAN|MALICIOUS|FAILED, uploaded_by, captured_at, valid_from, valid_to)
- `evidence_link` (evidence_item, requirement_instance) — many-to-many (COMP-02, MIG-02)
- `verification` [immutable] (evidence_version, decision ACCEPTED|REJECTED, reason, reviewer)

## 4. Staff

- `staff` (org, staff_no e.g. ST-0042, user nullable, name, lifecycle_state, primary_location,
  manager, job_role, working_pattern)
- `staff_role_approval` (staff, role e.g. DRIVER|CARE_ASSISTANT|PARAMEDIC, approved_by, from, to)
- `staff_restriction` (staff, type, reason, from, to)
- `staff_sensitive` (staff, dob, address, next_of_kin, emergency_contact) — restricted RLS
- `dbs_record` (staff, eligibility, level, barred_list, cert_number_encrypted, issue_date,
  update_service_consent, risk_decision, policy_review_date) — restricted
- `right_to_work_check`, `reference`, `employment_history_entry`, `driving_licence`
  (categories[], restrictions, expiry, last_check_at), `professional_registration`,
  `oh_clearance` (fit_status only; clinical notes in `oh_detail` restricted)
- `training_course` (code, version) · `training_record` · `competency_assessment`
- `supervision`, `appraisal`, `objective`

## 5. Fleet & equipment

- `vehicle` (reg, vin, type, ownership OWNED|LEASED|HIRED, base_location, seats,
  wheelchair_capacity, stretcher, permitted_loads, status AVAILABLE|BLOCKED|QUARANTINED|OFF_ROAD)
- `vehicle_location_history` [immutable]
- `vehicle_document` (insurance/tax/MOT as requirement instances)
- `maintenance_plan` (vehicle, interval_days, interval_miles) · `maintenance_event`
- `odometer_reading` [immutable] (vehicle, value, source, read_at, flag)
- `equipment_asset` (asset_id, serial, model, swl, vehicle nullable, location, status)
- `inspection_regime` (asset, regime LOLER_THOROUGH|SERVICE|CALIBRATION|PRE_USE, interval,
  source) → requirement instances
- `vdi` [immutable] (vehicle, shift, checker, odometer, submitted_at, client_submission_id,
  captured_at, received_at) · `vdi_item_result` (item_code, result PASS|FAIL|NA, reason, photo)
- `vdi_amendment` [immutable]
- `cleaning_record` [immutable] (vehicle, shift, type PRE_SHIFT|BETWEEN_PATIENT|ENHANCED, by, at)
- `defect` (vehicle/asset, severity, stop_use, description, reporter, discovered_at, status
  OPEN|REPAIRING|REPAIRED|RELEASED) · `defect_release` [immutable] (released_by, evidence)
- `fuel_expense` (vehicle, staff, date, mileage, litres_or_kwh, amount, currency, supplier,
  receipt evidence, approval, duplicate_flag)

## 6. Compliance & governance

- `audit_template` / `audit_template_version` [immutable once published] (questions jsonb,
  criteria, sample_method, sample_size, methods[])
- `audit_run` (template_version, code e.g. AUD-102, location, period, auditor, owner,
  due_date, status SCHEDULED|IN_PROGRESS|SUBMITTED|ACTIONS_OPEN|CLOSED, outcome)
- `audit_sample` (run, population_desc, selection_method, date_range, subject_ids[])
- `audit_response` [immutable after submit] · `audit_finding` (control code e.g. AC-07,
  result, severity)
- `action` (code e.g. ACT-218, source finding/event/risk, severity, owner, deadline, status
  OPEN|EVIDENCE_SUBMITTED|VERIFIED|REJECTED, verifier) · `action_history` [immutable]
- `policy_document` / `policy_version` (status, effective, review, reader_groups, material)
- `policy_acknowledgement` [immutable] (policy_version, staff, at, device)
- `risk` (hazard, people, inherent, controls, residual, owner, review_date)
- `registration_record`, `regulatory_correspondence` (deadline)

## 7. Events

- `event` (types[] INCIDENT|ACCIDENT|NEAR_MISS|SAFEGUARDING|COMPLAINT|DEFECT, occurred_at,
  discovered_at, location, severity, lead, status, links to jobs/staff/assets)
- `reporting_obligation` (event, body CQC|SAFEGUARDING|RIDDOR|INSURER|COMMISSIONER|ICO,
  trigger, basis, deadline_at, decision, submitted_at, reference, receipt)
- `candour_assessment` [immutable decisions] · `complaint_detail` · `safeguarding_case` (restricted)

## 8. Premises

- `premises_item` (location, control_area, responsible_person, applicability, assessment
  evidence, frequency_source) → requirement instances

## 9. Jobs

- `booking` (customer, reference, recurrence_series nullable)
- `job` (code e.g. J-117, booking, date, pickup_window tstzrange, appointment_at,
  pickup/destination address, access_notes, patient_ref, mobility, weight_kg nullable,
  stairs, escorts, infection_precautions, comms_needs, required_equipment[],
  required_skills[], state, planned tstzrange)
- `patient_contact` (restricted, minimal) — never in logs or push
- `shift` (location, vehicle, starts_at, ends_at, state)
- `crew_assignment` (shift, staff, role DRIVER|ATTENDANT|SUPPORT, period tstzrange)
- `resource_booking` (resource_type, resource_id, period tstzrange) with
  `EXCLUDE USING gist (resource_id WITH =, period WITH &&)` (needs btree_gist)
- `job_allocation` (job, shift, validated_at, validation_result jsonb, exception_id)
- `allocation_exception` [immutable] (check_code, approver, reason, expires_at)
- `job_status_event` [immutable] (job, state, actor, captured_at, received_at, reason,
  client_submission_id unique)

## 10. Cross-cutting

- `alert` (org, source_type, source_id, severity, reason_code, owner, state, snoozed_until)
- `notification_delivery` (alert, channel, dedupe_key unique, status, attempts)
- `audit_log` [immutable, hash-chained] (org, seq, actor, action, entity, entity_id,
  before_hash, after summary (no PII), ip_hash, prev_hash, hash)
- `import_batch` / `import_row` (source_sheet, source_row, prompt_code, status, errors)
- `retention_rule` (record_category, period, basis) · `legal_hold`
- `idempotency_key` (key, user, response_hash, created_at) — for all POSTs from mobile
