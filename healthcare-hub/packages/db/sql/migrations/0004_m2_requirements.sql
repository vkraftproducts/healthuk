-- M2: requirements engine, evidence, alerts and notifications.
-- Forward-only. Every tenant table: organisation_id, RLS (FORCE), org-leading indexes.

CREATE TYPE requirement_subject_type AS ENUM ('STAFF', 'VEHICLE', 'EQUIPMENT', 'PREMISES', 'SERVICE', 'ORGANISATION');
CREATE TYPE template_version_status AS ENUM ('DRAFT', 'APPROVED', 'EFFECTIVE', 'SUPERSEDED');
CREATE TYPE requirement_basis AS ENUM ('STATUTORY', 'REGULATORY_GUIDANCE', 'ORG_POLICY', 'GOOD_PRACTICE');
CREATE TYPE requirement_blocking AS ENUM ('NONE', 'POLICY', 'DEPLOYMENT_CRITICAL', 'STATUTORY', 'SAFETY_CRITICAL');
CREATE TYPE applicability AS ENUM ('APPLICABLE', 'APPROVED_NOT_APPLICABLE');
CREATE TYPE rag_status AS ENUM ('RED', 'AMBER', 'GREEN', 'GREY', 'NOT_APPLICABLE');
CREATE TYPE scan_status AS ENUM ('PENDING', 'CLEAN', 'MALICIOUS', 'FAILED');
CREATE TYPE verification_decision AS ENUM ('ACCEPTED', 'REJECTED');
CREATE TYPE alert_state AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
CREATE TYPE alert_severity AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
CREATE TYPE notification_channel AS ENUM ('EMAIL', 'IN_APP', 'PUSH');
CREATE TYPE notification_status AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD');

-- ---------------------------------------------------------------------------
-- Templates (library rows have organisation_id NULL and are read-only to the app)
-- ---------------------------------------------------------------------------
CREATE TABLE requirement_template (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid REFERENCES organisation(id),
  pack             text NOT NULL DEFAULT 'CUSTOM',
  code             text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_\-]{1,59}$'),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid
);
CREATE UNIQUE INDEX requirement_template_code_idx
  ON requirement_template (coalesce(organisation_id, '00000000-0000-0000-0000-000000000000'::uuid), pack, code);
CREATE UNIQUE INDEX requirement_template_org_id_key ON requirement_template (id, organisation_id);

CREATE TABLE requirement_template_version (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id       uuid REFERENCES organisation(id),
  template_id           uuid NOT NULL REFERENCES requirement_template(id),
  version               int  NOT NULL CHECK (version >= 1),
  status                template_version_status NOT NULL DEFAULT 'DRAFT',
  basis_type            requirement_basis NOT NULL,
  regulation_ref        text,
  source_url            text,
  source_version_date   date,
  effective_from        date,
  effective_to          date,
  subject_type          requirement_subject_type NOT NULL,
  applicability_rule    jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_type         text NOT NULL DEFAULT 'DOCUMENT',
  recurrence            jsonb NOT NULL,
  warning_days          int[] NOT NULL DEFAULT '{90,60,30,14,7}',
  due_soon_days         int NOT NULL DEFAULT 30 CHECK (due_soon_days BETWEEN 0 AND 365),
  blocking              requirement_blocking NOT NULL DEFAULT 'NONE',
  approval_role         text,
  framework_mappings    jsonb NOT NULL DEFAULT '[]'::jsonb,
  deadline_kind         text NOT NULL DEFAULT 'DUE' CHECK (deadline_kind IN ('DUE', 'EXPIRY', 'REVIEW')),
  approved_by           uuid,
  approved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  UNIQUE (template_id, version)
);
CREATE UNIQUE INDEX requirement_template_version_effective_idx
  ON requirement_template_version (template_id) WHERE status = 'EFFECTIVE';
CREATE INDEX requirement_template_version_org_idx ON requirement_template_version (organisation_id, template_id);

