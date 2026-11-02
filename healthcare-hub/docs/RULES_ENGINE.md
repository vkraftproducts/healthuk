# Rules Engine — status, deadlines and deployment gates

**Safety-critical.** Implement in `packages/rules` as pure, deterministic TypeScript functions
with 100% branch coverage. Inputs include `now` explicitly; never read the clock inside.
Use Luxon with zone `Europe/London`. Requirement IDs: ALERT-01..04, HR-02, FLT-04..06, JOB-03.

## 1. Date semantics (ALERT-01)

Store separately: `due_date`, `expiry_date`, `review_date` (all `DATE` for date-only) and
`*_at` (`TIMESTAMPTZ` + `tz` column) when a precise time matters.

```ts
// A date-only deadline D is satisfied through 23:59:59.999 Europe/London on D.
endOfLondonDay(d: ISODate): Instant
isDueToday(d, now)   = londonDate(now) == d
isOverdue(d, now)    = now > endOfLondonDay(d)
daysUntil(d, now)    = calendar days between londonDate(now) and d (not 24h blocks)
```

- DST: calendar-day arithmetic in the London zone, never `+86400000 ms`.
- Leap year: an annual recurrence from 29 Feb lands on 28 Feb in non-leap years.
- Month-end: monthly recurrence from 31 Jan → 28/29 Feb → 31 Mar (anchor day preserved,
  clamped to month length; compute from anchor, not from previous clamped date).
- Server time authoritative; clients display but never decide.

### Validity across a job window

A time-limited clearance (licence, registration, insurance, MOT) is valid for a job only if
`validFrom <= job.plannedStart` **and** `job.plannedEnd <= endOfLondonDay(expiryDate)`.
A job that extends past expiry fails validation (UAT-01, UAT-02).

## 2. Requirement instance status

Statuses (enum `RagStatus`): `RED`, `AMBER`, `GREEN`, `GREY`, `NOT_APPLICABLE`, each with a
`reasonCode` and human `reasonText`. Evaluate in this exact order — first match wins:

```
1. applicability == APPROVED_NOT_APPLICABLE (with reason, reviewer, reviewDate)
      → NOT_APPLICABLE  (reported separately, never counted as compliant)
2. has open CRITICAL finding / failed critical check linked to subject
      → RED  reason=CRITICAL_FAILURE
3. currentVerifiedEvidence exists AND within validity:
      a. deadline within warning window (or due today) → AMBER reason=DUE_SOON|DUE_TODAY
      b. newer evidence PENDING_VERIFICATION           → AMBER reason=AWAITING_REVIEW
      c. otherwise                                     → GREEN
4. no current verified evidence:
      a. deadline passed / evidence expired            → RED  reason=OVERDUE|EXPIRED
      b. evidence PENDING_VERIFICATION or info missing → GREY reason=UNVERIFIED|MISSING
         (if requirement.blocking == DEPLOYMENT_CRITICAL, subject is also BLOCKED)
```

Rules:

- **Upload alone never yields GREEN.**
- Acknowledge/snooze affects notifications only — never `due_date` or status (ALERT-03).
- `GREY` is never counted as compliant.
- DBS: `review_date` is a **policy review date** (reason text says so); there is no
  `expiry_date` for DBS certificates (HR-02).

### Warning windows (ALERT-02)

Defaults `[90, 60, 30, 14, 7]` days, configurable per requirement template; these are
product defaults, labelled "not CQC rules". AMBER when `0 <= daysUntil <= maxWindow`
for that template (default 30 for dashboard "Due in 30 days" tile).

### Recurrence types

| Type               | Next due computed from                                | Notes                                            |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------ |
| `FIXED_CALENDAR`   | previous **scheduled** due date + interval            | Late completion does **not** shift timetable     |
| `COMPLETION_BASED` | completion date + interval                            |                                                  |
| `MILEAGE`          | last service odometer + threshold                     | Combined with date: **whichever first** (FLT-02) |
| `EVENT_TRIGGERED`  | event (role change, incident, policy material change) | Creates new instance                             |
| `PER_SHIFT`        | each shift/vehicle                                    | VDI, cleaning                                    |

Due-date edits store old value, new value, reason, approver (immutable `due_date_change`).

## 3. Subject readiness (staff, vehicle, equipment)

```
readiness(subject, window) = {
  state: READY | BLOCKED | RESTRICTED,
  checks: [{ code, result: PASS|FAIL|PENDING, reasonText, requirementInstanceId? }]
}
```

- **Staff**: lifecycle `ACTIVE`; not suspended; role approved for required role; all
  DEPLOYMENT_CRITICAL requirements GREEN/AMBER-valid across window; licence category
  covers vehicle; competencies required by job present and valid; restrictions honoured.
- **Vehicle**: no open CRITICAL/stop-use defect; insurance, tax, MOT/test valid across
  window; maintenance not overdue by date or mileage; not quarantined; capability
  (wheelchair, stretcher, restraint) derived from non-quarantined attached equipment.
- **Equipment**: each applicable regime (LOLER thorough exam, servicing, calibration)
  valid across window; not quarantined. No blanket expiry across asset types.

## 4. Allocation validation (JOB-02, JOB-03) — wireframe 04 "Validate assignment"

Run on allocate, on dispatch/offer, and at shift start. Returns ordered checks:

