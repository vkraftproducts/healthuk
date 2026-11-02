# Crew mobile app (Android & iOS)

Expo React Native, built with EAS. Distribution: managed (Apple Business Manager custom app
/ Google managed Play) preferred for company devices; TestFlight / internal track for pilot.
Source: wireframe 05, APP-01, APP-02, brief §9.

## Screens

1. **Sign in** — Entra External ID (PKCE), biometric unlock for returning sessions.
2. **My shift** — date, connectivity + "synced HH:MM" indicator, vehicle (AMB-01), crew
   names, gate cards: Driving clearance (APPROVED), Vehicle daily inspection (COMPLETE /
   REQUIRED), Pre-shift cleaning (REQUIRED) → "Complete cleaning confirmation". Banner
   "Shift start blocked until complete." Bottom tabs: Jobs | Policies | Messages; quick
   actions: Fuel receipt, Report defect.
3. **VDI** — checklist from template by vehicle type; each item Pass/Fail/N/A (+reason,
   photo on fail); odometer; submit. Failed critical item ⇒ defect created + control alerted.
4. **Cleaning confirmation** — type (pre-shift/between-patient/enhanced), method, confirm.
5. **Job detail** — pickup window, collection address, destination, mobility, escort,
   "Access and handover notes" (read current approved plan before moving patient),
   required equipment verified, actions: Confirm arrival, status progression buttons,
   Call control / report concern, Handover completion. Navigation hand-off to the device
   maps app (no in-app driving UI).
6. **Report defect** — vehicle/asset, severity guidance, description, photos, stop-use toggle.
7. **Fuel receipt** — photo, litres/kWh, amount, mileage.
8. **Policies & messages** — pending acknowledgements, critical instructions require explicit confirm.
9. **My profile** — own training/expiries, submitted documents, supervision/appraisal tasks.

## Safety behaviour

- No workflow requires interaction while driving: status changes are large single-tap
  actions intended for when stationary; no typing required mid-journey; show reminder text.
- Critical defect during an active journey: app shows "Contact control now" with one-tap
  call, sends alert; it never instructs abandoning a patient (APP-02).
- Only assigned patient details visible; disappear after shift window.

## Offline & sync (APP-01)

- Local encrypted DB (op-sqlite + SQLCipher; key in secure store).
- Outbox table: `{ clientSubmissionId (uuid v7), type, payload, capturedAt, attempts, state }`.
- Each item shows a **pending sync** badge; sync on connectivity regain, app foreground,
  and every 60 s while online; exponential backoff.
- Server enforces idempotency on `clientSubmissionId` → repeated sync creates one record
  (UAT-06); stores `captured_at` (device) and `received_at` (server).
- Conflicts (e.g. job reassigned while offline) return `CONFLICT` with server state; the app
  shows a reconciliation screen — never silent overwrite.
- Offline cannot: start a shift whose eligibility can't be verified within the last N
  minutes (configurable, default 30), accept new allocations, or grant clearance. Show
  "Follow downtime procedure — call control".
- Cache TTL: end of shift + 12 h; wiped on sign-out, revoke (on next contact), or 5 failed
  biometric attempts.

## Device security

Require OS passcode (check via expo-local-authentication); block rooted/jailbroken devices
where detectable (warn in pilot); screenshot prevention on patient screens (Android
FLAG_SECURE; iOS blur on app switcher); no patient data in notifications; certificate
pinning optional (decide in DECISIONS.md).

## Push notifications

Payload carries type + opaque ID only; text generic ("New job assigned", "Policy needs
acknowledgement"). Tap → app fetches details after auth.

## Testing

Unit (Jest), component (RN Testing Library), E2E (Maestro flows: shift gate, VDI fail,
offline sync duplicate, defect during journey). Test on low-end Android (2 GB RAM).