-- A published version is immutable: only its lifecycle status (and effective_to) may move forward.
CREATE FUNCTION template_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Published requirement versions cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT', 'APPROVED', 'EFFECTIVE') THEN
      RAISE EXCEPTION 'A draft can only be published' USING ERRCODE = 'check_violation';
    END IF;
    -- Content may change while it is a draft, but never in the same statement that publishes it:
    -- the approver approves exactly what they saw.
    IF NEW.status <> 'DRAFT' AND
       (to_jsonb(NEW) - 'status' - 'effective_from' - 'approved_by' - 'approved_at')
       IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'effective_from' - 'approved_by' - 'approved_at') THEN
      RAISE EXCEPTION 'Content cannot change while publishing' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'effective_to' - 'effective_from' - 'approved_by' - 'approved_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'effective_to' - 'effective_from' - 'approved_by' - 'approved_at') THEN
    RAISE EXCEPTION 'Published requirement versions are immutable; create a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT ((OLD.status, NEW.status) IN (('APPROVED','EFFECTIVE'), ('EFFECTIVE','SUPERSEDED'), ('APPROVED','SUPERSEDED'), ('APPROVED','APPROVED'), ('EFFECTIVE','EFFECTIVE'), ('SUPERSEDED','SUPERSEDED'))) THEN
    RAISE EXCEPTION 'Invalid requirement version status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requirement_template_version_guard BEFORE UPDATE OR DELETE ON requirement_template_version
  FOR EACH ROW EXECUTE FUNCTION template_version_guard();

-- Four-eyes: the approver must not be the author.
CREATE FUNCTION template_version_four_eyes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('APPROVED', 'EFFECTIVE') AND OLD.status = 'DRAFT' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'Publishing needs an approver' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.created_by IS NOT NULL AND NEW.approved_by = NEW.created_by THEN
      RAISE EXCEPTION 'The approver must be different from the author' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requirement_template_version_four_eyes BEFORE UPDATE ON requirement_template_version
  FOR EACH ROW EXECUTE FUNCTION template_version_four_eyes();

-- ---------------------------------------------------------------------------
-- Instances
-- ---------------------------------------------------------------------------
CREATE TABLE requirement_instance (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id      uuid NOT NULL REFERENCES organisation(id),
  location_id          uuid,
  template_id          uuid NOT NULL REFERENCES requirement_template(id),
  template_version_id  uuid NOT NULL REFERENCES requirement_template_version(id),
  subject_type         requirement_subject_type NOT NULL,
  subject_id           uuid NOT NULL,
  owner_user_id        uuid REFERENCES app_user(id),
  deputy_user_id       uuid REFERENCES app_user(id),
  anchor_date          date,                    -- FIXED_CALENDAR timetable anchor
  due_date             date,
  expiry_date          date,
  review_date          date,
  applicability        applicability NOT NULL DEFAULT 'APPLICABLE',
  critical_failure     boolean NOT NULL DEFAULT false,
  status               rag_status NOT NULL DEFAULT 'GREY',
  reason_code          text NOT NULL DEFAULT 'MISSING',
  reason_text          text NOT NULL DEFAULT 'No verified evidence on record',
  effect               text NOT NULL DEFAULT 'NONE' CHECK (effect IN ('NONE', 'POLICY_BLOCK', 'BLOCK')),
  currently_verified   boolean NOT NULL DEFAULT false,
  computed_at          timestamptz,
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  CONSTRAINT instance_location_fk FOREIGN KEY (location_id, organisation_id) REFERENCES location (id, organisation_id)
);
CREATE UNIQUE INDEX requirement_instance_subject_idx
  ON requirement_instance (organisation_id, template_id, subject_type, subject_id);
CREATE UNIQUE INDEX requirement_instance_org_id_key ON requirement_instance (id, organisation_id);
CREATE INDEX requirement_instance_status_idx ON requirement_instance (organisation_id, status, due_date);
CREATE INDEX requirement_instance_subject_lookup_idx ON requirement_instance (organisation_id, subject_type, subject_id);
CREATE TRIGGER requirement_instance_version BEFORE UPDATE ON requirement_instance FOR EACH ROW EXECUTE FUNCTION bump_version();

