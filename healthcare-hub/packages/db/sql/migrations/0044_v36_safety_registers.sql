-- v36 batch 1 (17 Nov 2026): safeguarding referrals register, vehicle accidents and damage,
-- vehicle medicines and medical gases stock, controlled drug balance checks. Forward-only and
-- additive: no existing table is changed.

-- ---------------------------------------------------------------------------------------------
-- Safeguarding referrals (v36 screen 37). One row per concern; the referral to the local
-- authority, a decision not to refer, and the outcome are recorded on it. No names: the patient
-- is identified by a reference only. Restricted to people who may see safeguarding cases.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE safeguarding_referral (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id       uuid NOT NULL REFERENCES organisation(id),
  code                  text NOT NULL,
  about                 text NOT NULL CHECK (about IN ('ADULT', 'CHILD')),
  category              text NOT NULL CHECK (category IN ('PHYSICAL', 'NEGLECT', 'SELF_NEGLECT',
                          'FINANCIAL', 'PSYCHOLOGICAL', 'SEXUAL', 'DOMESTIC', 'MODERN_SLAVERY',
                          'DISCRIMINATORY', 'ORGANISATIONAL', 'OTHER')),
  patient_ref           text NOT NULL CHECK (patient_ref ~ '^[A-Za-z0-9][A-Za-z0-9/-]{1,29}$'),
  details               text NOT NULL CHECK (length(details) BETWEEN 10 AND 2000),
  raised_by_user_id     uuid NOT NULL REFERENCES app_user(id),
  raised_on             date NOT NULL,
  recorded_by           uuid NOT NULL,
  event_id              uuid REFERENCES event(id),
  abuse_allegation      boolean NOT NULL DEFAULT false,
  cqc_notification_id   uuid REFERENCES cqc_notification(id),
  status                text NOT NULL DEFAULT 'RAISED'
                          CHECK (status IN ('RAISED', 'REFERRED', 'NOT_REFERRED', 'CLOSED')),
  referred_on           date,
  agency                text CHECK (agency IS NULL OR length(agency) BETWEEN 3 AND 200),
  agency_reference      text CHECK (agency_reference IS NULL OR length(agency_reference) BETWEEN 2 AND 60),
  decision_reason       text CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 2000),
  decided_by            uuid,
  outcome               text CHECK (outcome IS NULL OR length(outcome) BETWEEN 3 AND 2000),
  outcome_on            date,
  closed_by             uuid,
  version               int NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  CHECK ((referred_on IS NULL) = (agency IS NULL) AND (agency IS NULL) = (agency_reference IS NULL)),
  CHECK (status <> 'REFERRED' OR referred_on IS NOT NULL),
  CHECK (status <> 'NOT_REFERRED' OR decision_reason IS NOT NULL),
  CHECK (status = 'RAISED' OR decided_by IS NOT NULL),
  CHECK ((status = 'CLOSED') = (outcome IS NOT NULL AND outcome_on IS NOT NULL AND closed_by IS NOT NULL)),
  CHECK (referred_on IS NULL OR referred_on >= raised_on),
  CHECK (outcome_on IS NULL OR outcome_on >= raised_on),
  -- An allegation of abuse always has a CQC notification draft (Reg 18).
  CHECK (NOT abuse_allegation OR cqc_notification_id IS NOT NULL)
);
CREATE INDEX safeguarding_referral_idx ON safeguarding_referral (organisation_id, status, raised_on);
CREATE TRIGGER safeguarding_referral_version BEFORE UPDATE ON safeguarding_referral
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- What was raised never changes; only the referral, decision and outcome move forward.
CREATE FUNCTION safeguarding_referral_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.about, NEW.category, NEW.patient_ref, NEW.details, NEW.raised_by_user_id, NEW.raised_on,
      NEW.recorded_by, NEW.abuse_allegation) IS DISTINCT FROM
     (OLD.about, OLD.category, OLD.patient_ref, OLD.details, OLD.raised_by_user_id, OLD.raised_on,
      OLD.recorded_by, OLD.abuse_allegation) THEN
    RAISE EXCEPTION 'what was raised cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed safeguarding referral cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.referred_on IS NOT NULL AND (NEW.referred_on, NEW.agency, NEW.agency_reference)
       IS DISTINCT FROM (OLD.referred_on, OLD.agency, OLD.agency_reference) THEN
    RAISE EXCEPTION 'the referral record cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER safeguarding_referral_guard BEFORE UPDATE ON safeguarding_referral
  FOR EACH ROW EXECUTE FUNCTION safeguarding_referral_guard();