| Code                  | PASS when                                                        | Overridable?                                                         |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `STAFF_CLEARANCE`     | every assigned staff READY for their role across job window      | **No**                                                               |
| `LICENCE`             | driver licence valid & category correct across window            | **No**                                                               |
| `COMPETENCE`          | job-required skills (e.g. bariatric, wheelchair restraint) valid | Policy only*                                                         |
| `VEHICLE_ROADWORTHY`  | no critical defect; insurance/tax/MOT valid                      | **No**                                                               |
| `VEHICLE_SUITABILITY` | seats, wheelchair/stretcher capacity, permitted load fit job     | **No**                                                               |
| `EQUIPMENT`           | required equipment present, not quarantined, in-date             | **No** if safety-critical                                            |
| `TIME_CONFLICT`       | no overlap for vehicle or staff incl. travel buffer & breaks     | **No**                                                               |
| `SHIFT_GATE`          | shift VDI PASS + cleaning confirmed for this vehicle & shift     | **No** (PENDING before shift start is allowed for future allocation) |

\* Policy exceptions only where the requirement's `blocking` is `POLICY` (not
`STATUTORY` or `SAFETY_CRITICAL`): needs named approver with permission
`allocation.exception.approve`, reason, expiry, and is audit-logged. There is **no API path**
to override `STATUTORY` or `SAFETY_CRITICAL` failures.

Concurrency: allocation runs in a `SERIALIZABLE` transaction (or with Postgres
`EXCLUDE USING gist (resource_id WITH =, tstzrange(start,end) WITH &&)` on
`resource_booking`) so two dispatchers cannot book the same resource.

## 5. Shift start gate (FLT-04, FLT-05, UAT-03)

Crew cannot start shift on vehicle V until: (a) VDI for V + shift submitted with no
failed critical item, (b) pre-shift cleaning confirmed, (c) staff readiness re-validated.
Vehicle swap ⇒ new VDI + cleaning for the replacement vehicle. A failed critical VDI item
creates a CRITICAL defect, blocks V, and alerts control.

## 6. Defect effects (FLT-06)

On defect create with `severity=CRITICAL` or `stopUse=true`: in one transaction set vehicle
`BLOCKED`, find all future allocations for V, mark them `NEEDS_REASSIGNMENT`, raise alerts
to control. `MINOR` defects need authorised classification + repair deadline. Repair
completion ≠ return to service; release requires `fleet.return_to_service` permission.

## 7. Alerts and notifications (ALERT-03, ALERT-04)

- Alerts are **derived** from source state (recomputed), stored with reason, severity, owner.
- Recalculate on: record change, allocation, shift start, and scheduled reconciliation
  (every 15 min + nightly full sweep at 02:00 Europe/London).
- Notification delivery: deduplicated by `(alertId, channel, windowDay)`, logged, retried
  with backoff; escalate to deputy when owner absent, then to manager.
- Dashboard counts: overdue, due soon, unverified, blocked — separate numbers. A module with
  any critical RED is shown RED.
- Evidence coverage (if enabled) = verified current applicable ÷ applicable; show
  numerator, denominator, exclusions; label "Internal measure — not a CQC rating".

## 8. Test vectors (must exist as unit tests)

| #   | Scenario                                                 | Expected                                                 |
| --- | -------------------------------------------------------- | -------------------------------------------------------- |
| T1  | Due date 2026-10-29, now 2026-10-29 23:30 London         | AMBER `DUE_TODAY`                                        |
| T2  | Due 2026-10-29, now 2026-10-30 00:00:01 London           | RED `OVERDUE`                                            |
| T3  | Due 2026-10-25 (DST end), now 2026-10-25 23:59 BST→GMT   | still due today                                          |
| T4  | Due 2027-03-28 (DST start), now 2027-03-28 23:59         | still due today                                          |
| T5  | Annual from 2028-02-29                                   | next 2029-02-28                                          |
| T6  | Monthly anchor 31 Jan                                    | 28/29 Feb, 31 Mar, 30 Apr                                |
| T7  | Fixed calendar due 1 Oct, completed 10 Oct, 3-monthly    | next 1 Jan (not 10 Jan)                                  |
| T8  | Licence expires 12 Nov; job 12 Nov 22:00–23:30           | PASS                                                     |
| T9  | Licence expires 12 Nov; job 12 Nov 23:30–13 Nov 00:30    | FAIL `LICENCE`                                           |
| T10 | Renewed licence uploaded, old expired, not verified      | GREY, staff BLOCKED for driving                          |
| T11 | Renewed licence uploaded, old still valid                | AMBER `AWAITING_REVIEW`, still allocatable               |
| T12 | Service due 10,000 mi or 1 Dec; odometer 10,050 on 1 Nov | RED overdue (mileage)                                    |
| T13 | Odometer reading lower than previous                     | flag `ODOMETER_DECREASED`                                |
| T14 | Critical defect on AMB-03 with 2 future jobs             | vehicle BLOCKED, 2 jobs NEEDS_REASSIGNMENT               |
| T15 | Two concurrent allocations of AMB-01 same slot           | exactly one succeeds                                     |
| T16 | Snooze alert 7 days                                      | status unchanged, notifications paused                   |
| T17 | DBS with review date passed                              | RED with text "policy review date passed", not "expired" |
| T18 | Requirement N/A approved                                 | excluded from coverage denominator, listed in exclusions |