-- The instance's template version must belong to its template and be visible to the org.
CREATE FUNCTION requirement_instance_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  SELECT template_id, organisation_id, subject_type INTO v FROM requirement_template_version WHERE id = NEW.template_version_id;
  IF v.template_id IS DISTINCT FROM NEW.template_id THEN
    RAISE EXCEPTION 'Template version does not belong to the template' USING ERRCODE = 'check_violation';
  END IF;
  IF v.organisation_id IS NOT NULL AND v.organisation_id <> NEW.organisation_id THEN
    RAISE EXCEPTION 'Template version belongs to another organisation' USING ERRCODE = 'check_violation';
  END IF;
  IF v.subject_type <> NEW.subject_type THEN
    RAISE EXCEPTION 'Subject type does not match the template' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER requirement_instance_checks_trg BEFORE INSERT OR UPDATE OF template_id, template_version_id, subject_type ON requirement_instance
  FOR EACH ROW EXECUTE FUNCTION requirement_instance_checks();

CREATE TABLE applicability_decision (        -- [immutable]
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  instance_id      uuid NOT NULL,
  decision         applicability NOT NULL,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  reviewer_id      uuid NOT NULL REFERENCES app_user(id),
  review_date      date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (instance_id, organisation_id) REFERENCES requirement_instance (id, organisation_id)
);
CREATE INDEX applicability_decision_idx ON applicability_decision (organisation_id, instance_id, created_at DESC);
CREATE TRIGGER applicability_decision_immutable BEFORE UPDATE OR DELETE ON applicability_decision FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE due_date_change (               -- [immutable]
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  instance_id      uuid NOT NULL,
  field            text NOT NULL CHECK (field IN ('DUE', 'EXPIRY', 'REVIEW')),
  old_date         date,
  new_date         date NOT NULL,
  reason           text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  approver_id      uuid NOT NULL REFERENCES app_user(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL,
  FOREIGN KEY (instance_id, organisation_id) REFERENCES requirement_instance (id, organisation_id)
);
CREATE INDEX due_date_change_idx ON due_date_change (organisation_id, instance_id, created_at DESC);
CREATE TRIGGER due_date_change_immutable BEFORE UPDATE OR DELETE ON due_date_change FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------
CREATE TABLE evidence_item (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  type             text NOT NULL DEFAULT 'DOCUMENT',
  retention_class  text NOT NULL DEFAULT 'STANDARD',
  sensitivity      text NOT NULL DEFAULT 'NORMAL' CHECK (sensitivity IN ('NORMAL', 'HR', 'CLINICAL', 'SAFEGUARDING', 'CRIMINAL_OFFENCE')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL
);
CREATE UNIQUE INDEX evidence_item_org_id_key ON evidence_item (id, organisation_id);
CREATE INDEX evidence_item_org_idx ON evidence_item (organisation_id, created_at DESC);

CREATE TABLE evidence_version (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  item_id          uuid NOT NULL,
  version_no       int  NOT NULL DEFAULT 1,
  blob_key         text NOT NULL,
  declared_mime    text NOT NULL,
  declared_size    bigint NOT NULL CHECK (declared_size BETWEEN 1 AND 52428800),
  mime             text,
  size_bytes       bigint,
  sha256           text,
  scan_status      scan_status NOT NULL DEFAULT 'PENDING',
  uploaded_at      timestamptz,                       -- set by /complete
  scanned_at       timestamptz,
  uploaded_by      uuid NOT NULL REFERENCES app_user(id),
  captured_at      timestamptz NOT NULL DEFAULT now(),
  valid_from       date,
  valid_to         date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, version_no),
  UNIQUE (organisation_id, blob_key),
  FOREIGN KEY (item_id, organisation_id) REFERENCES evidence_item (id, organisation_id),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX evidence_version_org_id_key ON evidence_version (id, organisation_id);
CREATE INDEX evidence_version_item_idx ON evidence_version (organisation_id, item_id, version_no DESC);

-- Evidence versions are immutable once written, except for the scan outcome, which is recorded once.
CREATE FUNCTION evidence_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Evidence versions cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'scan_status' - 'scanned_at' - 'uploaded_at' - 'mime' - 'size_bytes' - 'sha256')
     IS DISTINCT FROM (to_jsonb(OLD) - 'scan_status' - 'scanned_at' - 'uploaded_at' - 'mime' - 'size_bytes' - 'sha256') THEN
    RAISE EXCEPTION 'Evidence versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.scan_status <> 'PENDING' AND NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
    RAISE EXCEPTION 'Scan outcome already recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.uploaded_at IS NOT NULL AND (NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes) THEN
    RAISE EXCEPTION 'Upload checksum already recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_version_guard_trg BEFORE UPDATE OR DELETE ON evidence_version FOR EACH ROW EXECUTE FUNCTION evidence_version_guard();

CREATE TABLE evidence_link (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  item_id          uuid NOT NULL,
  instance_id      uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL,
  UNIQUE (item_id, instance_id),
  FOREIGN KEY (item_id, organisation_id) REFERENCES evidence_item (id, organisation_id),
  FOREIGN KEY (instance_id, organisation_id) REFERENCES requirement_instance (id, organisation_id)
);
CREATE INDEX evidence_link_instance_idx ON evidence_link (organisation_id, instance_id);

CREATE TABLE verification (                  -- [immutable]
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id       uuid NOT NULL REFERENCES organisation(id),
  evidence_version_id   uuid NOT NULL,
  decision              verification_decision NOT NULL,
  reason                text CHECK (reason IS NULL OR length(reason) <= 1000),
  reviewer_id           uuid NOT NULL REFERENCES app_user(id),
  confirmed_valid_to    date,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evidence_version_id),
  FOREIGN KEY (evidence_version_id, organisation_id) REFERENCES evidence_version (id, organisation_id),
  CHECK (decision = 'ACCEPTED' OR reason IS NOT NULL)
);
CREATE INDEX verification_org_idx ON verification (organisation_id, created_at DESC);
CREATE TRIGGER verification_immutable BEFORE UPDATE OR DELETE ON verification FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Segregation of duties + only clean files can be verified.
CREATE FUNCTION verification_checks() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  SELECT uploaded_by, scan_status INTO v FROM evidence_version WHERE id = NEW.evidence_version_id;
  IF v.uploaded_by = NEW.reviewer_id THEN
    RAISE EXCEPTION 'You cannot verify evidence you uploaded' USING ERRCODE = 'check_violation';
  END IF;
  IF v.scan_status <> 'CLEAN' THEN
    RAISE EXCEPTION 'Only scanned, clean evidence can be verified' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verification_checks_trg BEFORE INSERT ON verification FOR EACH ROW EXECUTE FUNCTION verification_checks();

