# Security, privacy and compliance

Requirement IDs: SYS-01, SEC-01..04, NFR-01, INT-02. Applicable frameworks the build must
make achievable: **UK GDPR & Data Protection Act 2018**, **NHS Data Security and Protection
Toolkit (DSPT)** (needed for NHS-commissioned transport work), **Cyber Essentials / Plus**,
**NCSC Cloud Security Principles**, **WCAG 2.2 AA**, CQC Regulation 17 (record keeping).
Not in scope unless clinical decision support/NHS integration is added: DCB0129/DCB0160,
UK MDR (INT-02).

## 1. Authentication

- Entra External ID, OIDC Authorization Code + PKCE (web and mobile). No passwords stored by us.
- MFA mandatory for roles: DIRECTOR, REGISTERED_MANAGER, HR_LEAD, GOVERNANCE_LEAD,
  ORG_ADMIN, AUDITOR, PLATFORM_SUPPORT. API checks `amr`/`acr` claim; returns 403
  `MFA_REQUIRED` otherwise.
- Access token 15 min; refresh rotation; web refresh via secure httpOnly SameSite=strict
  cookie on API domain (BFF-style) — tokens never in localStorage.
- Mobile: tokens in expo-secure-store (Keychain/Keystore); device session row; remote revoke.
- Leaver/suspension: revoke all sessions and device sessions immediately; API checks
  `user.status` and `device_session.revoked_at` on every request (cached ≤ 30 s).

## 2. Authorisation (RBAC + scope)

Permission keys are `module.resource.action`. Scope = organisation + location set.
Default matrix (org admins may customise within limits; restricted permissions cannot be
granted to DISPATCHER or CREW roles):

| Permission (examples)               | Mgr | HR  | Disp           | Fleet | Prem | Gov/IPC      | Crew                | Auditor    |
| ----------------------------------- | --- | --- | -------------- | ----- | ---- | ------------ | ------------------- | ---------- |
| dashboard.view                      | ✓   | ✓   | ✓              | ✓     | ✓    | ✓            | –                   | ✓(ro)      |
| staff.profile.view_basic            | ✓   | ✓   | clearance only | –     | –    | ✓            | self                | scope      |
| staff.sensitive.view (DBS, OH, NOK) | ✓   | ✓   | ✗              | ✗     | ✗    | ✗            | self (own, limited) | ✗          |
| staff.approve_role                  | ✓   | ✓   | ✗              | ✗     | ✗    | ✗            | ✗                   | ✗          |
| fleet.vehicle.manage                | ✓   | –   | view           | ✓     | –    | view         | assigned            | ro         |
| fleet.return_to_service             | ✓   | –   | ✗              | ✓     | –    | –            | ✗                   | ✗          |
| compliance.audit.run                | ✓   | –   | –              | –     | –    | ✓            | –                   | ro         |
| compliance.action.verify            | ✓   | –   | –              | –     | –    | ✓            | ✗                   | ✗          |
| jobs.booking.manage                 | ✓   | –   | ✓              | –     | –    | –            | ✗                   | ✗          |
| jobs.patient.view                   | ✓   | ✗   | ✓              | ✗     | ✗    | case-by-case | assigned only       | ✗          |
| allocation.exception.approve        | ✓   | –   | ✗              | –     | –    | –            | ✗                   | ✗          |
| export.evidence_pack                | ✓   | –   | –              | –     | –    | ✓            | ✗                   | if granted |
| admin.requirements.publish          | ✓   | –   | –              | –     | –    | ✓            | ✗                   | ✗          |

- Crew can read a job's patient fields **only** while assigned and within shift window
  ±2 h (UAT-05). Altered IDs return 404 (not 403) to avoid enumeration.
- Auditor access: time-limited grant with explicit evidence scope; exports need separate flag.
- Break-glass support: `support_access_grant` approved by org manager, max 8 h, all
  actions audited and visible to the org.

## 3. Tenant isolation (defence in depth)

1. Context interceptor validates org/location against memberships.
2. All Prisma calls via `withTenant()`; ESLint rule bans importing the raw client in
   `apps/api/src/modules/**`.
