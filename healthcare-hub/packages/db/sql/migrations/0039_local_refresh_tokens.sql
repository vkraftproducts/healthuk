-- 0039: refresh tokens for local username + password sign-in (AUTH_MODE=local; ADR 0006).
-- Forward-only.
--
-- The browser holds an opaque random refresh token in an HttpOnly cookie; only its SHA-256 hash is
-- stored here. Tokens are single use: each refresh marks the presented token used, links it to its
-- replacement and issues a new one in the same family. Presenting a token that was already used
-- (theft or replay) revokes the whole family. Lifetimes: 30 minutes idle (each token), 12 hours
-- absolute (the family, from the password sign-in).
--
-- Like local_credential this is NOT a tenant table (a person can belong to several organisations):
-- no organisation_id, and every row is invisible unless the transaction switched on the local
-- sign-in context (app.local_auth = 'on'), which only the local-auth service does. Other code
-- (revoke access, leaver) uses revoke_local_refresh_tokens() below.

CREATE TABLE local_refresh_token (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  token_hash         text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id            uuid NOT NULL REFERENCES app_user(id),
  family_id          uuid NOT NULL,
  -- The sign-in that started the family included a TOTP code (access tokens carry amr pwd+otp).
  mfa                boolean NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Idle expiry of this token; never later than the family's absolute expiry.
  expires_at         timestamptz NOT NULL,
  family_expires_at  timestamptz NOT NULL,
  used_at            timestamptz,
  replaced_by        uuid REFERENCES local_refresh_token(id),
  revoked_at         timestamptz,
  revoked_reason     text CHECK (revoked_reason IN ('LOGOUT', 'REUSE', 'EXPIRED', 'PASSWORD_CHANGE',
                                                    'PASSWORD_RESET', 'MFA_RESET', 'MFA_REQUIRED',
                                                    'ACCESS_ENDED')),
  CHECK (expires_at <= family_expires_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (replaced_by IS NULL OR used_at IS NOT NULL)
);
CREATE UNIQUE INDEX local_refresh_token_hash_idx ON local_refresh_token (token_hash);
CREATE INDEX local_refresh_token_family_idx ON local_refresh_token (family_id);
CREATE INDEX local_refresh_token_user_live_idx ON local_refresh_token (user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE local_refresh_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_refresh_token FORCE ROW LEVEL SECURITY;
CREATE POLICY local_auth_only ON local_refresh_token
  USING (app_local_auth()) WITH CHECK (app_local_auth());

-- No DELETE: rows are revoked, never removed by the application.
GRANT SELECT, INSERT, UPDATE ON local_refresh_token TO hub_app;

-- Revokes every live refresh token of a person (returns how many). Callable outside the local
-- sign-in context, but only for oneself or for someone who has (or had) a membership in the
-- organisation of the current request; anyone else is left untouched (returns 0). The local
-- sign-in context is switched on for the duration of the function only and restored before it
-- returns, never left on for the rest of the caller's transaction. (A SET clause for a custom
-- setting is refused for non-superuser migration roles, so it is switched by set_config.)
CREATE FUNCTION revoke_local_refresh_tokens(p_user uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_org uuid := app_org_id();
  v_prev text := coalesce(current_setting('app.local_auth', true), '');
  v_n integer;
BEGIN
  IF NOT (
    p_user = app_user_id()
    OR (v_org IS NOT NULL AND EXISTS (
      SELECT 1 FROM membership m WHERE m.organisation_id = v_org AND m.user_id = p_user))
  ) THEN
    RETURN 0;
  END IF;
  PERFORM set_config('app.local_auth', 'on', true);
  BEGIN
    UPDATE local_refresh_token SET revoked_at = now(), revoked_reason = p_reason
     WHERE user_id = p_user AND revoked_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.local_auth', v_prev, true);
    RAISE;
  END;
  PERFORM set_config('app.local_auth', v_prev, true);
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION revoke_local_refresh_tokens(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_local_refresh_tokens(uuid, text) TO hub_app;