-- ---------------------------------------------------------------------------
-- Alerts and notifications
-- ---------------------------------------------------------------------------
CREATE TABLE alert (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  source_type      text NOT NULL,
  source_id        uuid NOT NULL,
  severity         alert_severity NOT NULL,
  reason_code      text NOT NULL,
  reason_text      text NOT NULL,
  owner_user_id    uuid REFERENCES app_user(id),
  state            alert_state NOT NULL DEFAULT 'OPEN',
  snoozed_until    timestamptz,
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  raised_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alert_open_source_idx ON alert (organisation_id, source_type, source_id) WHERE state <> 'RESOLVED';
CREATE UNIQUE INDEX alert_org_id_key ON alert (id, organisation_id);
CREATE INDEX alert_state_idx ON alert (organisation_id, state, severity);
CREATE TRIGGER alert_version BEFORE UPDATE ON alert FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE TABLE notification_delivery (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id    uuid NOT NULL REFERENCES organisation(id),
  alert_id           uuid NOT NULL,
  channel            notification_channel NOT NULL,
  recipient_user_id  uuid NOT NULL REFERENCES app_user(id),
  dedupe_key         text NOT NULL,
  status             notification_status NOT NULL DEFAULT 'PENDING',
  attempts           int NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  escalated_to       text,
  last_error         text,
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, dedupe_key),
  FOREIGN KEY (alert_id, organisation_id) REFERENCES alert (id, organisation_id)
);
CREATE INDEX notification_due_idx ON notification_delivery (organisation_id, status, next_attempt_at);

-- Daily status counts for trends (written by the reconciler; the dashboard reads live values).
CREATE TABLE status_snapshot (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  snapshot_date    date NOT NULL,
  subject_type     requirement_subject_type NOT NULL,
  counts           jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, snapshot_date, subject_type)
);

