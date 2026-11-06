-- Email and push delivery of escalations (A6/A7, ALERT-04). Forward-only.
--
-- notification_outbox: one row per (escalation, recipient, channel), written by the worker when an
-- alert reaches the lead or registered manager stage and drained by the worker with retries and
-- backoff. Content is generic text and an opaque in-app path only: never patient data, names or
-- record titles (non-negotiable 7).
-- push_device: Expo or Web Push registrations made by a person for themselves.
-- notification_preference: a person's own email and push switches (default both on).

CREATE TABLE notification_outbox (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id    uuid NOT NULL REFERENCES organisation(id),
  alert_id           uuid NOT NULL,
  escalation_stage   text NOT NULL CHECK (escalation_stage IN ('LEAD', 'MANAGER')),
  recipient_user_id  uuid NOT NULL REFERENCES app_user(id),
  channel            text NOT NULL CHECK (channel IN ('EMAIL', 'PUSH')),
  -- `<alert>:<stage>:<recipient>:<channel>`: queuing the same escalation twice is harmless.
  idempotency_key    text NOT NULL CHECK (length(idempotency_key) <= 200),
  subject            text NOT NULL CHECK (length(subject) <= 200),
  body               text NOT NULL CHECK (length(body) <= 1000),
  link_path          text NOT NULL CHECK (link_path LIKE '/%' AND length(link_path) <= 200),
  status             text NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  attempts           int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  -- Short error codes from the transport only, never message content or addresses.
  last_error         text CHECK (last_error IS NULL OR length(last_error) <= 200),
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, idempotency_key),
  FOREIGN KEY (alert_id, organisation_id) REFERENCES alert (id, organisation_id),
  CHECK (status <> 'SENT' OR sent_at IS NOT NULL)
);
CREATE INDEX notification_outbox_due_idx
  ON notification_outbox (organisation_id, next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX notification_outbox_alert_idx
  ON notification_outbox (organisation_id, alert_id);
CREATE TRIGGER notification_outbox_updated BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE push_device (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  kind             text NOT NULL CHECK (kind IN ('EXPO', 'WEB_PUSH')),
  -- Expo push token, or the Web Push subscription endpoint (https).
  token            text NOT NULL CHECK (length(token) BETWEEN 10 AND 1000),
  p256dh           text CHECK (p256dh IS NULL OR length(p256dh) <= 200),
  auth_secret      text CHECK (auth_secret IS NULL OR length(auth_secret) <= 100),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  last_registered_at timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  CHECK (kind <> 'WEB_PUSH' OR token LIKE 'https://%')
);
-- A live token belongs to one person in an organisation; a re-registration moves it.
CREATE UNIQUE INDEX push_device_live_token_idx
  ON push_device (organisation_id, token) WHERE revoked_at IS NULL;
CREATE INDEX push_device_user_idx ON push_device (organisation_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE notification_preference (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  user_id          uuid NOT NULL REFERENCES app_user(id),
  email_enabled    boolean NOT NULL DEFAULT true,
  push_enabled     boolean NOT NULL DEFAULT true,
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,
  UNIQUE (organisation_id, user_id)
);
CREATE TRIGGER notification_preference_version BEFORE UPDATE ON notification_preference
  FOR EACH ROW EXECUTE FUNCTION bump_version();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_outbox', 'push_device', 'notification_preference'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;

-- Screens show devices and preferences; the outbox is worker-only (like push_message), so it does
-- not signal live changes (a drain would otherwise make every open screen refetch).
CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON push_device
  FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change();
CREATE TRIGGER live_change AFTER INSERT OR UPDATE OR DELETE ON notification_preference
  FOR EACH STATEMENT EXECUTE FUNCTION notify_org_change();

-- No DELETE anywhere: devices are revoked, outbox rows keep their delivery history.
GRANT SELECT, INSERT, UPDATE ON notification_outbox, push_device, notification_preference TO hub_app;
