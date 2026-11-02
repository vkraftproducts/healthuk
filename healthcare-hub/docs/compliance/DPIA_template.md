# Data Protection Impact Assessment (draft)

> **Status: DRAFT prepared by the build team.** The data controller (the provider organisation) must
> complete, review with its DPO/IG lead and sign this **before any real personal data is loaded**
> (SEC-02). Sections marked _[Controller]_ need the organisation's own answers.

## 1. The processing

Healthcare Hub supports an independent ambulance / patient transport service: staff readiness and
compliance, fleet and equipment safety, audits, policies, events and complaints, work planning and
the crew app. The provider is the **controller**; the platform supplier is a **processor**.

## 2. Data inventory

| Category                         | Examples                                                                                                    | People                  | Special category / criminal                      | Where                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Staff identity and employment    | name, staff number, role approvals, lifecycle, location                                                     | staff                   | no                                               | Postgres                                                        |
| Staff checks and training        | DBS outcome and certificate number (encrypted), licence, right to work, training, OH clearance, supervision | staff                   | criminal offence data (DBS); health (OH)         | Postgres (field-encrypted where marked), evidence files in Blob |
| Patient transport                | patient reference, name and phone (contact), pickup/destination, mobility, escorts, access notes            | patients                | health-related (mobility, infection precautions) | Postgres; crew device cache (encrypted, shift window only)      |
| Events, complaints, safeguarding | descriptions, outcomes, candour decisions                                                                   | patients, staff, others | may include health and safeguarding              | Postgres (restricted rows)                                      |
| Operational                      | VDIs, defects, fuel, shifts, job status with device time                                                    | staff                   | no                                               | Postgres                                                        |
| Account and security             | email, display name, identity-provider subject, device ids, push tokens, audit log                          | users                   | no                                               | Postgres, Entra External ID                                     |

No diagnosis, medication or clinical record fields exist (MOBILE_APP, PRD out-of-scope list).

## 3. Data flows

```
Browser (staff, control) ──TLS──▶ API (Azure Container Apps, UK South) ──▶ Postgres (UK South; backups UK West)
Crew app (iOS/Android) ──TLS──▶ API              └──▶ Blob storage (quarantine → evidence; GRS UK West)
Entra External ID ◀── sign-in (OIDC + PKCE, MFA)
Worker ──▶ email (Azure Communication Services): generic text + link, no personal data
Worker ──▶ Expo push service ──▶ Apple/Google: type + opaque id + generic text only
Exports (evidence pack, management pack, full export, SAR) ──▶ requester only, 5-minute signed link, audited
```

- Crew devices hold assigned shift data in an encrypted database (SQLCipher, key in the device
  secure store) until end of shift + 12 h; patient contact details only until the shift ends.
  Devices are wiped on sign-out, revocation, leaver status or five failed unlocks.
- Logs and telemetry carry ids, never names or patient data (redaction, lint rule).

## 4. Lawful basis _[Controller to confirm]_

| Category                         | Proposed basis                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Employment and checks            | Art 6(1)(b)/(c); Art 9(2)(b); DPA 2018 Sch 1 Part 1 para 1; criminal offence data: Sch 1 conditions and the DBS Code of Practice |
| Patient transport                | Art 6(1)(e) or (b)/(f) depending on contract with the commissioner; Art 9(2)(h)                                                  |
| Events, complaints, safeguarding | Art 6(1)(c)/(e); Art 9(2)(h)/(g); DPA 2018 Sch 1 para 18 (safeguarding)                                                          |

Consent is not used as the basis for employee or clinical records.

## 5. Risks and controls

| Risk                                     | Controls in the build                                                                                                                       | Residual _[Controller]_ |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| One organisation seeing another's data   | Tenant id on every row, Postgres FORCE row-level security, scoped database client, automated isolation tests for every endpoint             |                         |
| Staff seeing more than their role needs  | Server-side permission on every endpoint, restrictive policies for sensitive staff records, patient contacts, safeguarding, privacy records |                         |
| Patient data on lost phones              | Encrypted cache, short TTL, device revocation and remote wipe, screenshot blocking on patient screens                                       |                         |
| Disclosure through notifications or logs | Generic push and email text; no personal data in URLs, logs or the audit trail                                                              |                         |
| Unauthorised change or loss of history   | Append-only records, hash-chained audit log verified nightly, immutable anchors, PITR backups (35 days)                                     |                         |
| Keeping data too long                    | Retention schedule (approval required), legal holds, retention log                                                                          |                         |
| Breach not reported in time              | Breach records with the 72-hour ICO clock and alerts                                                                                        |                         |

## 6. Subprocessors

Microsoft Azure (hosting, Entra External ID, Communication Services) – UK South/UK West; Apple and
Google (push delivery; no personal data in payloads); Expo (push relay and app builds; no production
data); GitHub (source code only). _[Controller: confirm the Entra tenant data location at creation.]_

## 7. Sign-off _[Controller]_

| Role                              | Name | Decision | Date |
| --------------------------------- | ---- | -------- | ---- |
| DPO / IG lead                     |      |          |      |
| Registered manager                |      |          |      |
| Caldicott guardian (if appointed) |      |          |      |
