# ADR 0003: Entra External ID

Status: Accepted. Decision: identity, MFA and sign-in via Microsoft Entra External ID
(OIDC + PKCE); roles/permissions/scopes stored in our DB. Consequences: no password
handling; free tier covers pilot MAU; IdP swap possible because authorisation is in-app.

Exception: ADR 0006 allows local username + password sign-in (`AUTH_MODE=local`) for local and
pilot use until the Entra tenant exists. Production still targets Entra External ID.