CREATE TRIGGER safeguarding_referral_no_delete BEFORE DELETE ON safeguarding_referral
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE safeguarding_referral ENABLE ROW LEVEL SECURITY;
ALTER TABLE safeguarding_referral FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON safeguarding_referral
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
CREATE POLICY safeguarding_referral_restricted ON safeguarding_referral AS RESTRICTIVE
  USING (app_has_permission('events.safeguarding.view'))
  WITH CHECK (app_has_permission('events.safeguarding.view'));
GRANT SELECT, INSERT, UPDATE ON safeguarding_referral TO hub_app;

-- ---------------------------------------------------------------------------------------------
-- Vehicle accidents and damage (v36 screen 42, Accidents & damage). A vehicle that is not safe to
-- drive gets a critical stop-use defect, so the existing gates block it and the existing
-- four-eyes release returns it to service. The accident keeps the insurer and police details.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE vehicle_accident (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id        uuid NOT NULL,
  code                   text NOT NULL,
  vehicle_id             uuid NOT NULL,
  occurred_at            timestamptz NOT NULL,
  place                  text CHECK (place IS NULL OR length(place) BETWEEN 2 AND 200),
  description            text NOT NULL CHECK (length(description) BETWEEN 10 AND 2000),
  third_party            text NOT NULL CHECK (length(third_party) BETWEEN 2 AND 500),
  police_ref             text CHECK (police_ref IS NULL OR length(police_ref) BETWEEN 2 AND 60),
  injuries               boolean NOT NULL DEFAULT false,
  event_id               uuid REFERENCES event(id),
  photo_evidence_item_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(photo_evidence_item_ids) <= 6),
  roadworthy             boolean NOT NULL,
  defect_id              uuid,
  insurer_ref            text CHECK (insurer_ref IS NULL OR length(insurer_ref) BETWEEN 2 AND 60),
  insurer_notified_on    date,
  reported_by            uuid NOT NULL,
  status                 text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  close_note             text CHECK (close_note IS NULL OR length(close_note) BETWEEN 3 AND 1000),
  closed_by              uuid,
  closed_at              timestamptz,
  version                int NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id),
  FOREIGN KEY (defect_id, organisation_id) REFERENCES defect (id, organisation_id),
  CHECK (roadworthy OR defect_id IS NOT NULL),
  CHECK ((insurer_ref IS NULL) = (insurer_notified_on IS NULL)),
  CHECK ((status = 'CLOSED') = (closed_by IS NOT NULL AND closed_at IS NOT NULL AND close_note IS NOT NULL))
);
CREATE INDEX vehicle_accident_idx ON vehicle_accident (organisation_id, vehicle_id, occurred_at);
CREATE TRIGGER vehicle_accident_version BEFORE UPDATE ON vehicle_accident
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE FUNCTION vehicle_accident_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.vehicle_id, NEW.occurred_at, NEW.description, NEW.reported_by, NEW.roadworthy, NEW.defect_id)
     IS DISTINCT FROM (OLD.vehicle_id, OLD.occurred_at, OLD.description, OLD.reported_by, OLD.roadworthy,
                       OLD.defect_id) THEN
    RAISE EXCEPTION 'what was reported cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed accident cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicle_accident_guard BEFORE UPDATE ON vehicle_accident
  FOR EACH ROW EXECUTE FUNCTION vehicle_accident_guard();
CREATE TRIGGER vehicle_accident_no_delete BEFORE DELETE ON vehicle_accident
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE vehicle_accident ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_accident FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vehicle_accident
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON vehicle_accident TO hub_app;

-- ---------------------------------------------------------------------------------------------
-- Medicines and medical gases carried on vehicles: what should be on board (the list) and stock
-- checks against it. Stock, expiry and seals only: giving medicines to patients is out of scope.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE vehicle_stock_item (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  vehicle_id       uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('MEDICAL_GAS', 'MEDICINE', 'SEALED_POUCH')),
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  expected_qty     int NOT NULL CHECK (expected_qty BETWEEN 1 AND 999),
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  retired_by       uuid,
  retired_at       timestamptz,
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id),
  CHECK (active = (retired_at IS NULL) AND (retired_at IS NULL) = (retired_by IS NULL))
);
CREATE UNIQUE INDEX vehicle_stock_item_name_key ON vehicle_stock_item (organisation_id, vehicle_id, lower(name))
  WHERE active;
