-- Ambulance pack v1 starter library (DECISIONS A8): read-only library rows (organisation_id NULL).
-- They are INACTIVE for every organisation until it adopts an item (copied as a DRAFT) and a second
-- person publishes it. Intervals marked "proposed" come from the source notes and need management
-- confirmation before adoption (PRD 7 "Local rules requiring explicit approval").

-- Library rows have no organisation, which FORCE RLS would refuse even for the owner: lift FORCE for
-- this migration's inserts only (the app role never has bypass), then restore it.
ALTER TABLE requirement_template NO FORCE ROW LEVEL SECURITY;
ALTER TABLE requirement_template_version NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
  t uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- code, title, basis, regulation ref, source url, subject, recurrence, blocking, deadline kind, applicability, domain
    ('AMB-STF-01', 'Driving licence entitlement', 'STATUTORY', 'Road Traffic Act 1988 s87; check entitlement and categories with DVLA', 'https://www.gov.uk/check-driving-information', 'STAFF', '{"type":"EVENT_TRIGGERED"}', 'STATUTORY', 'EXPIRY', '{}', 'SAFE'),
    ('AMB-STF-02', 'DBS suitability review', 'ORG_POLICY', 'DBS checks have no expiry; review date set by local policy (proposed 3 years)', 'https://www.gov.uk/government/organisations/disclosure-and-barring-service', 'STAFF', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":3}}', 'DEPLOYMENT_CRITICAL', 'REVIEW', '{}', 'SAFE'),
    ('AMB-STF-03', 'Identity and right to work', 'STATUTORY', 'Immigration, Asylum and Nationality Act 2006 s15; follow-up for time-limited permission', 'https://www.gov.uk/check-job-applicant-right-to-work', 'STAFF', '{"type":"EVENT_TRIGGERED"}', 'STATUTORY', 'EXPIRY', '{}', 'WELL_LED'),
    ('AMB-STF-04', 'Satisfactory references and employment history', 'REGULATORY_GUIDANCE', 'Regulated Activities Regulations 2014 reg 19 and Schedule 3', 'https://www.cqc.org.uk/guidance-providers/regulations/regulation-19-fit-proper-persons-employed', 'STAFF', '{"type":"EVENT_TRIGGERED"}', 'DEPLOYMENT_CRITICAL', 'DUE', '{}', 'SAFE'),
    ('AMB-STF-05', 'Moving and handling competence', 'REGULATORY_GUIDANCE', 'Manual Handling Operations Regulations 1992 (refresher interval proposed: 1 year)', 'https://www.hse.gov.uk/msd/manual-handling/', 'STAFF', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'DUE', '{}', 'SAFE'),
    ('AMB-STF-06', 'Basic life support', 'GOOD_PRACTICE', 'Resuscitation Council UK guidance (refresher interval proposed: 1 year)', 'https://www.resus.org.uk/', 'STAFF', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'DEPLOYMENT_CRITICAL', 'DUE', '{}', 'EFFECTIVE'),
    ('AMB-STF-07', 'Safeguarding training (adults and children)', 'REGULATORY_GUIDANCE', 'Regulated Activities Regulations 2014 reg 13; intercollegiate guidance (interval proposed: 3 years)', 'https://www.cqc.org.uk/guidance-providers/regulations/regulation-13-safeguarding-service-users-abuse-improper', 'STAFF', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":3}}', 'DEPLOYMENT_CRITICAL', 'DUE', '{}', 'SAFE'),
    ('AMB-STF-08', 'Infection prevention and control training', 'REGULATORY_GUIDANCE', 'Code of practice on the prevention and control of infections (interval proposed: 1 year)', 'https://www.gov.uk/government/publications/the-health-and-social-care-act-2008-code-of-practice-on-the-prevention-and-control-of-infections-and-related-guidance', 'STAFF', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'POLICY', 'DUE', '{}', 'SAFE'),
    ('AMB-STF-09', 'Induction completed', 'REGULATORY_GUIDANCE', 'Regulated Activities Regulations 2014 reg 18 (staffing)', 'https://www.cqc.org.uk/guidance-providers/regulations/regulation-18-staffing', 'STAFF', '{"type":"EVENT_TRIGGERED"}', 'DEPLOYMENT_CRITICAL', 'DUE', '{}', 'EFFECTIVE'),
    ('AMB-STF-10', 'Supervision', 'ORG_POLICY', 'Local policy (source notes propose two-monthly; confirm before adoption)', NULL, 'STAFF', '{"type":"COMPLETION_BASED","interval":{"unit":"MONTHS","every":2}}', 'NONE', 'DUE', '{}', 'WELL_LED'),
    ('AMB-STF-11', 'Appraisal', 'ORG_POLICY', 'Local policy (source notes propose annual; confirm before adoption)', NULL, 'STAFF', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'NONE', 'DUE', '{}', 'WELL_LED'),
    ('AMB-VEH-01', 'MOT test certificate', 'STATUTORY', 'Road Traffic Act 1988 s47', 'https://www.gov.uk/getting-an-mot', 'VEHICLE', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'STATUTORY', 'EXPIRY', '{"autoApply":true}', 'SAFE'),
    ('AMB-VEH-02', 'Motor insurance', 'STATUTORY', 'Road Traffic Act 1988 s143', 'https://www.gov.uk/vehicle-insurance', 'VEHICLE', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'STATUTORY', 'EXPIRY', '{"autoApply":true}', 'SAFE'),
    ('AMB-VEH-03', 'Vehicle tax', 'STATUTORY', 'Vehicle Excise and Registration Act 1994', 'https://www.gov.uk/vehicle-tax', 'VEHICLE', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'STATUTORY', 'EXPIRY', '{"autoApply":true}', 'SAFE'),
    ('AMB-EQ-01', 'LOLER thorough examination (lifting people)', 'STATUTORY', 'Lifting Operations and Lifting Equipment Regulations 1998 reg 9 (equipment for lifting people: at least every 6 months, or per examination scheme)', 'https://www.hse.gov.uk/work-equipment-machinery/loler.htm', 'EQUIPMENT', '{"type":"COMPLETION_BASED","interval":{"unit":"MONTHS","every":6}}', 'SAFETY_CRITICAL', 'DUE', '{}', 'SAFE'),
    ('AMB-EQ-02', 'Equipment servicing (manufacturer schedule)', 'GOOD_PRACTICE', 'Manufacturer instructions; interval comes from the manufacturer for each model', NULL, 'EQUIPMENT', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'DEPLOYMENT_CRITICAL', 'DUE', '{}', 'SAFE'),
    ('AMB-PRM-01', 'Fire risk assessment', 'STATUTORY', 'Regulatory Reform (Fire Safety) Order 2005 art 9 (review interval from competent person advice)', 'https://www.gov.uk/workplace-fire-safety-your-responsibilities', 'PREMISES', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'STATUTORY', 'DUE', '{}', 'SAFE'),
    ('AMB-PRM-02', 'Legionella risk assessment', 'STATUTORY', 'HSE Approved Code of Practice L8 (review interval from competent person advice)', 'https://www.hse.gov.uk/legionnaires/', 'PREMISES', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":2}}', 'STATUTORY', 'DUE', '{}', 'SAFE'),
    ('AMB-PRM-03', 'Gas safety check', 'STATUTORY', 'Gas Safety (Installation and Use) Regulations 1998', 'https://www.hse.gov.uk/gas/', 'PREMISES', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'STATUTORY', 'DUE', '{}', 'SAFE'),
    ('AMB-PRM-04', 'Medical oxygen storage and handling', 'REGULATORY_GUIDANCE', 'BCGA CP44 / HTM 02-01 (ambulance bases; not applied to admin-only sites by default)', NULL, 'PREMISES', '{"type":"COMPLETION_BASED","interval":{"unit":"YEARS","every":1}}', 'DEPLOYMENT_CRITICAL', 'DUE', '{}', 'SAFE')
  ) AS v(code, title, basis, ref, url, subject, recurrence, blocking, kind, rule, domain)
  LOOP
    IF EXISTS (SELECT 1 FROM requirement_template WHERE organisation_id IS NULL AND pack = 'AMBULANCE_V1' AND code = r.code) THEN
      CONTINUE;
    END IF;
    INSERT INTO requirement_template (organisation_id, pack, code, title) VALUES (NULL, 'AMBULANCE_V1', r.code, r.title) RETURNING id INTO t;
    INSERT INTO requirement_template_version
      (organisation_id, template_id, version, status, basis_type, regulation_ref, source_url, source_version_date,
       subject_type, applicability_rule, recurrence, blocking, deadline_kind, framework_mappings, approved_at)
    VALUES
      (NULL, t, 1, 'EFFECTIVE', r.basis::requirement_basis, r.ref, r.url, DATE '2026-10-01',
       r.subject::requirement_subject_type, r.rule::jsonb, r.recurrence::jsonb, r.blocking::requirement_blocking, r.kind,
       jsonb_build_array(jsonb_build_object('framework', 'CQC_SAF', 'domain', r.domain)), now());
  END LOOP;
END $$;

ALTER TABLE requirement_template FORCE ROW LEVEL SECURITY;
ALTER TABLE requirement_template_version FORCE ROW LEVEL SECURITY;
