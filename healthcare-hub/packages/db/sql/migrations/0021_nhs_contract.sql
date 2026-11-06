-- Task 22: NHS contract items and the NHS contract register. Forward-only.
-- 1) NHS contract items pack v1: SYNTHETIC starting content for providers holding an NHS Standard
--    Contract. Same mechanism as the ambulance pack (0008): read-only library rows (organisation_id
--    NULL), inactive until an organisation adopts an item (copied as a DRAFT) and a second person
--    publishes it. Items and intervals must be checked against the organisation's own contract
--    (particulars, service conditions and local schedules); clause numbers change between versions,
--    so none are quoted here.
-- 2) nhs_contract: the contracts the organisation holds (commissioner, dates, notice, contract
--    manager). Statuses come from the rules package; nothing here says a contract is complied with.

ALTER TABLE requirement_template NO FORCE ROW LEVEL SECURITY;
ALTER TABLE requirement_template_version NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
  t uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- code, title, basis, reference, source url, recurrence, blocking, deadline kind, applicability, domain
    ('NHS-ORG-01', 'Data Security and Protection Toolkit submitted', 'REGULATORY_GUIDANCE', '[Check against your contract] NHS Standard Contract information governance requirements; annual DSPT submission (deadline usually 30 June)', 'https://www.dsptoolkit.nhs.uk/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'DUE', '{}', 'WELL_LED'),
    ('NHS-ORG-02', 'EPRR core standards self-assessment', 'REGULATORY_GUIDANCE', '[Check against your contract] NHS England emergency preparedness, resilience and response framework (annual assurance where the contract requires it)', 'https://www.england.nhs.uk/ourwork/eprr/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'REVIEW', '{}', 'SAFE'),
    ('NHS-ORG-03', 'Patient safety incident response plan (PSIRF) in place and reviewed', 'REGULATORY_GUIDANCE', '[Check against your contract] Patient Safety Incident Response Framework (plan and policy agreed with the commissioner; review interval proposed: 1 year)', 'https://www.england.nhs.uk/patient-safety/patient-safety-insight/incident-response-framework/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'REVIEW', '{}', 'SAFE'),
    ('NHS-ORG-04', 'Patient safety events recorded on LFPSE', 'REGULATORY_GUIDANCE', '[Check against your contract] Learning from Patient Safety Events service (confirm access and that incidents are being recorded; check proposed: quarterly)', 'https://www.england.nhs.uk/patient-safety/learn-from-patient-safety-events-service/', '{"type":"COMPLETION_BASED","interval":{"unit":"MONTHS","every":3}}', 'NONE', 'REVIEW', '{}', 'SAFE'),
    ('NHS-ORG-05', 'Freedom to Speak Up guardian and policy', 'REGULATORY_GUIDANCE', '[Check against your contract] National Guardian''s Office guidance; speak-up policy reflecting the national policy (review interval proposed: 1 year)', 'https://nationalguardian.org.uk/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'REVIEW', '{}', 'WELL_LED'),
    ('NHS-ORG-06', 'Safeguarding leads named and annual report shared', 'REGULATORY_GUIDANCE', '[Check against your contract] Safeguarding accountability and assurance framework (named leads; annual report to the commissioner if required)', 'https://www.england.nhs.uk/safeguarding/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'REVIEW', '{}', 'SAFE'),
    ('NHS-ORG-07', 'Caldicott guardian, SIRO and data protection officer named', 'REGULATORY_GUIDANCE', '[Check against your contract] Information governance roles required of providers (review interval proposed: 1 year)', 'https://www.gov.uk/government/groups/uk-caldicott-guardian-council', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'REVIEW', '{}', 'WELL_LED'),
    ('NHS-ORG-08', 'Business continuity plan tested', 'REGULATORY_GUIDANCE', '[Check against your contract] Business continuity requirements (test or exercise interval proposed: 1 year)', 'https://www.england.nhs.uk/ourwork/eprr/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'DUE', '{}', 'SAFE'),
    ('NHS-ORG-09', 'Indemnity and insurance required by the contract', 'REGULATORY_GUIDANCE', '[Check against your contract] Indemnity arrangements and levels set out in the contract (expiry from the certificate)', NULL, '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'STATUTORY', 'EXPIRY', '{}', 'WELL_LED'),
    ('NHS-ORG-10', 'Counter-fraud arrangements reviewed', 'REGULATORY_GUIDANCE', '[Check against your contract] NHS Counter Fraud Authority requirements for providers (review interval proposed: 1 year)', 'https://cfa.nhs.uk/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'NONE', 'REVIEW', '{}', 'WELL_LED'),
    ('NHS-ORG-11', 'Accessible Information Standard reviewed', 'STATUTORY', '[Check against your contract] Accessible Information Standard (DCB1605), Health and Social Care Act 2012 s250 (review interval proposed: 1 year)', 'https://www.england.nhs.uk/about/equality/equality-hub/patient-equalities-programme/equality-frameworks-and-information-standards/accessibleinfo/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'REVIEW', '{}', 'RESPONSIVE'),
    ('NHS-ORG-12', 'Workforce equality returns (WRES / WDES) where required', 'REGULATORY_GUIDANCE', '[Check against your contract] Workforce Race and Disability Equality Standards (apply only if the contract requires them)', 'https://www.england.nhs.uk/about/equality/equality-hub/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'NONE', 'DUE', '{"onlyIfContractRequires":"WRES_WDES"}', 'WELL_LED'),
    ('NHS-ORG-13', 'Carbon reduction plan published', 'REGULATORY_GUIDANCE', '[Check against your contract] NHS net zero supplier roadmap (carbon reduction plan; review interval proposed: 1 year)', 'https://www.england.nhs.uk/greenernhs/get-involved/suppliers/', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'NONE', 'REVIEW', '{}', 'WELL_LED'),
    ('NHS-ORG-14', 'Modern slavery statement published (if required)', 'STATUTORY', '[Check against your contract] Modern Slavery Act 2015 s54 (applies at the turnover threshold; annual)', 'https://www.gov.uk/government/publications/transparency-in-supply-chains-a-practical-guide', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'NONE', 'DUE', '{"onlyIfTurnoverThreshold":true}', 'WELL_LED'),
    ('NHS-ORG-15', 'Contract quality and activity report sent to the commissioner', 'REGULATORY_GUIDANCE', '[Check against your contract] Reporting requirements in the contract schedules (frequency proposed: monthly; set to match your contract)', NULL, '{"type":"COMPLETION_BASED","interval":{"unit":"MONTHS","every":1}}', 'NONE', 'DUE', '{}', 'WELL_LED')
  ) AS v(code, title, basis, ref, url, recurrence, blocking, kind, rule, domain)
  LOOP
    IF EXISTS (SELECT 1 FROM requirement_template WHERE organisation_id IS NULL AND pack = 'NHS_CONTRACT_V1' AND code = r.code) THEN
      CONTINUE;
    END IF;
    INSERT INTO requirement_template (organisation_id, pack, code, title)
      VALUES (NULL, 'NHS_CONTRACT_V1', r.code, r.title) RETURNING id INTO t;
    INSERT INTO requirement_template_version
      (organisation_id, template_id, version, status, basis_type, regulation_ref, source_url, source_version_date,
       subject_type, applicability_rule, recurrence, blocking, deadline_kind, framework_mappings, approved_at)
    VALUES
      (NULL, t, 1, 'EFFECTIVE', r.basis::requirement_basis, r.ref, r.url, DATE '2026-11-01',
       'ORGANISATION'::requirement_subject_type, r.rule::jsonb, r.recurrence::jsonb,
       r.blocking::requirement_blocking, r.kind,
       jsonb_build_array(jsonb_build_object('framework', 'NHS_CONTRACT', 'domain', r.domain)), now());
  END LOOP;
END $$;

ALTER TABLE requirement_template FORCE ROW LEVEL SECURITY;
ALTER TABLE requirement_template_version FORCE ROW LEVEL SECURITY;

CREATE TABLE nhs_contract (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organisation_id      uuid NOT NULL REFERENCES organisation(id),
  commissioner         text NOT NULL CHECK (length(commissioner) BETWEEN 2 AND 200),
  reference            text NOT NULL CHECK (length(reference) BETWEEN 2 AND 60),
  service              text NOT NULL CHECK (length(service) BETWEEN 2 AND 200),
  contract_type        text NOT NULL CHECK (contract_type IN ('NHS_STANDARD_FULL', 'NHS_STANDARD_SHORTFORM',
                         'SUBCONTRACT', 'OTHER')),
  start_on             date NOT NULL,
  end_on               date NOT NULL,
  notice_months        int NOT NULL DEFAULT 6 CHECK (notice_months BETWEEN 0 AND 24),
  reporting            text NOT NULL DEFAULT 'MONTHLY' CHECK (reporting IN ('MONTHLY', 'QUARTERLY', 'ANNUAL',
                         'NONE')),
  manager_user_id      uuid NOT NULL,
  review_meeting_on    date,
  notes                text CHECK (notes IS NULL OR length(notes) <= 2000),
  version              int NOT NULL DEFAULT 1,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, reference),
  CHECK (end_on > start_on)
);
CREATE INDEX nhs_contract_idx ON nhs_contract (organisation_id, end_on);
CREATE TRIGGER nhs_contract_version BEFORE UPDATE ON nhs_contract
  FOR EACH ROW EXECUTE FUNCTION bump_version();
ALTER TABLE nhs_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE nhs_contract FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON nhs_contract
  USING (organisation_id = app_org_id()) WITH CHECK (organisation_id = app_org_id());
GRANT SELECT, INSERT, UPDATE ON nhs_contract TO hub_app;   -- no deletes: changes are audited