CREATE INDEX vehicle_stock_item_idx ON vehicle_stock_item (organisation_id, vehicle_id);
CREATE TRIGGER vehicle_stock_item_version BEFORE UPDATE ON vehicle_stock_item
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- One stock check of one vehicle. Immutable: a later check supersedes it.
CREATE TABLE vehicle_stock_check (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  vehicle_id       uuid NOT NULL,
  checked_by       uuid NOT NULL,
  checked_at       timestamptz NOT NULL DEFAULT now(),
  lines            jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 100),
  short_count      int NOT NULL CHECK (short_count >= 0),
  expired_count    int NOT NULL CHECK (expired_count >= 0),
  seal_broken_count int NOT NULL CHECK (seal_broken_count >= 0),
  note             text CHECK (note IS NULL OR length(note) BETWEEN 3 AND 1000),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id)
);
CREATE INDEX vehicle_stock_check_idx ON vehicle_stock_check (organisation_id, vehicle_id, checked_at);
CREATE TRIGGER vehicle_stock_check_immutable BEFORE UPDATE OR DELETE ON vehicle_stock_check
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Controlled drug balance checks: the person counting records it and a different person, signed
-- in as themselves, witnesses it. A difference needs an incident before it is settled.
CREATE TABLE controlled_drug_check (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id  uuid NOT NULL,
  code             text NOT NULL,
  drug             text NOT NULL CHECK (length(drug) BETWEEN 3 AND 160),
  store            text NOT NULL CHECK (length(store) BETWEEN 2 AND 120),
  vehicle_id       uuid,
  register_balance int NOT NULL CHECK (register_balance BETWEEN 0 AND 100000),
  counted_balance  int NOT NULL CHECK (counted_balance BETWEEN 0 AND 100000),
  checked_by       uuid NOT NULL,
  checked_at       timestamptz NOT NULL DEFAULT now(),
  witness_user_id  uuid NOT NULL REFERENCES app_user(id),
  status           text NOT NULL DEFAULT 'AWAITING_WITNESS' CHECK (status IN ('AWAITING_WITNESS', 'WITNESSED', 'WITNESS_REFUSED')),
  witnessed_at     timestamptz,
  witness_note     text CHECK (witness_note IS NULL OR length(witness_note) BETWEEN 3 AND 500),
  event_id         uuid REFERENCES event(id),
  note             text CHECK (note IS NULL OR length(note) BETWEEN 3 AND 1000),
  version          int NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, code),
  FOREIGN KEY (vehicle_id, organisation_id) REFERENCES vehicle (id, organisation_id),
  CHECK (witness_user_id <> checked_by),
  CHECK ((status = 'AWAITING_WITNESS') = (witnessed_at IS NULL)),
  CHECK (status <> 'WITNESS_REFUSED' OR witness_note IS NOT NULL)
);
CREATE INDEX controlled_drug_check_idx ON controlled_drug_check (organisation_id, checked_at);
CREATE TRIGGER controlled_drug_check_version BEFORE UPDATE ON controlled_drug_check
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Only the witness step and the incident link may change, each once.
CREATE FUNCTION controlled_drug_check_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.code, NEW.drug, NEW.store, NEW.vehicle_id, NEW.register_balance, NEW.counted_balance,
      NEW.checked_by, NEW.checked_at, NEW.witness_user_id, NEW.note) IS DISTINCT FROM
     (OLD.code, OLD.drug, OLD.store, OLD.vehicle_id, OLD.register_balance, OLD.counted_balance,
      OLD.checked_by, OLD.checked_at, OLD.witness_user_id, OLD.note) THEN
    RAISE EXCEPTION 'a controlled drug check cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'AWAITING_WITNESS' AND (NEW.status, NEW.witnessed_at, NEW.witness_note)
       IS DISTINCT FROM (OLD.status, OLD.witnessed_at, OLD.witness_note) THEN
    RAISE EXCEPTION 'the witness step is already recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.event_id IS NOT NULL AND NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    RAISE EXCEPTION 'the incident link cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER controlled_drug_check_guard BEFORE UPDATE ON controlled_drug_check
  FOR EACH ROW EXECUTE FUNCTION controlled_drug_check_guard();
CREATE TRIGGER controlled_drug_check_no_delete BEFORE DELETE ON controlled_drug_check
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vehicle_stock_item', 'vehicle_stock_check', 'controlled_drug_check'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON vehicle_stock_item, controlled_drug_check TO hub_app;
GRANT SELECT, INSERT ON vehicle_stock_check TO hub_app;
