-- 0038: local username + password sign-in (AUTH_MODE=local; ADR 0006). Forward-only.
--
-- NOT a tenant table: a person can belong to several organisations, like app_user. There is no
-- organisation_id and no tenant policy. Instead the table is closed to every query unless the
-- transaction has explicitly switched on the local sign-in context (app.local_auth = 'on'), which
-- only the local-auth service in the API does. No list endpoint ever selects from it.
-- Passwords are stored only as scrypt hashes; TOTP secrets only AES-256-GCM encrypted.

CREATE TABLE local_credential (
  user_id                uuid PRIMARY KEY REFERENCES app_user(id),
  username               text NOT NULL CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 254),
  password_hash          text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  password_changed_at    timestamptz NOT NULL DEFAULT now(),
  failed_attempts        int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until           timestamptz,
  must_change_password   boolean NOT NULL DEFAULT false,
  totp_secret_encrypted  text CHECK (totp_secret_encrypted IS NULL OR totp_secret_encrypted LIKE 'enc:v1:%'),
  totp_enabled           boolean NOT NULL DEFAULT false,
  -- Last accepted TOTP time step: a code is never accepted twice (RFC 6238 §5.2).
  totp_last_step         bigint,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid,
  CHECK (NOT totp_enabled OR totp_secret_encrypted IS NOT NULL)
);
CREATE UNIQUE INDEX local_credential_username_idx ON local_credential (username);
CREATE TRIGGER local_credential_updated BEFORE UPDATE ON local_credential
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION app_local_auth() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.local_auth', true), '') = 'on'
$$;
GRANT EXECUTE ON FUNCTION app_local_auth() TO hub_app;

ALTER TABLE local_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_credential FORCE ROW LEVEL SECURITY;
CREATE POLICY local_auth_only ON local_credential
  USING (app_local_auth()) WITH CHECK (app_local_auth());

-- No DELETE: a credential is replaced by a reset, never removed by the application.
GRANT SELECT, INSERT, UPDATE ON local_credential TO hub_app;