-- Worker process: list organisations to reconcile without exposing the organisation table to
-- request handlers. Returns ids only.
CREATE FUNCTION worker_list_organisations() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM organisation WHERE archived_at IS NULL ORDER BY id
$$;
-- organisation has FORCE RLS, so the definer (table owner) needs an explicit read policy. It is
-- keyed on the *current user* being the table owner, which only a SECURITY DEFINER function can be:
-- hub_app can never satisfy it directly.
CREATE POLICY owner_enumerate ON organisation FOR SELECT
  USING (current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'organisation'::regclass));
REVOKE ALL ON FUNCTION worker_list_organisations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_list_organisations() TO hub_app;

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
ALTER TABLE requirement_template         ENABLE ROW LEVEL SECURITY; ALTER TABLE requirement_template         FORCE ROW LEVEL SECURITY;
ALTER TABLE requirement_template_version ENABLE ROW LEVEL SECURITY; ALTER TABLE requirement_template_version FORCE ROW LEVEL SECURITY;
ALTER TABLE requirement_instance         ENABLE ROW LEVEL SECURITY; ALTER TABLE requirement_instance         FORCE ROW LEVEL SECURITY;
ALTER TABLE applicability_decision       ENABLE ROW LEVEL SECURITY; ALTER TABLE applicability_decision       FORCE ROW LEVEL SECURITY;
ALTER TABLE due_date_change              ENABLE ROW LEVEL SECURITY; ALTER TABLE due_date_change              FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_item                ENABLE ROW LEVEL SECURITY; ALTER TABLE evidence_item                FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_version             ENABLE ROW LEVEL SECURITY; ALTER TABLE evidence_version             FORCE ROW LEVEL SECURITY;
ALTER TABLE evidence_link                ENABLE ROW LEVEL SECURITY; ALTER TABLE evidence_link                FORCE ROW LEVEL SECURITY;
ALTER TABLE verification                 ENABLE ROW LEVEL SECURITY; ALTER TABLE verification                 FORCE ROW LEVEL SECURITY;
ALTER TABLE alert                        ENABLE ROW LEVEL SECURITY; ALTER TABLE alert                        FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_delivery        ENABLE ROW LEVEL SECURITY; ALTER TABLE notification_delivery        FORCE ROW LEVEL SECURITY;
ALTER TABLE status_snapshot              ENABLE ROW LEVEL SECURITY; ALTER TABLE status_snapshot              FORCE ROW LEVEL SECURITY;

-- Library rows (organisation_id IS NULL) are visible to everyone and writable by no one via the app.
CREATE POLICY template_read ON requirement_template FOR SELECT
  USING (organisation_id IS NULL OR organisation_id = app_org_id());
CREATE POLICY template_write ON requirement_template FOR INSERT
  WITH CHECK (organisation_id = app_org_id());
CREATE POLICY template_version_read ON requirement_template_version FOR SELECT
  USING (organisation_id IS NULL OR organisation_id = app_org_id());
CREATE POLICY template_version_insert ON requirement_template_version FOR INSERT
  WITH CHECK (organisation_id = app_org_id());
CREATE POLICY template_version_update ON requirement_template_version FOR UPDATE
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY template_version_delete ON requirement_template_version FOR DELETE
  USING (organisation_id = app_org_id());

CREATE POLICY tenant_isolation ON requirement_instance
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON applicability_decision
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON due_date_change
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON evidence_item
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON evidence_version
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON evidence_link
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON verification
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON alert
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON notification_delivery
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY tenant_isolation ON status_snapshot
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());

GRANT SELECT, INSERT ON requirement_template TO hub_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON requirement_template_version TO hub_app;
GRANT SELECT, INSERT, UPDATE ON requirement_instance TO hub_app;
GRANT SELECT, INSERT ON applicability_decision, due_date_change, verification TO hub_app;      -- immutable
GRANT SELECT, INSERT ON evidence_item, evidence_link TO hub_app;
GRANT SELECT, INSERT, UPDATE ON evidence_version TO hub_app;                                    -- scan outcome only (trigger)
GRANT SELECT, INSERT, UPDATE ON alert, notification_delivery TO hub_app;
GRANT SELECT, INSERT, UPDATE ON status_snapshot TO hub_app;
