# ADR 0006: Local username and password sign-in (local and pilot use)

Status: Accepted (6 Nov 2026). An approved exception to ADR 0003 for local development and
pilots before the Entra External ID tenant exists. **Entra External ID remains the production
target**; this mode is switched off unless `AUTH_MODE=local`.

## Context

ADR 0003 says we hold no passwords. Until the Entra tenant is configured, the only sign-in is the
development pick-a-user page, which checks nothing. Pilot users and realistic testing need a
genuine credential check, MFA for privileged roles (SEC-01, WORKFLOWS A1) and the same
authorisation model (roles and permissions from the database, never from the token).

## Decision

- `AUTH_MODE` (API) / `VITE_AUTH_MODE` (web): `dev` (default, unchanged), `local` (this ADR),
  `entra` (unchanged placeholder).
- Credentials live in `local_credential` (migration 0038): one row per `app_user`, username = the
  user's email (lower case, unique). Not a tenant table; rows are invisible unless the transaction
  sets `app.local_auth = 'on'`, which only the local-auth service does. No list endpoint reads it.
- Hashing: scrypt (node:crypto), per-user 16-byte salt, N=2^15 r=8 p=1, 64-byte key, stored as
  `scrypt$N$r$p$salt$hash`, compared with `timingSafeEqual`. Policy: at least 12 characters, not
  the username, not on a short common-password list (shared in `@hub/contracts`).
- MFA: RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits, ±1 step), required when any current role is in
  `MFA_REQUIRED_ROLES`. Secrets are AES-256-GCM encrypted with `FIELD_ENCRYPTION_KEY`. The last
  accepted step is stored, so a code is never accepted twice. First sign-in without TOTP leads to
  enrolment (secret and `otpauth://` URI shown once as text).
- Steps: `POST /auth/login` returns a token or a single-use challenge (5 minutes, stored only as a
  SHA-256 hash, in memory) for `mfa/verify`, `mfa/setup` or `forced-password-change`. Order: MFA
  before a forced password change, so a temporary password alone never changes the password of an
  account that has a second factor.
- Tokens: ES256 (or RS256) JWTs signed by the API, issuer `healthcare-hub-local`, audience
  `OIDC_AUDIENCE`, 15 minutes, `sub = local|<userId>`, `email`, `email_verified`, `amr` `['pwd']`
  or `['pwd','otp']`. In local mode the API trusts **only** this issuer (the mock OIDC server
  also refuses to mint), and HubGuard binds the token to the user id directly; `idp_subject` is
  untouched so Entra can link the same people later. Key from `LOCAL_AUTH_PRIVATE_KEY`
  (required in production); generated at start-up in development.
- Refresh tokens (migration 0039, `local_refresh_token`, same `app.local_auth` rule as the
  credential table): an opaque 32-byte random token in an `HttpOnly; SameSite=Strict` cookie
  scoped to `/api/v1/auth` (`Secure` except plain-http development); only its SHA-256 is stored.
  30 minutes idle, 12 hours absolute (a long shift, then sign in again). Rotated on every
  `POST /auth/refresh`; reusing a rotated token revokes the whole family and audits
  `auth.refresh.reuse` (theft detection). Each refresh re-checks access and MFA for the current
  roles, and keeps the family's `amr`. All of a person's refresh tokens are revoked on a
  password change (the changing session gets a new family), an administrator password reset, an
  MFA reset, revoked access and an immediate leaver transition (`revoke_local_refresh_tokens()`
  is how code outside the local-auth service does this). `POST /auth/logout` is public so it works
  with an expired access token; it revokes the family in the cookie and clears it. No cookie
  plugin: the API reads and writes this one cookie itself.
- Web: access tokens in memory only; only the username is kept in sessionStorage. The refresh
  cookie is invisible to scripts. An expired access token is renewed on demand, and at start-up
  the app tries a silent refresh, so a reload keeps the session. Refreshes are serialised in a
  tab and across tabs (Web Locks), because a second use of the same token ends the session.
- Administrators (`admin.users.manage`) can reset another member's MFA
  (`POST /admin/users/{id}/mfa-reset`, reason required and audited as `auth.mfa.reset`): the
  TOTP secret is removed, their refresh sessions end, and they enrol again at the next sign-in.
  Never one's own (403); outside the organisation 404.
- Administrators (`admin.users.manage`) can issue a one-time temporary password for a current
  member of their organisation (never themselves); it must be changed at the next sign-in. This
  is also how a newly invited user gets a first password in local mode.

## Security choices

- **Same reply for unknown user and wrong password**: `Username or password is incorrect.` (401).
  Unknown usernames get a dummy scrypt so timing matches.
- **Lockout**: 5 consecutive wrong passwords lock the account for 15 minutes; success resets the
  count; attempts during a lock are not counted (a lock cannot be extended forever by someone
  else). While locked, every attempt (right or wrong password) gets only `Too many attempts. Try
again later.` and never says whether the password was right. To stop that message revealing
  which usernames exist, the same lockout is mirrored in memory for usernames that do not exist.
- **Per-IP limit**: 20 attempts per 15 minutes across login, MFA set-up/verify and password
  changes (429, same wording). In memory, per API instance.
- **Access ended**: `Your access to this organisation has ended.` is shown only after a correct
  password (status not ACTIVE/INVITED, or no current membership or support grant).
- **Audit**: `auth.login.success`, `auth.login.failure` (username as a keyed hash, reason, never
  the password), `auth.mfa.enrol`, `auth.mfa.failure`, `auth.password.change`,
  `auth.password.reset`, `auth.logout`, `auth.refresh.reuse`, `auth.mfa.reset`. Successful
  refreshes are not audited (the sign-in that started the family is). The audit log is per
  organisation and sign-in comes before an organisation is chosen, so each event is written to every organisation the person currently
  belongs to (all past ones for a refused ended account). Unknown usernames have no organisation:
  they go to the application log only (hashed username and IP). Passwords, hashes, codes and
  secrets are never logged.

## Consequences

- We now hold password hashes in local/pilot deployments: they fall under the DSPT access-control
  evidence and must be deleted (with the table) when the deployment moves to Entra.
- Challenges, the IP limit and the unknown-username lockout are in memory: a multi-instance
  deployment needs sticky sessions or a shared store before using this mode.
- An administrator password reset does not remove TOTP; a lost authenticator is handled by the
  separate MFA reset. After an MFA reset, the password alone is enough to enrol a new
  authenticator, so the administrator must check the person's identity first.
- Revoking refresh tokens does not recall access tokens already issued: they stay valid for up
  to 15 minutes.
- The refresh cookie needs web and API on the same site (SameSite=Strict).
- `local_refresh_token` rows are revoked, never deleted; a purge of old rows is a later task.
- The crew mobile app still signs in through OIDC, so it is not usable in local mode.