3. Postgres RLS + FORCE RLS on all tenant tables; app role not owner.
4. Blob keys prefixed `org/{orgId}/...`; SAS issued only after permission check; ≤ 5 min,
   read-only, single blob, `Content-Disposition: attachment`.
5. Search, reports, exports and background jobs carry explicit org context.
6. Automated isolation test suite runs every endpoint with a foreign-org token (TEST_PLAN §4).

## 4. Data protection

- Encryption: TLS 1.2+ everywhere; Azure storage/DB encryption at rest (platform-managed
  keys; CMK optional later). Extra app-level encryption (AES-256-GCM, key in Key Vault) for:
  DBS certificate number, NI number if stored, patient phone numbers.
- Minimisation: patient = identifier + necessary transport info only; weight only when relevant;
  free-text fields have warnings and length limits; no diagnosis fields.
- **No PII** in logs/telemetry/push/email/URLs. Pino logger with redaction paths; OTel
  attribute filter; App Insights sampling; error responses never echo payloads.
- Push payload: `{ "type": "JOB_UPDATED", "id": "<uuid>" }` + generic text "You have an update".
- Email reminders: generic ("You have 2 items due") + link to app.
- Mobile cache: assigned data only, encrypted, TTL (end of shift + 12 h), wiped on
  sign-out/revocation.
- Retention: `retention_rule` per record category, configured from org's approved schedule
  (defaults are placeholders flagged "requires approval"); legal hold blocks deletion;
  deletion is logged. Workflows for SAR export, rectification, erasure (where lawful),
  disclosure log, breach record (72 h ICO clock tracked as a reporting obligation).
- DPIA must be completed before production data is loaded (SEC-02). Template in
  `docs/compliance/DPIA_template.md` (create in M7) pre-filled with data flows.
- Lawful bases documented per category (employment: Art 6(1)(b)/(c); special category:
  Art 9(2)(b)/(h); criminal offence data: DPA 2018 Sch 1 conditions). Consent is not used
  as the basis for employee or clinical records.

## 5. Files and uploads

Upload flow: client requests upload → API checks permission, size (≤ 20 MB), declared
type allow-list (pdf, jpg, png, heic, docx, xlsx, csv) → returns write-only SAS to
`quarantine/` → Defender for Storage scans → Event Grid/poller moves CLEAN files to
`evidence/` and checks magic bytes → `scan_status` updated → malicious files deleted and
alert raised. Unscanned files are never downloadable.

## 6. Audit trail (SEC-03)

Events logged: sign-in, MFA failures, sensitive views (DBS/OH/safeguarding/patient), all
exports & downloads, approvals/verifications, rule/requirement/template changes, role and
permission changes, due-date changes, allocation exceptions, support access, deletions.
Hash chain: `hash = sha256(prev_hash || canonical_json(event))`, per org sequence; daily
head anchored to WORM blob; verification job alerts on chain break. Audit viewer for
managers; export of audit log itself is audited.

## 7. Application security baseline

OWASP ASVS L2 as target. Helmet/security headers + strict CSP on web; CSRF protection on
cookie routes; rate limiting per user/IP; input validation via zod on every route; output
encoding; SSRF-safe (no user-supplied URLs fetched); dependency scanning (Dependabot +
`pnpm audit`) and CodeQL in CI; secret scanning; container image scan; least-privilege
managed identities; no secrets in repo (`.env.example` only). Independent penetration test
before go-live (SEC-04).

## 8. Hosting and subprocessors (SEC-04)

All primary data in Azure UK South; backups/geo-replicas in UK West. Subprocessors to list
in the DPIA/ROPA: Microsoft Azure (hosting, Entra External ID, email), Apple/Google push
(no personal data in payloads), Expo (push relay, build service; no production data),
GitHub (source code only). Confirm Entra External ID tenant data location at tenant
creation and record it.

## 9. Compliance deliverables the build must produce (M7)

DPIA draft data-flow section · ROPA entries · retention schedule config · Cyber Essentials
evidence (patching, MFA, firewall, malware, access control) · DSPT evidence map ·
restore drill report · pen test remediation log · accessibility statement.
