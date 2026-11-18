#!/usr/bin/env python3
"""Builds packages/db/src/admin/v36-data.json from the v36 prototype's own sample store.

Usage: python3 build-v36-data.py <v36-store.json> [out.json]

<v36-store.json> is the prototype's localStorage value `hh_wf_v36` (its seedStore() output) saved
as JSON. Dates stay as the prototype wrote them (its "today" is 2026-11-17) and are tagged so the
seed moves them to the real today: "@D:YYYY-MM-DD" for a date, "@T:YYYY-MM-DD HH:MM" for a London
time. Statuses are worked out here with the same rules the app uses, relative to that "today";
moving every date by the same number of days keeps them right, and the worker re-checks them.
Synthetic data only.
"""
import json
import re
import sys
import uuid
from datetime import date, timedelta

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else 'v36-data.json'
S = json.load(open(SRC, encoding='utf-8'))
BASE = '2026-11-17'
TODAY = date.fromisoformat(BASE)

ORG = '01900000-0000-7000-8000-000000000001'
LOC = '01900000-0000-7000-8000-000000000011'
NS = uuid.UUID('6f1d7c55-3e1a-4b7e-9a36-36a36a36a360')


def U(*key):
    return str(uuid.uuid5(NS, '|'.join(str(k) for k in key)))


def u(n):
    return f'01900000-0000-7000-8000-0000000001{n:02d}'


def D(d):
    return f'@D:{d}' if d else None


def T(d, t='09:00'):
    if not d:
        return None
    if ' ' in d:
        d, t = d.split(' ')[:2]
    return f'@T:{d} {t[:5]}'


def J(x):
    return {'$json': x}


always, once = [], []


def ins(table, **v):
    once.append({'i': table, 'v': v})


def q(sql, *p, when='once'):
    (always if when == 'always' else once).append({'q': ' '.join(sql.split()), 'p': list(p)})


# ---- people -------------------------------------------------------------------------------------
USERS = {
    'Dr. A. Vance': u(1), 'Sarah Jenkins': u(2), 'Priya Nair': u(3), 'Dispatcher': u(3),
    'Dave Evans': u(4), 'Dr. Helen Price': u(5), 'Alex Morgan': u(7), 'Lee Davies': u(8),
    'J. Whitmore': u(9), 'Rachel Hughes': u(11), 'Mark Cox': u(12),
}
RENAME = [(u(1), 'Dr. A. Vance'), (u(2), 'Sarah Jenkins'), (u(3), 'Priya Nair'),
          (u(4), 'Dave Evans'), (u(5), 'Dr. Helen Price'), (u(7), 'Alex Morgan'),
          (u(8), 'Lee Davies'), (u(9), 'J. Whitmore'), (u(11), 'Rachel Hughes'), (u(12), 'Mark Cox')]
SHADOW = ['Samira Patel', 'Tom Hughes', 'Grace Bennett', 'M. Davis', 'Jordan Reed']
for n in SHADOW:
    slug = n.lower().replace('. ', '.').replace(' ', '.')
    USERS[n] = U('user', n)
    ins('app_user', id=USERS[n], idp_subject=f'v36|{slug}', email=f'{slug}@example.test',
        display_name=n, status='ACTIVE')
    # A membership, so their names show on the records they appear on (supervisor, recorder).
    role = 'HR_LEAD' if n == 'Samira Patel' else 'CREW'
    ins('membership', id=U('member', n), organisation_id=ORG, user_id=USERS[n],
        role_id='@ROLE:' + role)


def who(name, default='Dr. A. Vance'):
    return USERS.get(name) or USERS[default]


who_user = who  # kept: a later loop rebinds the name `who`


# Names the base seed would otherwise show (it never overwrites them, but keep them in step).
q("UPDATE organisation SET name = 'Example Organisation', legal_name = 'Example Organisation Ltd', "
  "trading_name = 'Example Organisation' WHERE id = $1", ORG, when='always')
q("UPDATE location SET name = 'Watford' WHERE id = $1", LOC, when='always')
for uid, name in RENAME:
    q('UPDATE app_user SET display_name = $2 WHERE id = $1 AND display_name IS DISTINCT FROM $2',
      uid, name, when='always')
q("UPDATE location SET address = $2 WHERE id = $1", LOC, J('Station, Example Road, Watford'))

# ---- requirement templates: one per v36 check ----------------------------------------------------
REQ = {
    'ID': ('Proof of identity with recent photo', 'AMB-STF-03'),
    'DBS': ('Enhanced DBS with barred lists', 'AMB-STF-02'),
    'REF': ('Two references, incl. last employer', 'AMB-STF-04'),
    'EMP': ('Full employment history, gaps explained', 'ORG-STF-01'),
    'RTW': ('Right to work in the UK', 'ORG-STF-02'),
    'OH': ('Occupational health – fit for the role', 'ORG-STF-03'),
    'QUAL': ('Qualifications for the role', 'ORG-STF-04'),
    'HCPC': ('HCPC registration (paramedic)', 'ORG-STF-05'),
    'DL': ('Driving licence incl. C1, checked with DVLA', 'AMB-STF-01'),
    'DA': ('Driving assessment (emergency response)', 'AMB-DRV-01'),
    'MH': ('Manual handling', 'AMB-STF-05'),
    'BLS': ('Basic life support', 'AMB-STF-06'),
    'SG': ('Safeguarding adults & children (level 2)', 'AMB-STF-07'),
    'IPC': ('Infection prevention & control', 'AMB-STF-08'),
    'IG': ('Information governance & data security', 'ORG-STF-06'),
    'IND': ('Induction completed and signed', 'AMB-STF-09'),
}
KIND = {'ID': 'EXPIRY', 'RTW': 'EXPIRY', 'HCPC': 'EXPIRY', 'DL': 'EXPIRY', 'DBS': 'REVIEW'}
NEW_TPL = {
    # code: (title, subject, basis, ref, kind, blocking, recurrence)
    'ORG-STF-01': ('Full employment history, gaps explained', 'STAFF', 'REGULATORY_GUIDANCE',
                'Reg 19, Schedule 3 (7)', 'DUE', 'DEPLOYMENT_CRITICAL', {'type': 'EVENT_TRIGGERED'}),
    'ORG-STF-02': ('Right to work in the UK', 'STAFF', 'STATUTORY',
                'Immigration, Asylum & Nationality Act 2006', 'EXPIRY', 'STATUTORY',
                {'type': 'EVENT_TRIGGERED'}),
    'ORG-STF-03': ('Occupational health – fit for the role', 'STAFF', 'REGULATORY_GUIDANCE',
               'Reg 19, Schedule 3 (8)', 'DUE', 'DEPLOYMENT_CRITICAL', {'type': 'EVENT_TRIGGERED'}),
    'ORG-STF-04': ('Qualifications for the role', 'STAFF', 'REGULATORY_GUIDANCE',
                 'Reg 19, Schedule 3 (6)', 'DUE', 'DEPLOYMENT_CRITICAL', {'type': 'EVENT_TRIGGERED'}),
    'ORG-STF-05': ('HCPC registration (paramedic)', 'STAFF', 'STATUTORY', 'Reg 19, Schedule 3 (5)',
                 'EXPIRY', 'STATUTORY', {'type': 'COMPLETION_BASED', 'interval': {'unit': 'YEARS', 'every': 2}}),
    'ORG-STF-06': ('Information governance & data security', 'STAFF', 'ORG_POLICY',
               'Data Security & Protection Toolkit', 'DUE', 'POLICY',
               {'type': 'COMPLETION_BASED', 'interval': {'unit': 'YEARS', 'every': 1}}),
    'ORG-EQ-01': ('Calibration', 'EQUIPMENT', 'GOOD_PRACTICE', "Manufacturer's instructions", 'DUE',
                   'DEPLOYMENT_CRITICAL', {'type': 'COMPLETION_BASED', 'interval': {'unit': 'YEARS', 'every': 1}}),
    'ORG-EQ-02': ('Portable appliance test (PAT)', 'EQUIPMENT', 'GOOD_PRACTICE',
                   'Electricity at Work Regulations 1989', 'DUE', 'POLICY',
                   {'type': 'COMPLETION_BASED', 'interval': {'unit': 'YEARS', 'every': 1}}),
}
PREM_AREA = {'Fire safety': 'FIRE', 'Water safety': 'WATER', 'Electrical & gas': 'ELECTRICAL_GAS',
             'Medical gases': 'OXYGEN', 'Hazardous substances & IPC': 'COSHH_INFECTION',
             'People & workplace': 'PEOPLE_WORKPLACE'}
for p in S['prem']:
    code = f"ORG-PRM-{p['id'][3:]}"
    NEW_TPL[code] = (p['item'], 'PREMISES', 'STATUTORY' if p['freq'] >= 365 else 'GOOD_PRACTICE',
                     p['area'], 'DUE', 'POLICY',
                     {'type': 'COMPLETION_BASED', 'interval': {'unit': 'DAYS', 'every': p['freq']}})
for code, (title, subj, basis, ref, kind, block, rec) in NEW_TPL.items():
    tid, vid = U('tpl', code), U('tplv', code)
    ins('requirement_template', id=tid, organisation_id=ORG, pack='CUSTOM', code=code, title=title,
        created_by=u(1))
    ins('requirement_template_version', id=vid, organisation_id=ORG, template_id=tid, version=1,
        status='EFFECTIVE', basis_type=basis, regulation_ref=ref, subject_type=subj,
        applicability_rule=J({}), evidence_type='DOCUMENT', recurrence=J(rec),
        blocking=block, deadline_kind=kind, framework_mappings=J([{'framework': 'CQC_SAF', 'domain': 'SAFE'}]),
        created_by=u(1), approved_by=u(5), approved_at=T('2026-09-01'), effective_from=D('2026-09-01'))
# Library checks keep their own titles: requirement templates cannot be renamed once created.

JOBROLE_BASE = ['ID', 'DBS', 'REF', 'EMP', 'RTW', 'OH', 'MH', 'BLS', 'SG', 'IPC', 'IG', 'IND']
JOBROLE = {'Driver': JOBROLE_BASE + ['DL', 'DA'], 'Care assistant': JOBROLE_BASE[:],
           'Emergency care assistant': JOBROLE_BASE + ['QUAL', 'DL'],
           'Technician': JOBROLE_BASE + ['QUAL', 'DL', 'DA'],
           'Paramedic': JOBROLE_BASE + ['QUAL', 'HCPC', 'DL', 'DA']}
ROLE = {'Driver': 'DRIVER', 'Care assistant': 'CARE_ASSISTANT',
        'Emergency care assistant': 'EMERGENCY_CARE_ASSISTANT', 'Technician': 'TECHNICIAN',
        'Paramedic': 'PARAMEDIC'}
for job, items in JOBROLE.items():
    for k in items:
        q('''INSERT INTO role_requirement (organisation_id, role, template_id, created_by)
             VALUES ($1, $2::staff_role, $3, $4) ON CONFLICT DO NOTHING''',
          ORG, ROLE[job], f'@TPL:{REQ[k][1]}', u(1))

# ---- status, as the rules engine works it out ----------------------------------------------------
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def fmt(d):
    x = date.fromisoformat(d)
    return f'{x.day} {MON[x.month - 1]} {x.year}'


def status(kind, deadline, verified_to, verified, pending, na=False):
    """(status, reason_code, reason_text, currently_verified) per RULES_ENGINE §2."""
    if na:
        return 'NOT_APPLICABLE', 'NOT_APPLICABLE', 'Approved as not applicable', False
    noun = {'DUE': 'Due', 'EXPIRY': 'Expires', 'REVIEW': 'Policy review date'}
    dl = deadline or (verified_to if verified else None)
    dkind = kind if deadline else 'EXPIRY'
    days = (date.fromisoformat(dl) - TODAY).days if dl else None
    missed = days is not None and days < 0
    current = verified and (verified_to is None or date.fromisoformat(verified_to) >= TODAY)
    if current and not missed:
        if days == 0:
            return 'AMBER', 'DUE_TODAY', f'{noun[dkind]} today ({fmt(dl)})', True
        if days is not None and days <= 30:
            return 'AMBER', 'DUE_SOON', f"{noun[dkind]} in {days} day{'' if days == 1 else 's'} ({fmt(dl)})", True
        if pending:
            return 'AMBER', 'AWAITING_REVIEW', 'Newer evidence is awaiting review; current verified evidence is still valid', True
        return 'GREEN', 'VALID', 'Verified and in date', True
    if pending:
        return ('GREY', 'UNVERIFIED', 'Previous evidence has lapsed and the renewal has not been verified yet'
                if (missed or verified) else 'Evidence uploaded but not verified yet', False)
    if missed:
        if dkind == 'REVIEW':
            return 'RED', 'POLICY_REVIEW_OVERDUE', f'Policy review date passed ({fmt(dl)})', False
        code = 'EXPIRED' if dkind == 'EXPIRY' else 'OVERDUE'
        return 'RED', code, f"{'Expired' if code == 'EXPIRED' else 'Overdue'} since {fmt(dl)}", False
    return 'GREY', 'MISSING', 'No verified evidence on record', False


def evidence(key, title, subject_kind, by, rcv, file=None, valid_to=None, vby=None, von=None,
             valid_from=None, channel='OFFICE'):
    """An evidence item with one version, verified when `vby` is given. Returns the item id."""
    item, ver = U('ev', key), U('evv', key)
    up = who(by, 'Sarah Jenkins')
    ins('evidence_item', id=item, organisation_id=ORG, title=title[:200], type='DOCUMENT',
        created_by=up, created_at=T(rcv, '09:00'))
    name = file or f"{title.split(' – ')[0][:40].replace(' ', '_')}.pdf"
    ins('evidence_version', id=ver, organisation_id=ORG, item_id=item, version_no=1,
        blob_key=f'v36-demo/{item}/{name}', declared_mime='application/pdf', declared_size=184320,
        mime='application/pdf', size_bytes=184320, sha256='0' * 64, scan_status='CLEAN',
        uploaded_at=T(rcv, '09:00'), scanned_at=T(rcv, '09:01'), uploaded_by=up,
        captured_at=T(rcv, '09:00'), valid_from=D(valid_from or rcv), valid_to=D(valid_to),
        created_at=T(rcv, '09:00'), channel=channel)
    if vby:
        rev = who(vby)
        if rev == up:  # a second person verifies (the app refuses self-verification)
            rev = u(1) if up != u(1) else u(2)
        ins('verification', id=U('vf', key), organisation_id=ORG, evidence_version_id=ver,
            decision='ACCEPTED', reviewer_id=rev, confirmed_valid_to=D(valid_to),
            created_at=T(von or rcv, '10:00'))
    return item


def instance(key, tpl, subject_type, subject_id, owner, kind, deadline, st, location=LOC):
    s, code, text, cur = st
    q(f'''INSERT INTO requirement_instance
            (id, organisation_id, location_id, template_id, template_version_id, subject_type, subject_id,
             owner_user_id, due_date, expiry_date, review_date, applicability, status, reason_code,
             reason_text, currently_verified, computed_at, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now(), $17)
          ON CONFLICT (organisation_id, template_id, subject_type, subject_id) DO UPDATE SET
            due_date = EXCLUDED.due_date, expiry_date = EXCLUDED.expiry_date,
            review_date = EXCLUDED.review_date, applicability = EXCLUDED.applicability,
            status = EXCLUDED.status, reason_code = EXCLUDED.reason_code,
            reason_text = EXCLUDED.reason_text, currently_verified = EXCLUDED.currently_verified,
            owner_user_id = coalesce(requirement_instance.owner_user_id, EXCLUDED.owner_user_id),
            computed_at = now()''',
      U('ri', key), ORG, location, f'@TPL:{tpl}', f'@TPLV:{tpl}', subject_type, subject_id, owner,
      D(deadline) if kind == 'DUE' else None, D(deadline) if kind == 'EXPIRY' else None,
      D(deadline) if kind == 'REVIEW' else None,
      'APPROVED_NOT_APPLICABLE' if s == 'NOT_APPLICABLE' else 'APPLICABLE', s, code, text, cur, u(1))


def link(key, item, tpl, subject_type, subject_id, by):
    q('''INSERT INTO evidence_link (id, organisation_id, item_id, instance_id, created_by)
         SELECT $1, $2, $3, ri.id, $4 FROM requirement_instance ri
          WHERE ri.organisation_id = $2 AND ri.template_id = $5 AND ri.subject_type = $6::requirement_subject_type
            AND ri.subject_id = $7
         ON CONFLICT DO NOTHING''', U('ln', key), ORG, item, who(by, 'Sarah Jenkins'),
      f'@TPL:{tpl}', subject_type, subject_id)


def check(key, tpl, kind, subject_type, subject_id, owner, it, title):
    """One v36 check item (s = ok / rcv / req / none / na) as an instance with its evidence."""
    s = it.get('s', 'none')
    exp = it.get('review') if kind == 'REVIEW' else it.get('exp')
    if s == 'ok':
        deadline = exp
        st = status(kind, deadline, it.get('exp'), True, False)
    elif s == 'rcv':
        deadline = it.get('due')
        st = status(kind, deadline, None, False, True)
    elif s == 'na':
        deadline = None
        st = status(kind, None, None, False, False, na=True)
    else:
        deadline = it.get('due')
        st = status(kind, deadline, None, False, False)
    instance(key, tpl, subject_type, subject_id, owner, kind, deadline, st)
    if s in ('ok', 'rcv'):
        rcv = it.get('rcv') or it.get('on') or it.get('last') or '2026-11-01'
        # C8: Jordan Reed's Enhanced DBS was uploaded via the candidate portal.
        portal = key == 'staff|ST-0051|DBS'
        by = 'Jordan Reed' if portal else (it.get('by') or 'Sarah Jenkins')
        item = evidence(key, title, subject_type, by, rcv,
                        file=it.get('file'), valid_to=it.get('exp'),
                        vby=it.get('vby') if s == 'ok' else None, von=it.get('von'),
                        channel='CANDIDATE_PORTAL' if portal else 'OFFICE')
        link(key, item, tpl, subject_type, subject_id, by)


# ---- staff ---------------------------------------------------------------------------------------
STAFF_ID = {'ST-0042': '01900000-0000-7000-8000-000000000201',
            'ST-0043': '01900000-0000-7000-8000-000000000202',
            'ST-0051': '01900000-0000-7000-8000-000000000203'}
for pid in S['people']:
    STAFF_ID.setdefault(pid, U('staff', pid))
LIFE = {'Candidate': 'CANDIDATE', 'Checks in progress': 'CHECKS_IN_PROGRESS',
        'Ready for review': 'READY_FOR_REVIEW', 'Approved for role': 'APPROVED_FOR_ROLE', 'Active': 'ACTIVE'}
STAFF_USER = {'ST-0042': u(7), 'ST-0043': u(8), 'ST-0101': USERS['Tom Hughes'],
              'ST-0102': USERS['Grace Bennett'], 'ST-0051': USERS['Jordan Reed']}
MARKER = STAFF_ID['ST-0072']
for pid, p in S['people'].items():
    sid = STAFF_ID[pid]
    life = LIFE[p['stage']]
    contract = {'Permanent': 'PERMANENT', 'Bank': 'BANK'}.get(p.get('contract'))
    ins('staff', id=sid, organisation_id=ORG, staff_no=pid, user_id=STAFF_USER.get(pid),
        display_name=p['name'], lifecycle_state=life, primary_location_id=LOC, job_title=p['job'],
        start_date=D(p.get('start')), contract_type=contract,
        work_email=f"{p['name'].lower().replace(' ', '.')}@example.test", created_by=u(2))
    # The three people the base seed already made.
    q('''UPDATE staff SET display_name = $2, lifecycle_state = $3, job_title = $4, start_date = $5,
           contract_type = $6, work_email = coalesce(work_email, $7) WHERE id = $1''',
      sid, p['name'], life, p['job'], D(p.get('start')), contract,
      f"{p['name'].lower().replace(' ', '.')}@example.test")
    q('''INSERT INTO staff_lifecycle_event (organisation_id, staff_id, from_state, to_state, reason, actor_user_id)
         SELECT $1, $2, NULL, $3, 'v36 sample record', $4
          WHERE NOT EXISTS (SELECT 1 FROM staff_lifecycle_event WHERE staff_id = $2)''',
      ORG, sid, life, u(2))
    if p.get('stageOn'):
        # When the person entered their current stage (v36 "Day 17 of 21 in stage").
        ins('staff_lifecycle_event', id=U('stage', pid), organisation_id=ORG, staff_id=sid,
            to_state=life, reason='Entered this stage', actor_user_id=u(2), at=T(p['stageOn']))
    if life in ('ACTIVE', 'APPROVED_FOR_ROLE'):
        roles = [ROLE[p['job']]] + (['DRIVER'] if 'DL' in p['items'] and p['job'] != 'Driver' else [])
        q('''UPDATE staff_role_approval SET revoked_at = now(), revoked_by = $3,
               revoke_reason = 'Replaced by the v36 role' WHERE staff_id = $1 AND revoked_at IS NULL
               AND NOT (role::text = ANY($2::text[]))''', sid, roles, u(1))
        appr = p.get('approved') or {}
        for r in roles:
            q('''INSERT INTO staff_role_approval (organisation_id, staff_id, role, reason, approved_by, valid_from)
                 SELECT $1, $2, $3::staff_role, $4, $5, $6
                  WHERE NOT EXISTS (SELECT 1 FROM staff_role_approval
                                     WHERE staff_id = $2 AND role = $3::staff_role AND revoked_at IS NULL)''',
              ORG, sid, r, f"Approved for role ({appr.get('role', p['job'])})", u(1),
              T(appr.get('on') or (p.get('start') or '2025-01-01') + ' 09:00'))
    for k, it in p['items'].items():
        title, tpl = REQ[k]
        check(f'staff|{pid}|{k}', tpl, KIND.get(k, 'DUE'), 'STAFF', sid, STAFF_USER.get(pid), it,
              f"{title} – {p['name']}")
    for r in p.get('restr', []):
        ins('staff_restriction', id=U('restr', r['id']), organisation_id=ORG, staff_id=sid,
            type='NO_LONE_WORKING', detail=r['t'], reason=r['reason'], applied_by=who(r['by']),
            valid_from=T(r['on']), valid_to=T(r['until'], '23:59'))
# The base seed's line in its first lifecycle event still says "Seeded".

# ---- vehicles --------------------------------------------------------------------------------------
VEH_ID = {'AMB-01': '01900000-0000-7000-8000-000000000301', 'AMB-02': '01900000-0000-7000-8000-000000000302',
          'AMB-03': '01900000-0000-7000-8000-000000000303', 'AMB-05': U('veh', 'AMB-05'),
          'RRV-01': U('veh', 'RRV-01')}
VEH_SPEC = {  # type, seats, wheelchairs, stretcher, licence, kg, en1789, make, model, year, blue
    'AMB-01': ('AMBULANCE', 4, 1, True, 'C1', 4600, 'B', 'Mercedes-Benz', 'Sprinter 519', 2021, True),
    'AMB-02': ('PTS_VEHICLE', 6, 2, True, 'B', 3500, None, 'Peugeot', 'Boxer', 2021, False),
    'AMB-03': ('WAV', 4, 1, True, 'B', 3500, None, 'Ford', 'Transit', 2022, False),
    'AMB-05': ('PTS_VEHICLE', 6, 2, True, 'B', 3500, None, 'Renault', 'Master', 2023, False),
    'RRV-01': ('CAR', 2, 0, False, 'B', 2200, None, 'Skoda', 'Kodiaq', 2020, True),
}
DEF = S['def']
blocked = {d['veh'] for d in DEF.values() if d.get('stop') and d['stage'] != 'Signed off'}
for cs, v in S['veh'].items():
    vid = VEH_ID[cs]
    typ, seats, wc, strt, lic, kg, en, make, model, year, blue = VEH_SPEC[cs]
    reg = v['reg'].replace(' ', '')
    ins('vehicle', id=vid, organisation_id=ORG, registration=reg, callsign=cs, type=typ,
        base_location_id=LOC, seats=seats, wheelchair_capacity=wc, stretcher=strt, licence_category=lic,
        gross_weight_kg=kg, current_odometer=v['odo'], created_by=u(4))
    st = 'BLOCKED' if cs in blocked else 'AVAILABLE'
    q('''UPDATE vehicle SET registration = $2, type = $3::vehicle_type, seats = $4, wheelchair_capacity = $5,
           stretcher = $6, licence_category = $7, gross_weight_kg = $8, current_odometer = $9,
           en1789_type = $10, make = $11, model = $12, model_year = $13, blue_light_authorised = $14,
           status = $15::vehicle_status, status_reason = $16 WHERE id = $1''',
      vid, reg, typ, seats, wc, strt, lic, kg, v['odo'], en, make, model, year, blue, st,
      '1 open stop-use defect' if st == 'BLOCKED' else None)
    q('''INSERT INTO vehicle_location_history (organisation_id, vehicle_id, location_id, reason, moved_by)
         SELECT $1, $2, $3, 'v36 sample vehicle', $4
          WHERE NOT EXISTS (SELECT 1 FROM vehicle_location_history WHERE vehicle_id = $2)''',
      ORG, vid, LOC, u(4))
    for doc, tpl in [('MOT', 'AMB-VEH-01'), ('INS', 'AMB-VEH-02'), ('VED', 'AMB-VEH-03')]:
        it = dict(v['docs'].get(doc) or {'s': 'none'})
        it.setdefault('by', 'Dave Evans')
        it.setdefault('rcv', '2026-09-01')
        if it['s'] == 'ok':
            it['von'] = it['rcv']
        if it['s'] == 'rcv' and it.get('prevExp'):
            # Renewal uploaded while the current certificate is still valid.
            old = dict(it, s='ok', exp=it['prevExp'], vby='Dr. A. Vance', rcv='2025-11-20', file=None)
            key = f'veh|{cs}|{doc}'
            st2 = status('EXPIRY', it['prevExp'], it['prevExp'], True, True)
            instance(key, tpl, 'VEHICLE', vid, u(4), 'EXPIRY', it['prevExp'], st2)
            a = evidence(key + '|old', f'{doc} – {cs} (current)', 'VEHICLE', 'Dave Evans', '2025-11-20',
                         valid_to=it['prevExp'], vby='Dr. A. Vance', von='2025-11-21')
            b = evidence(key, f'{doc} – {cs} (renewal)', 'VEHICLE', it['by'], '2026-11-16',
                         file=it.get('file'), valid_to=it['exp'])
            link(key + '|old', a, tpl, 'VEHICLE', vid, 'Dave Evans')
            link(key, b, tpl, 'VEHICLE', vid, it['by'])
            continue
        check(f'veh|{cs}|{doc}', tpl, 'EXPIRY', 'VEHICLE', vid, u(4), it, f'{doc} – {cs}')
    svc = v['svc']
    q('''UPDATE maintenance_plan SET interval_days = 183, interval_miles = 12000, last_done_on = $2,
           last_done_odometer = $3 WHERE vehicle_id = $1 AND title = 'Scheduled service' ''',
      vid, D(svc['last']), svc['lastMi'])
    q('''INSERT INTO maintenance_plan (id, organisation_id, vehicle_id, title, interval_days, interval_miles,
             last_done_on, last_done_odometer, created_by)
         SELECT $1, $2, $3, 'Scheduled service', 183, 12000, $4, $5, $6
          WHERE NOT EXISTS (SELECT 1 FROM maintenance_plan WHERE vehicle_id = $3 AND title = 'Scheduled service')''',
      U('mp', cs), ORG, vid, D(svc['last']), svc['lastMi'], u(4))

# ---- daily check list v3 and the checks -----------------------------------------------------------
CL = S['cl'][0]
VDI_TPL = U('vdi-tpl', 'v3')
ITEMS = [{'code': f'C{i + 1:02d}', 'label': n, 'critical': bool(c)} for i, (n, c) in enumerate(CL['items'])]
ins('vdi_template', id=VDI_TPL, organisation_id=ORG, name='Daily vehicle check', version=3,
    items=J(ITEMS), active=True, status='PUBLISHED', created_by=u(4), published_by=u(5),
    published_at=T(CL['on'], '10:00'), created_at=T(CL['on'], '09:00'))
q("UPDATE vdi_template SET active = false WHERE organisation_id = $1 AND id <> $2", ORG, VDI_TPL)
if len(S['cl']) > 1:
    d4 = S['cl'][1]
    ins('vdi_template', id=U('vdi-tpl', 'v4'), organisation_id=ORG, name='Daily vehicle check', version=4,
        items=J([{'code': f'C{i + 1:02d}', 'label': n, 'critical': bool(c)} for i, (n, c) in enumerate(d4['items'])]),
        active=False, status='DRAFT', created_by=u(4), created_at=T(d4['on'], '09:00'))
# Publishing v3 retired the base seed's first list (v36 shows only the published and the draft).
q("""UPDATE vdi_template SET status = 'RETIRED' WHERE organisation_id = $1 AND status = 'PUBLISHED'
       AND NOT active AND id <> $2""", ORG, VDI_TPL, when='always')
CHECKER = {'Lee Davies': u(8), 'Alex Morgan': u(7), 'Dr. A. Vance': u(1), 'Tom Hughes': USERS['Tom Hughes']}
for c in S['checks']:
    vid = VEH_ID[c['veh']]
    fail = c['out'] != 'Pass'
    ins('vdi', id=U('vdi', c['id']), organisation_id=ORG, vehicle_id=vid, template_id=VDI_TPL,
        code=c['id'], checker_user_id=CHECKER.get(c['by'], u(8)), odometer=c['odo'],
        outcome='FAIL' if fail else 'PASS',
        client_submission_id=U('vdi-sub', c['id']), captured_at=T(c['date'], c['time']),
        received_at=T(c['date'], c['time']), notes=c['id'])
    for i, item in enumerate(ITEMS):
        r = c['res'].get(str(i), 'Pass')
        ins('vdi_item_result', id=U('vdi-item', c['id'], i), organisation_id=ORG, vdi_id=U('vdi', c['id']),
            item_code=item['code'], critical=item['critical'],
            result={'Pass': 'PASS', 'Fail': 'FAIL'}.get(r, 'NA'),
            reason=(c.get('notes') or {}).get(str(i)))
    ins('odometer_reading', id=U('odo', c['id']), organisation_id=ORG, vehicle_id=vid, reading=c['odo'],
        read_on=D(c['date']), source='VDI', recorded_by=CHECKER.get(c['by'], u(8)))
for key, cl in S['clean'].items():
    cs, d = key.split('|')
    by = cl['by']
    ins('cleaning_record', id=U('clean', key), organisation_id=ORG, vehicle_id=VEH_ID[cs], type='PRE_SHIFT',
        cleaned_by=CHECKER.get(by, USERS.get(by, u(8))), client_submission_id=U('clean-sub', key),
        captured_at=T(d, cl['t']), received_at=T(d, cl['t']), notes='Pre-shift IPC clean')
for dc in S.get('clean2', []):
    ins('cleaning_record', id=U('clean', dc['id']), organisation_id=ORG, vehicle_id=VEH_ID[dc['veh']],
        type='ENHANCED', cleaned_by=USERS.get(dc['by'], u(12)),
        checked_by=USERS.get(dc.get('vby') or 'Dr. Helen Price', u(5)),
        client_submission_id=U('clean-sub', dc['id']),
        captured_at=T(dc['on'], '14:00'), received_at=T(dc['on'], '14:00'),
        notes=f"{dc['id']} Scheduled deep clean · {dc.get('by', 'Mark Cox')} · checked by {dc.get('vby') or 'Dr. Helen Price'}")

# ---- defects ----------------------------------------------------------------------------------------
DEF_ID = {k: U('defect', k) for k in DEF}
# The base seed's two defects are not in v36: close them (a release is the only way a defect closes).
for old in ['01900000-0000-7000-8000-000000000321', '01900000-0000-7000-8000-000000000322']:
    q('''INSERT INTO defect_release (id, organisation_id, defect_id, released_by, reason)
         SELECT $1, $2, $3, $4, 'Closed: replaced by the v36 sample defects'
          WHERE EXISTS (SELECT 1 FROM defect WHERE id = $3 AND status <> 'RELEASED')
         ON CONFLICT DO NOTHING''', U('release', old), ORG, old, u(4))
    q("UPDATE defect SET status = 'RELEASED' WHERE id = $1 AND status <> 'RELEASED'", old)
DSTAGE = {'Reported': 'OPEN', 'In repair': 'REPAIRING', 'Signed off': 'REPAIRED'}
for code, d in DEF.items():
    did = DEF_ID[code]
    sev = d['sev'].upper()
    stt = DSTAGE.get(d['stage'], 'OPEN')
    vals = dict(organisation_id=ORG, vehicle_id=VEH_ID[d['veh']], severity=sev, stop_use=d['stop'],
                code=code, description=d['desc'], reported_by=who(d['by']), discovered_at=T(d['on']),
                status=stt, classified_by=u(4), owner_user_id=who(d.get('owner', 'Dave Evans')),
                review_by=D(d.get('review')),
                repair_notes=(d.get('sign') or {}).get('work') or (d.get('repair') or {}).get('plan'),
                repaired_at=T((d.get('sign') or {}).get('on')) if d.get('sign') else None,
                repaired_by=u(4) if d.get('sign') else None,
                source_vdi_id=U('vdi', d['from']) if d.get('from') else None)
    # C9: the repair plan apart from the sign-off, when and by whom the repair started, job sheet.
    rep, sign = d.get('repair') or {}, d.get('sign') or {}
    extra = dict(repair_plan=rep.get('plan'), repair_started_at=T(rep['on']) if rep else None,
                 repair_started_by=who(rep['by']) if rep else None, job_sheet_ref=sign.get('sheet'))
    ins('defect', id=did, **vals, **extra)
    if rep:  # existing databases loaded these defects before the columns existed
        q('''UPDATE defect SET repair_plan = $2, repair_started_at = $3, repair_started_by = $4, job_sheet_ref = $5
              WHERE id = $1 AND repair_started_at IS NULL AND status <> 'RELEASED' ''',
          did, extra['repair_plan'], extra['repair_started_at'], extra['repair_started_by'],
          extra['job_sheet_ref'], when='always')
q("""UPDATE alert SET source_id = $2, reason_text = 'Stop-use defect on AMB-03 (DEF-082): do not allocate until released'
      WHERE source_id = $1 AND reason_code = 'VEHICLE_BLOCKED'""", '01900000-0000-7000-8000-000000000321', DEF_ID['DEF-082'])
acc = S.get('acc') or []
for a in acc:
    ins('vehicle_accident', id=U('acc', a['id']), organisation_id=ORG, code=a['id'], vehicle_id=VEH_ID[a['veh']],
        occurred_at=T(a['on'], '10:00'), description=a['what'], third_party=a.get('tp') or 'None',
        injuries=False, roadworthy=True, reported_by=u(7), status='CLOSED' if a.get('closed') else 'OPEN')

# ---- equipment -----------------------------------------------------------------------------------
CAT = {'Stretcher': 'STRETCHER', 'Tail-lift': 'TAIL_LIFT', 'Wheelchair ramp': 'RAMP', 'Carry chair': 'CARRY_CHAIR',
       'Defibrillator': 'DEFIBRILLATOR', 'Suction unit': 'SUCTION'}
CAP = {'Stretcher': 'STRETCHER', 'Wheelchair': 'WHEELCHAIR', 'Clinical': 'CLINICAL'}
REG = {'LOLER': ('LOLER_THOROUGH', 'AMB-EQ-01'), 'Service': ('SERVICE', 'AMB-EQ-02'),
       'Calibration': ('CALIBRATION', 'ORG-EQ-01'), 'PAT': ('PAT', 'ORG-EQ-02')}
for e in S['eq']:
    aid = U('asset', e['id'])
    ins('equipment_asset', id=aid, organisation_id=ORG, asset_tag=e['id'], category=CAT[e['cat']],
        model=e['cat'], swl_kg=e.get('swl'), vehicle_id=VEH_ID.get(e['where']),
        capability=CAP.get(e.get('gives')), created_by=u(4))
    q('''UPDATE equipment_asset SET category = $3, vehicle_id = $4, swl_kg = $5, capability = $6, model = $7
          WHERE organisation_id = $1 AND asset_tag = $2''',
      ORG, e['id'], CAT[e['cat']], VEH_ID.get(e['where']), e.get('swl'), CAP.get(e.get('gives')), e['cat'])
    for r in e['reg']:
        regime, tpl = REG[r['k']]
        ev = r.get('ev') or {}
        it = {'s': ev.get('s', 'none'), 'by': ev.get('by'), 'vby': ev.get('vby'), 'rcv': r['last'],
              'von': r['last'], 'exp': r['due']}
        key = f"eq|{e['id']}|{r['k']}"
        sub = f"(SELECT id FROM equipment_asset WHERE organisation_id = '{ORG}' AND asset_tag = '{e['id']}')"
        # Instance keyed by the asset's real id (the base seed made STR-0001 with its own id).
        s = status('DUE', r['due'], None, ev.get('s') == 'ok', ev.get('s') == 'rcv')
        q(f'''INSERT INTO requirement_instance
                (id, organisation_id, location_id, template_id, template_version_id, subject_type, subject_id,
                 owner_user_id, due_date, status, reason_code, reason_text, currently_verified, computed_at, created_by)
              VALUES ($1, $2, $3, $4, $5, 'EQUIPMENT', {sub}, $6, $7, $8, $9, $10, $11, now(), $6)
              ON CONFLICT (organisation_id, template_id, subject_type, subject_id) DO UPDATE SET
                due_date = EXCLUDED.due_date, status = EXCLUDED.status, reason_code = EXCLUDED.reason_code,
                reason_text = EXCLUDED.reason_text, currently_verified = EXCLUDED.currently_verified,
                computed_at = now()''',
          U('ri', key), ORG, LOC, f'@TPL:{tpl}', f'@TPLV:{tpl}', u(4), D(r['due']), *s)
        q(f'''INSERT INTO inspection_regime (organisation_id, asset_id, regime, requirement_instance_id, source, created_by)
              SELECT $1, a.id, $2::inspection_regime_kind, ri.id, 'v36 sample regime', $3
                FROM equipment_asset a JOIN requirement_instance ri
                  ON ri.subject_id = a.id AND ri.subject_type = 'EQUIPMENT' AND ri.template_id = $4
               WHERE a.organisation_id = $1 AND a.asset_tag = $5
              ON CONFLICT DO NOTHING''', ORG, regime, u(4), f'@TPL:{tpl}', e['id'])
        if ev.get('s') in ('ok', 'rcv'):
            item = evidence(key, f"{r['k']} – {e['id']}", 'EQUIPMENT', ev.get('by') or 'Dave Evans', r['last'],
                            valid_to=None, vby=ev.get('vby') if ev.get('s') == 'ok' else None, von=r['last'])
            q(f'''INSERT INTO evidence_link (id, organisation_id, item_id, instance_id, created_by)
                  SELECT $1, $2, $3, ri.id, $4 FROM requirement_instance ri
                   WHERE ri.organisation_id = $2 AND ri.template_id = $5 AND ri.subject_type = 'EQUIPMENT'
                     AND ri.subject_id = {sub}
                  ON CONFLICT DO NOTHING''', U('ln', key), ORG, item, u(4), f'@TPL:{tpl}')

    # The starter regimes (LOLER, service) apply to every asset unless decided otherwise: record the
    # v36 decision so a later base seed does not add checks v36 does not have.
    for tpl in ['AMB-EQ-01', 'AMB-EQ-02']:
        if any(REG[r['k']][1] == tpl for r in e['reg']):
            continue
        sub = f"(SELECT id FROM equipment_asset WHERE organisation_id = '{ORG}' AND asset_tag = '{e['id']}')"
        q(f'''INSERT INTO requirement_instance
                (id, organisation_id, location_id, template_id, template_version_id, subject_type, subject_id,
                 applicability, status, reason_code, reason_text, currently_verified, computed_at, created_by)
              VALUES ($1, $2, $3, $4, $5, 'EQUIPMENT', {sub}, 'APPROVED_NOT_APPLICABLE', 'NOT_APPLICABLE',
                      'NOT_APPLICABLE', 'Approved as not applicable', false, now(), $6)
              ON CONFLICT DO NOTHING''', U('ri-na', e['id'], tpl), ORG, LOC, f'@TPL:{tpl}', f'@TPLV:{tpl}', u(4))
        q(f'''UPDATE requirement_instance ri SET applicability = 'APPROVED_NOT_APPLICABLE', status = 'NOT_APPLICABLE',
                reason_code = 'NOT_APPLICABLE', reason_text = 'Approved as not applicable', effect = 'NONE'
              WHERE ri.organisation_id = $1 AND ri.template_id = $2 AND ri.subject_type = 'EQUIPMENT'
                AND ri.subject_id = {sub} AND ri.status = 'GREY' AND ri.reason_code = 'MISSING'
                AND NOT EXISTS (SELECT 1 FROM evidence_link l WHERE l.instance_id = ri.id)''',
          ORG, f'@TPL:{tpl}', when='always')

# ---- incidents and complaints ---------------------------------------------------------------------
EV_ID = {'EVT-2026-044': '01900000-0000-7000-8000-000000000521'}
ESTAGE = {'Reported': 'TRIAGE', 'Triaged': 'ASSESS', 'Investigating': 'INVESTIGATE',
          'Findings & learning': 'RESPOND', 'Actions in progress': 'ACTIONS', 'Awaiting closure': 'LEARNING_VERIFIED',
          'Closed': 'CLOSED'}
HARM = {'No harm': 'NO_HARM', 'Low harm': 'LOW', 'Moderate harm': 'MODERATE', 'Severe harm': 'SEVERE', None: 'NO_HARM'}
ETYPE = {'Complaint': 'COMPLAINT', 'Incident': 'INCIDENT', 'Accident': 'ACCIDENT', 'Near miss': 'NEAR_MISS'}
ECAT = {'EVT-2026-040': 'PATIENT_CARE', 'EVT-2026-042': 'PATIENT_CARE', 'EVT-2026-043': 'STAFF_INJURY',
        'EVT-2026-044': 'MOVING_AND_HANDLING', 'EVT-2026-045': 'EQUIPMENT'}
PRIO = {'NO_HARM': 'LOW', 'LOW': 'MEDIUM', 'MODERATE': 'HIGH', 'SEVERE': 'CRITICAL'}
for code, e in S['inc'].items():
    eid = EV_ID.setdefault(code, U('event', code))
    stg = ESTAGE[e['stage']]
    sev = HARM[e.get('harm')]
    triaged = stg != 'TRIAGE'
    stamps = e.get('stamps', {})
    vals = dict(organisation_id=ORG, code=code, types=[ETYPE[t] for t in e['type']], title=e['title'],
                description=e['what'], occurred_at=T(e['when']), discovered_at=T(e['on']), location_id=LOC,
                severity=sev, lead_user_id=who(e.get('lead') or 'Dr. Helen Price'), status=stg,
                reported_by=who(e['by']), place=e.get('place'), immediate_actions=e.get('imm'),
                nhs_funded=bool(e.get('nhs')), category=ECAT.get(code) if triaged else None,
                priority=PRIO[sev] if triaged else None,
                triaged_at=T(stamps.get('Triaged')) if triaged else None,
                triaged_by=u(5) if triaged else None, learning_notes=e.get('learning'),
                contributory_factors=e.get('findings'), created_by=who(e['by']), created_at=T(e['on']))
    ins('event', id=eid, **vals)
    cols = [k for k in vals if k not in ('organisation_id', 'created_by', 'created_at')]
    q('UPDATE event SET ' + ', '.join(f'{k} = ${i + 2}' for i, k in enumerate(cols)) + ' WHERE id = $1',
      eid, *[vals[k] for k in cols])
    prev = None
    for i, (name, at) in enumerate(stamps.items()):
        to = ESTAGE.get(name, 'TRIAGE' if name == 'Reported' else None)
        if not to or to == prev:
            continue
        ins('event_transition', id=U('evt-tr', code, i), organisation_id=ORG, event_id=eid, from_status=prev,
            to_status=to, note=name, by_user_id=u(5) if i else who(e['by']), at=T(at))
        prev = to
    if 'COMPLAINT' in vals['types']:
        rec = e['on'].split(' ')[0]
        d0 = date.fromisoformat(rec)
        ins('complaint_detail', event_id=eid, organisation_id=ORG, received_on=D(rec), channel='PHONE',
            acknowledge_by=D(str(d0 + timedelta(days=3))), respond_by=D(str(d0 + timedelta(days=20))),
            acknowledged_on=D(str(d0 + timedelta(days=1))),
            responded_on=D((e.get('closed') or {}).get('on', '').split(' ')[0] or None),
            outcome='UPHELD' if e.get('closed') else None)
q("UPDATE org_counter SET value = GREATEST(value, 45) WHERE organisation_id = $1 AND prefix = 'EVT'", ORG)

# ---- audit templates, audits and actions --------------------------------------------------------
KQ = {'Safe': 'SAFE', 'Effective': 'EFFECTIVE', 'Caring': 'CARING', 'Responsive': 'RESPONSIVE', 'Well-led': 'WELL_LED'}
for code, t in S['tpl'].items():
    pub = t['state'] == 'Published'
    q('UPDATE audit_template SET title = $3, domain = $4::quality_domain, active = $5 WHERE organisation_id = $1 AND code = $2',
      ORG, code, t['n'], KQ[t['kq']], pub)
    controls = [{'code': f'{code}-{chr(65 + i)}', 'question': c, 'failureAction': 'Raise an action with an owner and a date',
                 'critical': i == 0} for i, c in enumerate(t['ctl'])]
    if pub:
        # A draft is published with the v36 controls; a template already published gets a new version
        # (published versions are immutable) and the old one is retired.
        q('''UPDATE audit_template_version v SET status = 'PUBLISHED', controls = $3::jsonb,
               approved_by = coalesce(v.approved_by, $4), approved_at = coalesce(v.approved_at, now()),
               sample_size = coalesce(v.sample_size, 5)
              WHERE v.id = (SELECT v2.id FROM audit_template_version v2 JOIN audit_template t ON t.id = v2.template_id
                             WHERE t.organisation_id = $1 AND t.code = $2 AND v2.status = 'DRAFT'
                             ORDER BY v2.version DESC LIMIT 1)
                AND NOT EXISTS (SELECT 1 FROM audit_template_version v3 JOIN audit_template t ON t.id = v3.template_id
                                 WHERE t.organisation_id = $1 AND t.code = $2 AND v3.status = 'PUBLISHED')''',
          ORG, code, J(controls), who(t.get('pub', 'Dr. A. Vance')))
        q('''INSERT INTO audit_template_version (id, organisation_id, template_id, version, status, controls,
               sample_method, sample_size, methods, approved_by, approved_at, created_by)
             SELECT $3, $1, t.id, (SELECT max(version) + 1 FROM audit_template_version WHERE template_id = t.id),
                    'PUBLISHED', $4::jsonb, 'Random sample of records for the period', 5,
                    '{RECORDS,OBSERVATION,INTERVIEW}', $5, now(), $6
               FROM audit_template t
              WHERE t.organisation_id = $1 AND t.code = $2
                AND EXISTS (SELECT 1 FROM audit_template_version v WHERE v.template_id = t.id AND v.status = 'PUBLISHED'
                             AND NOT v.controls @> $4::jsonb)
             ON CONFLICT DO NOTHING''',
          ORG, code, U('atv', code), J(controls), who(t.get('pub', 'Dr. A. Vance')), who(t['by']))
        q('''UPDATE audit_template_version v SET status = 'RETIRED'
              FROM audit_template t WHERE t.id = v.template_id AND t.organisation_id = $1 AND t.code = $2
               AND v.status = 'PUBLISHED' AND v.id <> $3
               AND EXISTS (SELECT 1 FROM audit_template_version n WHERE n.id = $3)''', ORG, code, U('atv', code))
    else:
        q('''UPDATE audit_template_version v SET controls = $3::jsonb
              WHERE v.id = (SELECT v2.id FROM audit_template_version v2 JOIN audit_template t ON t.id = v2.template_id
                             WHERE t.organisation_id = $1 AND t.code = $2 AND v2.status = 'DRAFT'
                             ORDER BY v2.version DESC LIMIT 1)''', ORG, code, J(controls))
AUD_ID = {'AUD-102': '01900000-0000-7000-8000-000000000401', 'AUD-103': '01900000-0000-7000-8000-000000000402'}
ASTAGE = {'Scheduled': 'SCHEDULED', 'In progress': 'IN_PROGRESS', 'Submitted – actions open': 'ACTIONS_OPEN',
          'Closed': 'CLOSED', 'Submitted': 'SUBMITTED'}
for code, a in S['aud'].items():
    rid = AUD_ID.setdefault(code, U('audit', code))
    stg = ASTAGE[a['stage']]
    tv = (f"(SELECT v.id FROM audit_template_version v JOIN audit_template t ON t.id = v.template_id "
          f"WHERE t.organisation_id = '{ORG}' AND t.code = '{a['tpl']}' AND v.status = 'PUBLISHED' "
          f"ORDER BY v.version DESC LIMIT 1)")
    res = a.get('res') or {}
    fails = sum(1 for r in res.values() if r == 'Fail')
    outcome = None if stg == 'SCHEDULED' else ('GREEN' if stg == 'CLOSED' else 'RED')
    reason = None if not outcome else ('Actions verified' if stg == 'CLOSED' else 'Action outstanding')
    d = date.fromisoformat(a['due'])
    q(f'''INSERT INTO audit_run (id, organisation_id, code, template_version_id, location_id, title, period_from,
             period_to, auditor_user_id, owner_user_id, due_date, status, outcome, outcome_reason, submitted_at,
             created_by, recurrence_months)
          VALUES ($1, $2, $3, {tv}, $4, $5, $6, $7, $8, $9, $10, $11::audit_run_status, $12::rag_status, $13, $14, $8, $15)
          ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, title = EXCLUDED.title, due_date = EXCLUDED.due_date,
            status = EXCLUDED.status, outcome = EXCLUDED.outcome, outcome_reason = EXCLUDED.outcome_reason,
            auditor_user_id = EXCLUDED.auditor_user_id, owner_user_id = EXCLUDED.owner_user_id,
            period_from = EXCLUDED.period_from, period_to = EXCLUDED.period_to,
            template_version_id = EXCLUDED.template_version_id''',
      rid, ORG, code, LOC, a['t'], D(str(d - timedelta(days=21))), D(a['due']), who(a['auditor']),
      who(a['owner']), D(a['due']), stg, outcome, reason,
      T(a['due'], '16:00') if stg != 'SCHEDULED' else None, None)
    if res and code != 'AUD-102':
        fid = U('finding', code)
        ins('audit_finding', id=fid, organisation_id=ORG, run_id=rid, control_code=f"{a['tpl']}-A",
            pass_count=len(res) - fails, fail_count=fails, result='NON_COMPLIANT' if fails else 'COMPLIANT',
            severity='HIGH' if fails else 'LOW', summary=f'{len(res) - fails} pass / {fails} fail', created_by=who(a['auditor']))
q("UPDATE audit_run SET reaudit_of = $2 WHERE id = $1", AUD_ID['AUD-103'], AUD_ID['AUD-102'])
q('''INSERT INTO org_counter (organisation_id, prefix, value) VALUES ($1, 'AUD', 104), ($1, 'ACT', 221), ($1, 'J', 260)
     ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = GREATEST(org_counter.value, EXCLUDED.value)''', ORG)

ACT_ID = {'ACT-218': '01900000-0000-7000-8000-000000000421', 'ACT-219': '01900000-0000-7000-8000-000000000422'}
ACTSTATE = {'Open': 'OPEN', 'Ready for verification': 'EVIDENCE_SUBMITTED', 'Verified': 'VERIFIED'}
for code, a in S['act'].items():
    aid = ACT_ID.setdefault(code, U('action', code))
    src = a['src']
    if src.startswith('Audit '):
        stype = 'FINDING'
        acode = src.split(' ')[1]
        sid = '01900000-0000-7000-8000-000000000411' if acode == 'AUD-102' else U('finding', acode)
    else:
        stype = 'EVENT'
        sid = EV_ID[src.split(' ')[1]]
    st = ACTSTATE[a['state']]
    kind = 'REAUDIT' if a['t'].lower().startswith('re-audit') else 'ACTION'
    ev_ids = []
    ev = a.get('ev')
    if ev:
        on = ev['on'].split(' ')[0]
        ev_ids = [evidence(f'act|{code}', f"{a['t']} – evidence", 'ACTION', ev['by'], on, file=ev.get('file'))]
    vals = dict(organisation_id=ORG, code=code, source_type=stype, source_id=sid, kind=kind, title=a['t'],
                severity='HIGH' if stype == 'FINDING' else 'MEDIUM', owner_user_id=who(a['owner']),
                deadline=D(a['due']), status=st, evidence_item_ids=ev_ids,
                evidence_by=who(ev['by']) if ev else None,
                verifier_user_id=who(a['ver']['by']) if a.get('ver') else None,
                verified_at=T(a['ver']['on']) if a.get('ver') else None,
                reaudit_run_id=AUD_ID['AUD-103'] if code == 'ACT-219' else None, created_by=u(5))
    ins('action', id=aid, **vals)
    cols = [k for k in vals if k not in ('organisation_id', 'created_by')]
    q('UPDATE action SET ' + ', '.join(f'{k} = ${i + 2}' for i, k in enumerate(cols)) + ' WHERE id = $1',
      aid, *[vals[k] for k in cols])
    ins('action_history', id=U('act-h', code, 0), organisation_id=ORG, action_id=aid, to_status='OPEN',
        note='Created', by_user_id=u(5))
    if st != 'OPEN':
        ins('action_history', id=U('act-h', code, 1), organisation_id=ORG, action_id=aid,
            to_status='EVIDENCE_SUBMITTED', note=(ev or {}).get('note') or 'Evidence uploaded', by_user_id=who(ev['by']))
    if st == 'VERIFIED':
        ins('action_history', id=U('act-h', code, 2), organisation_id=ORG, action_id=aid, to_status='VERIFIED',
            note='Verified', by_user_id=who(a['ver']['by']))

# ---- premises -------------------------------------------------------------------------------------
for p in S['prem']:
    code = f"ORG-PRM-{p['id'][3:]}"
    nxt = str(date.fromisoformat(p['last']) + timedelta(days=p['freq']))
    ev = p['ev']
    it = {'s': ev['s'], 'by': ev.get('by'), 'vby': ev.get('vby'), 'rcv': p['last'], 'von': p['last'],
          'due': nxt, 'file': ev.get('file')}
    key = f"prem|{p['id']}"
    # Verified evidence keeps the item in date until the next check is due.
    st = status('DUE', nxt, None, ev['s'] == 'ok', ev['s'] == 'rcv')
    instance(key, code, 'PREMISES', LOC, who(p['owner']), 'DUE', nxt, st)
    if ev['s'] in ('ok', 'rcv'):
        item = evidence(key, f"{p['item']} – {p['last']}", 'PREMISES', ev.get('by') or p['owner'], p['last'],
                        file=ev.get('file'), vby=ev.get('vby') if ev['s'] == 'ok' else None, von=p['last'])
        link(key, item, code, 'PREMISES', LOC, ev.get('by') or p['owner'])
    months = max(1, round(p['freq'] / 30)) if p['freq'] >= 28 else None
    q(f'''INSERT INTO premises_item (id, organisation_id, location_id, control_area, title, responsible_user_id,
             frequency_source, requirement_instance_id, applicable, area_name, interval_months, action_owner_user_id, created_by)
          SELECT $1, $2, $3, $4::premises_area, $5, $6, $7, ri.id, true, $8, $9, $6, $6
            FROM requirement_instance ri WHERE ri.organisation_id = $2 AND ri.template_id = $10
             AND ri.subject_type = 'PREMISES' AND ri.subject_id = $3
          ON CONFLICT DO NOTHING''',
      U('prem', p['id']), ORG, LOC, PREM_AREA[p['area']], p['item'], who(p['owner']),
      f"Every {p['freq']} day{'s' if p['freq'] != 1 else ''} ({p['id']})", p['area'], months if months and months <= 120 else None,
      f'@TPL:{code}')

# ---- policies -------------------------------------------------------------------------------------
PCAT = {'Policy': 'POLICY', 'SOP': 'SOP', 'Critical instruction': 'CRITICAL_INSTRUCTION', 'Guidance': 'GUIDANCE'}
JOB_ROLES = {'Paramedic': 'PARAMEDIC', 'Technician': 'TECHNICIAN', 'Emergency care assistant': 'EMERGENCY_CARE_ASSISTANT'}
for p in S['pol']:
    did = U('policy', p['id'])
    every = p['roles'] == 'All'
    ins('policy_document', id=did, organisation_id=ORG, code=p['code'], title=p['t'], category=PCAT[p['type']],
        owner_user_id=who(p['owner']), reader_roles=[] if every else [JOB_ROLES[r] for r in p['roles'].split(',')],
        reader_everyone=every, created_by=who(p['owner']))
    pub = p['state'] == 'Published'
    vid = U('policy-v', p['id'], p['v'])
    ins('policy_version', id=vid, organisation_id=ORG, document_id=did, version=p['v'],
        status='PUBLISHED' if pub else 'DRAFT', summary=p.get('summary') or f"Version {p['v']} of {p['t']}.",
        material=True, effective_from=D(p.get('on')), review_date=D(p.get('review')),
        approved_by=who(p['pub']) if pub else None, approved_at=T(p.get('on')) if pub else None,
        published_at=T(p.get('on')) if pub else None, created_by=who(p.get('drafted') or p['owner']),
        created_at=T(p.get('on') or '2026-11-10'))
    for pid, on in p.get('ack', {}).items():
        uid = STAFF_USER.get(pid)
        if uid:
            ins('policy_acknowledgement', id=U('ack', p['id'], pid), organisation_id=ORG, policy_version_id=vid,
                user_id=uid, device='web', at=T(on, '12:00'))

# ---- risks ----------------------------------------------------------------------------------------
RCAT = {'RSK-01': 'WORKFORCE', 'RSK-02': 'FLEET', 'RSK-03': 'HARASSMENT', 'RSK-04': 'INFORMATION',
        'RSK-05': 'PREMISES', 'RSK-06': 'WORKFORCE'}
for r in S['risk']:
    rid = U('risk', r['id'])
    ins('risk', id=rid, organisation_id=ORG, code=r['id'], title=r['h'][:200], hazard=r['h'], people_affected=r['who'],
        inherent_likelihood=r['l0'], inherent_impact=r['i0'], controls=r['ctl'], residual_likelihood=r['l1'],
        residual_impact=r['i1'], owner_user_id=who(r['owner']), review_date=D(r['review']), location_id=LOC,
        status='OPEN', category=RCAT.get(r['id'], 'OTHER'), created_by=who(r['owner']))
    for i, h in enumerate(r.get('hist', [])):
        ins('risk_review', id=U('risk-r', r['id'], i), organisation_id=ORG, risk_id=rid,
            residual_likelihood=r['l1'], residual_impact=r['i1'], controls=r['ctl'],
            note=f"Reviewed – score {h['s']}", next_review_on=D(r['review']), reviewed_by=who(r['owner']),
            reviewed_at=T(h['on'], '11:00'))
q('''INSERT INTO org_counter (organisation_id, prefix, value) VALUES ($1, 'RSK', 6)
     ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = GREATEST(org_counter.value, EXCLUDED.value)''', ORG)

# ---- supervision, reviews, absence, leavers --------------------------------------------------------
SUPK = {'One to one': 'ONE_TO_ONE', 'Return to work': 'RETURN_TO_WORK', 'Clinical': 'CLINICAL'}
for s in S['sup']:
    if s['state'] == 'Requested' or not s.get('sup'):
        continue
    sid = STAFF_ID[s['who']]
    state = {'Booked': 'BOOKED', 'Held': 'HELD', 'Missed': 'MISSED'}[s['state']]
    bid = U('sup', s['id'])
    rec = None
    if state == 'HELD':
        rec = U('sup-rec', s['id'])
        ins('staff_record', id=rec, organisation_id=ORG, staff_id=sid, kind='SUPERVISION',
            data=J({'summary': s.get('outcome') or 'Held', 'wellbeing': 'No concerns raised', 'attendance': 'HELD',
                    'heldOn': f"@D:{s['date']}"}), valid_from=D(s['date']), created_by=who(s.get('rec', 'Samira Patel')))
    vals = dict(organisation_id=ORG, staff_id=sid, supervisor_user_id=who(s['sup']),
                code=s['id'], scheduled_at=T(s['date'], '10:00'), kind=SUPK.get(s['type'], 'ONE_TO_ONE'),
                topics=s.get('topics'),
                status=state, status_reason='Crew member did not attend' if state == 'MISSED' else None,
                record_id=rec, booked_by=u(2), closed_by=u(2) if state != 'BOOKED' else None)
    ins('supervision_booking', id=bid, **vals)
# C3: staff-requested supervision (SUP-302) – exact HANDOVER row.
ins('supervision_booking', id=U('sup', 'SUP-302'), organisation_id=ORG,
    staff_id=STAFF_ID['ST-0042'], supervisor_user_id=None, code='SUP-302',
    scheduled_at=T('2026-11-29', '10:00'), kind='ONE_TO_ONE',
    topics='Bariatric transfers – would like more practice', status='REQUESTED',
    status_reason=None, record_id=None, booked_by=u(7), requested_by=u(7), closed_by=None)
# C6 catch-up: existing DBs got generic SUP-2xx codes from migration 0055; set the v36 codes.
for s in S['sup']:
    q(f"UPDATE supervision_booking SET code = '{s['id']}' WHERE id = $1 AND (code IS NULL OR code <> '{s['id']}')",
      U('sup', s['id']), when='always')
# The base seed's three bookings point at the v36 people instead.
q('''UPDATE supervision_booking SET staff_id = $1, scheduled_at = $2, kind = 'ONE_TO_ONE', topics = 'Quarterly review',
       supervisor_user_id = $3 WHERE id = '01900000-0000-7000-8000-000000000502' ''',
  STAFF_ID['ST-0043'], T('2026-09-12', '10:00'), USERS['Samira Patel'])
q('''UPDATE supervision_booking SET scheduled_at = $1, supervisor_user_id = $2
      WHERE id IN ('01900000-0000-7000-8000-000000000501', '01900000-0000-7000-8000-000000000503')''',
  T('2026-12-01', '10:00'), USERS['Samira Patel'])
REVK = {'Probation – 3 months': 'PROBATION_3M', 'Probation – 6 months': 'PROBATION_6M', 'Annual appraisal': 'APPRAISAL'}
for r in S['rev']:
    done = r['state'] == 'Done'
    ins('staff_review', id=U('rev', r['id']), organisation_id=ORG, code=r['id'], staff_id=STAFF_ID[r['pid']],
        kind=REVK[r['type']], due_on=D(r['due']), status='DONE' if done else 'SCHEDULED',
        outcome='MEETS' if done else None, objectives=r.get('obj'), reviewed_on=D(r.get('on')) if done else None,
        reviewer_user_id=who(r.get('by', 'Samira Patel')) if done else None, recorded_by=u(2) if done else None,
        notes='Annual appraisal held' if done else None, created_by=u(2))
ABSK = {'Musculoskeletal': 'MUSCULOSKELETAL', 'Respiratory': 'RESPIRATORY', 'Gastrointestinal': 'GASTROINTESTINAL',
        'Other': 'OTHER'}
for a in S['sick']:
    rtw = a.get('rtw') or {}
    phased = bool(rtw.get('phased'))
    ins('staff_absence', id=U('abs', a['id']), organisation_id=ORG, code=a['id'], staff_id=STAFF_ID[a['pid']],
        first_day=D(a['from']), last_day=D(a.get('to')), category=ABSK.get(a['cat'], 'OTHER'),
        rtw_on=D(rtw.get('on')), rtw_by_user_id=who(rtw['by']) if rtw else None,
        rtw_recorded_by=u(2) if rtw else None, rtw_note=rtw.get('note'), phased=phased,
        phased_terms='No lifting over 25 kg' if phased else None,
        phased_until=D(str(date.fromisoformat(rtw['on']) + timedelta(days=28))) if phased else None,
        recorded_by=u(2))
for lv in S['leave']:
    ck = lv.get('ck', {})
    ins('leaver_record', id=U('leave', lv['id']), organisation_id=ORG, code=lv['id'], staff_id=STAFF_ID[lv['pid']],
        last_day=D(lv['last']), reason='RESIGNED', reason_note=lv['why'], status='OPEN',
        payroll_told_at=T(lv['on'], '12:00') if ck.get('pay') else None,
        payroll_told_by=u(2) if ck.get('pay') else None, started_by=who(lv['by']), created_at=T(lv['on'], '11:00'))

# ---- safeguarding ---------------------------------------------------------------------------------
SGC = {'Self-neglect': 'SELF_NEGLECT', 'Financial or material abuse': 'FINANCIAL', 'Neglect': 'NEGLECT'}
for g in S['sgr']:
    referred = bool(g.get('to'))
    closed = g['state'].startswith('Closed')
    ins('safeguarding_referral', id=U('sgr', g['id']), organisation_id=ORG, code=g['id'], about=g['who'].upper(),
        category=SGC.get(g['cat'], 'OTHER'), patient_ref=g['pt'],
        details=f"{g['cat']} concern raised by {g['by']} for {g['pt']}.", raised_by_user_id=who(g['by'], 'Alex Morgan'),
        raised_on=D(g['on']), recorded_by=u(5), abuse_allegation=False,
        status='CLOSED' if closed else ('REFERRED' if referred else 'RAISED'),
        referred_on=D(g['on']) if referred else None, agency=g['to'] or None, agency_reference=g['ref'] or None,
        decided_by=u(5) if referred else None, outcome=g.get('out') if closed else None,
        outcome_on=D(str(date.fromisoformat(g['on']) + timedelta(days=21))) if closed else None,
        closed_by=u(5) if closed else None)

# ---- work planner: shifts, crews and jobs ---------------------------------------------------------
MOB = {'Wheelchair': 'WHEELCHAIR', 'Stretcher': 'STRETCHER', 'Walking': 'WALKING', 'Carry chair': 'CARRY_CHAIR',
       'Response': 'WALKING'}
by_day_veh = {}
for r in S['rota']:
    if r.get('veh'):
        by_day_veh.setdefault((r['date'], r['veh']), []).append(r)


def hm(t):
    h, m = t.split(':')
    return int(h) * 60 + int(m)


def at(d, minutes):
    """A London time `minutes` after midnight on day `d` (may run into the next day)."""
    day = date.fromisoformat(d) + timedelta(days=minutes // 1440)
    m = minutes % 1440
    return T(str(day), f'{m // 60:02d}:{m % 60:02d}')


def span(r):
    s0, e0 = hm(r['start']), hm(r['end'])
    return s0, e0 + 1440 if e0 <= s0 else e0


SHIFT = {}
for (d, cs), rs in by_day_veh.items():
    start = min(span(r)[0] for r in rs)
    end = max(span(r)[1] for r in rs)
    end = min(end, start + 16 * 60)
    sid = U('shift', d, cs)
    SHIFT[(d, cs)] = (sid, start, end)
    state = 'ENDED' if all(r['state'] == 'Ended' for r in rs) else 'PLANNED'
    ins('shift', id=sid, organisation_id=ORG, location_id=LOC, vehicle_id=VEH_ID[cs], starts_at=at(d, start),
        ends_at=at(d, end), state=state, created_by=u(3))
    for i, r in enumerate(rs):
        if r['pid'] not in STAFF_ID:
            continue
        s0, e0 = span(r)
        ins('crew_assignment', id=U('crew', r['id']), organisation_id=ORG, shift_id=sid, staff_id=STAFF_ID[r['pid']],
            role='DRIVER' if i == 0 else ROLE.get(S['people'][r['pid']]['job'], 'CARE_ASSISTANT'),
            starts_at=at(d, s0), ends_at=at(d, min(e0, end)), active=True, created_by=u(3))
jobs = [(BASE, j) for j in S['jobs']] + [(d, j) for d, js in S['fjobs'].items() for j in js]
for d, j in jobs:
    if j.get('veh') and j.get('crew') and (d, j['veh']) not in SHIFT:
        sid = U('shift', d, j['veh'])
        SHIFT[(d, j['veh'])] = (sid, 7 * 60, 19 * 60)
        ins('shift', id=sid, organisation_id=ORG, location_id=LOC, vehicle_id=VEH_ID[j['veh']], starts_at=at(d, 420),
            ends_at=at(d, 1140), state='PLANNED', created_by=u(3))
        for i, pid in enumerate([j['crew'], j.get('crew2')]):
            if pid in STAFF_ID:
                ins('crew_assignment', id=U('crew', d, j['veh'], pid), organisation_id=ORG, shift_id=sid,
                    staff_id=STAFF_ID[pid], role='DRIVER' if i == 0 else ROLE.get(S['people'][pid]['job'], 'CARE_ASSISTANT'),
                    starts_at=at(d, 420), ends_at=at(d, 1140), active=True, created_by=u(3))
jobs = [(BASE, j) for j in S['jobs']] + [(d, j) for d, js in S['fjobs'].items() for j in js]
for d, j in jobs:
    jid = U('job', j['id'])
    bid = U('booking', j['id'])
    ins('booking', id=bid, organisation_id=ORG, customer='West Herts NHS Trust', reference=j['id'],
        contract_type='NHS', nhs_eligibility_met=True, nhs_eligibility_criteria='Medical need for transport',
        nhs_eligibility_assessed_by='Booking team', created_by=u(3))
    start = hm(j['time'])
    end = start + j['dur']
    st, en = f'{start // 60:02d}:{start % 60:02d}', f'{min(end, 1439) // 60:02d}:{min(end, 1439) % 60:02d}'
    pf = max(0, start - 15)
    shift = SHIFT.get((d, j['veh'])) if j.get('veh') else None
    allocated = bool(shift and j.get('crew'))
    ins('job', id=jid, organisation_id=ORG, code=j['id'], booking_id=bid, location_id=LOC, journey_date=D(d),
        pickup_from=T(d, f'{pf // 60:02d}:{pf % 60:02d}'), pickup_to=T(d, f'{(start + 15) // 60:02d}:{(start + 15) % 60:02d}'),
        planned_start=T(d, st), planned_end=T(d, en), pickup_address='Watford General Hospital, Vicarage Road',
        destination_address='Patient home, Watford', patient_ref=j['pt'], mobility=MOB.get(j['mob'], 'WALKING'),
        escorts=0, crew_size=1 if j['mob'] == 'Response' else 2, blue_lights=j['mob'] == 'Response',
        state='ALLOCATED' if allocated else 'BOOKED', created_by=u(3))
    if allocated:
        sid = shift[0]
        ins('job_allocation', id=U('alloc', j['id']), organisation_id=ORG, job_id=jid, shift_id=sid,
            starts_at=T(d, st), ends_at=T(d, en), active=True, validated_at=T(d, '06:00'),
            validation_result=J({'ok': True, 'checks': [], 'source': 'v36 sample'}), allocated_by=u(3))

# ---- shifts: open shifts, swaps and patterns (v36 derives these; loaded on every start, idempotent) --
# They go in `always` so an organisation that loaded the first batch earlier still gets them; fixed IDs
# and ON CONFLICT DO NOTHING mean a row is only ever added once and later changes in the app stay.
def ins_always(table, **v):
    always.append({'i': table, 'v': v})


# v36 openShifts(): planned rota shifts in the next 7 days for someone who is off sick.
off_sick = {a['pid']: a for a in S['sick'] if not a.get('to')}
n = 0
for r in sorted(S['rota'], key=lambda r: (r['date'], r['start'])):
    gap = (date.fromisoformat(r['date']) - TODAY).days
    if r['state'] != 'Planned' or not (0 <= gap < 7) or r['pid'] not in off_sick or not r.get('veh'):
        continue
    if (r['date'], r['veh']) not in SHIFT:
        continue
    n += 1
    s0, e0 = span(r)
    who = S['people'][r['pid']]
    ins_always('open_shift', id=U('open-shift', r['id']), organisation_id=ORG, code=f'OS-{n:02d}',
               shift_id=SHIFT[(r['date'], r['veh'])][0], role=ROLE.get(who['job'], 'CARE_ASSISTANT'),
               starts_at=at(r['date'], s0), ends_at=at(r['date'], e0),
               note=f"{who['name']} – off sick ({off_sick[r['pid']]['cat'].lower()})", status='OPEN',
               posted_by=u(3))

# Swaps (v36 S.swaps): "Colleague agreed" waits for a manager's decision.
SWAP_STATE = {'Requested': 'REQUESTED', 'Colleague agreed': 'AGREED', 'Approved': 'APPROVED',
              'Declined': 'DECLINED'}
rota_by_id = {r['id']: r for r in S['rota']}
for w in S.get('swaps', []):
    a, b = rota_by_id.get(w['shA']), rota_by_id.get(w['shB'])
    if not a or not b or not a.get('veh') or not b.get('veh'):
        continue
    st = SWAP_STATE.get(w['state'], 'REQUESTED')
    ins_always('shift_swap_request', id=U('swap', w['id']), organisation_id=ORG, code=w['id'],
               from_assignment_id=U('crew', w['shA']), to_assignment_id=U('crew', w['shB']),
               from_staff_id=STAFF_ID[w['from']], to_staff_id=STAFF_ID[w['to']], reason=w['why'],
               status=st, requested_by=u(3),
               agreed_at=T(w['on'], '12:00') if st in ('AGREED', 'APPROVED') else None,
               created_at=T(w['on'], '09:00'))

# Shift patterns (v36 PATS): Early, Day, Late and Night.
PATS = [('E', 'Early', '06:00', '14:00', 30), ('D', 'Day', '07:00', '19:00', 60),
        ('L', 'Late', '14:00', '22:00', 30), ('N', 'Night', '19:00', '07:00', 60)]
for code, name, st_, en_, brk in PATS:
    ins_always('shift_pattern', id=U('pattern', code), organisation_id=ORG, code=code, name=name,
               start_time=st_, end_time=en_, paid_break_minutes=brk, on_days=4, off_days=4,
               active=True, created_by=u(3))

# ---- settings records (support access, statement of purpose, activities, deputies) -------------
ins_always('support_access_grant', id=U('support-grant', 'v36-1'), organisation_id=ORG, support_user_id=u(10),
           approved_by=u(1), reason='Investigate slow report export', starts_at=T('2026-11-16', '10:00'),
           ends_at=T('2026-11-16', '14:00'), created_at=T('2026-11-16', '09:55'))
for sp in S.get('sop', []):
    published = sp['state'] == 'Published'
    on = date.fromisoformat(sp['on'])
    ins_always('statement_of_purpose_version', id=U('sop', sp['v']), organisation_id=ORG, version_no=sp['v'],
               summary=sp['sum'], status='PUBLISHED' if published else 'DRAFT',
               drafted_by=USERS.get(sp['by'], u(1)), drafted_at=T(sp['on'], '09:00'),
               published_by=USERS.get(sp.get('pub'), u(11)) if published else None,
               published_at=T(str(on + timedelta(days=1)), '10:00') if published else None)
for code, name in [('PTS', 'Patient transport services'),
                   ('TRIAGE', 'Transport services, triage and medical advice provided remotely')]:
    ins_always('registered_activity', id=U('activity', code), organisation_id=ORG, location_id=LOC, code=code,
               name=name, created_by=u(1))
ROLE_USER = {'rm': u(1), 'dir': u(11), 'hr': u(2), 'fleet': u(4), 'gov': u(5), 'disp': u(3)}
deps = [{'leadUserId': ROLE_USER[d['lead']], 'deputyUserId': ROLE_USER[d['dep']], 'from': D(d['from']),
         'to': D(d['to'])} for d in S.get('dep', []) if d['lead'] in ROLE_USER and d['dep'] in ROLE_USER]
if deps:
    q("""UPDATE organisation SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{deputies}', $2::jsonb)
          WHERE id = $1 AND coalesce(jsonb_array_length(settings->'deputies'), 0) = 0""", ORG, J(deps),
      when='always')

# ---- CQC self-audit (Compliance › Audits & actions) ---------------------------------------------
KQ = ['SAFE', 'EFFECTIVE', 'CARING', 'RESPONSIVE']
ANS = {'P': 'PASS', 'A': 'PARTIAL', 'F': 'FAIL', 'N': 'NA'}
sa_id = U('self-audit', 'SA-01')
ins_always('cqc_self_audit', id=sa_id, organisation_id=ORG, code='SA-01', status='OPEN', started_by=u(5),
           started_at=T(str(TODAY - timedelta(days=6)), '09:00'))
for k, a in sorted((S.get('cqA') or {}).items()):
    if not a or a not in ANS:
        continue
    g, n = (int(x) for x in k.split('-'))
    if g >= len(KQ):
        continue
    ins_always('cqc_self_audit_answer', id=U('self-audit-answer', k), organisation_id=ORG, self_audit_id=sa_id,
               question_key=f'{KQ[g]}-{n + 1}', answer=ANS[a], answered_by=u(5),
               answered_at=T(str(TODAY - timedelta(days=5 - (n % 5))), '10:00'))

# What a red or grey check does to its subject, from the check's blocking level (the worker keeps it in step).
q('''UPDATE requirement_instance ri SET effect = CASE
       WHEN ri.status IN ('GREEN', 'AMBER', 'NOT_APPLICABLE') OR v.blocking = 'NONE' THEN 'NONE'
       WHEN v.blocking = 'POLICY' THEN 'POLICY_BLOCK' ELSE 'BLOCK' END
      FROM requirement_template_version v
     WHERE v.id = ri.template_version_id AND ri.organisation_id = $1''', ORG)

anchor = {'table': 'job', 'id': U('job', S['jobs'][0]['id']), 'column': 'journey_date', 'base': BASE}
# ---- vehicle medicines and gases, and controlled drug balance checks (Fleet care) -------------
def stock_kind(n):
    return 'MEDICAL_GAS' if re.search(r'oxygen|entonox|cylinder', n, re.I) else (
        'SEALED_POUCH' if 'pouch' in n.lower() else 'MEDICINE')
for veh, items in S.get('med', {}).items():
    vid = VEH_ID[veh]
    lines = []
    for name, expected, found, exp in items:
        iid = U('stock', veh, name)
        ins('vehicle_stock_item', id=iid, organisation_id=ORG, vehicle_id=vid, kind=stock_kind(name),
            name=name, expected_qty=expected, created_by=u(4))
        lines.append({'itemId': iid, 'name': name, 'kind': stock_kind(name), 'expected': expected,
                      'found': found, 'expiresOn': f'@D:{exp}', 'sealIntact': True})
    ins('vehicle_stock_check', id=U('stock-check', veh), organisation_id=ORG, vehicle_id=vid,
        checked_by=u(7), checked_at=T(BASE, '07:30'), lines=J(lines),
        short_count=sum(1 for l in lines if l['found'] < l['expected']), expired_count=0,
        seal_broken_count=0)
for c in S.get('cd', []):
    ins('controlled_drug_check', id=U('cd', c['id']), organisation_id=ORG, code=c['id'], drug=c['drug'],
        store=c['where'], register_balance=c['exp'], counted_balance=c['bal'], checked_by=USERS[c['by']],
        checked_at=T(c['on'], '08:00'), witness_user_id=USERS[c['wit']], status='WITNESSED',
        witnessed_at=T(c['on'], '08:05'))


# ---- group training sessions awaiting verification (Staff › Training › Matrix & groups) ---------
COURSE = {'MH': ('TR-MH', 'Moving and handling'), 'BLS': ('TR-BLS', 'Basic life support'),
          'SG': ('TR-SG', 'Safeguarding adults and children'),
          'IPC': ('TR-IPC', 'Infection prevention and control')}
for ses in S.get('sessions', []):
    code, title = COURSE.get(ses['course'], ('TR-MH', 'Moving and handling'))
    for pid in ses['att']:
        ins('staff_record', id=U('session', ses['id'], pid), organisation_id=ORG,
            staff_id=STAFF_ID[pid], kind='TRAINING',
            data=J({'courseCode': code, 'title': title, 'completedOn': f"@D:{ses['date']}",
                    'sessionRef': ses['reg'], 'provider': ses.get('prov'), 'session': ses['id']}),
            valid_from=D(ses['date']), created_by=USERS.get(ses.get('by')) or USERS['Samira Patel'],
            created_at=T(ses['on']))


# ---- staff correction requests (Staff › Training & reviews › Corrections) ------------------------
FIELD = {'Phone number': 'phone', 'Name': 'displayName', 'Address': 'address',
         'Next of kin': 'nextOfKin', 'Working pattern': 'workingPattern'}
for c in S.get('corr', []):
    ins('staff_correction_request', id=U('corr', c['id']), organisation_id=ORG,
        staff_id=STAFF_ID[c['who']], field=FIELD.get(c['what'], 'other'), proposed_value=c['should'],
        reason=c['why'], status='OPEN' if 'Waiting' in c['state'] else 'APPLIED',
        requested_by=STAFF_USER.get(c['who']) or u(2), created_at=T(c['on']))

# ---- C5: v36 escalation rules per item kind (S.esc) ---------------------------------------------
# Only when the organisation has not saved its own rules, so a manager's changes are never overwritten.
ESC_KIND = {'Staff check / document': 'STAFF_REQUIREMENT', 'Vehicle document': 'VEHICLE_DOCUMENT',
            'Defect review date': 'EQUIPMENT_REGIME', 'Premises item': 'PREMISES_ITEM', 'Action': 'ACTION',
            'Audit': 'AUDIT', 'Incident stage deadline': 'INCIDENT_OBLIGATION'}
_rules = [{'kind': k, 'recipients': ['OWNER', 'LEAD'], 'leadAfterDays': S['esc'][n]['lead'],
           'managerAfterDays': S['esc'][n]['rm']} for n, k in ESC_KIND.items() if n in S['esc']]
_rules.append({'kind': 'DP_DEADLINE', 'recipients': ['OWNER', 'LEAD']})
q("""UPDATE organisation SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{itemRules}', $2::jsonb)
      WHERE id = $1 AND (settings->'itemRules') IS NULL""", ORG, json.dumps(_rules), when='always')

# ---- workforce checks (Staff › Training › Workforce checks) – exact HANDOVER dates ---------------
# Dates are relative to BASE 2026-11-17 so that after rebase they match the v36 screenshots.
AGENCY_ROLE = {'Emergency care assistant': 'EMERGENCY_CARE_ASSISTANT', 'Driver': 'DRIVER',
               'Care assistant': 'CARE_ASSISTANT', 'Technician': 'TECHNICIAN', 'Paramedic': 'PARAMEDIC'}
# Prefer exact section-6 rows so screen states match; fall back to S.agency shape if needed.
_agency = [
    dict(id='AG-01', name='Kofi Mensah', agency='Swift Medical Staffing',
         job='Emergency care assistant',
         items='DBS (enhanced, barred lists), right to work, references, BLS, MH, SG L2',
         on='2026-10-28', by='Sarah Jenkins', vby='Dr. A. Vance', vat='2026-10-28',
         exp='2027-04-28', ind=True, id_on=True),
    dict(id='AG-02', name='Hannah Price', agency='Swift Medical Staffing', job='Driver',
         items='DBS, right to work, licence check, MH',
         on='2026-11-15', by='Sarah Jenkins', vby=None, vat=None, exp='2027-05-16',
         ind=False, id_on=False),
]
for a in _agency:
    vals = dict(
        organisation_id=ORG, code=a['id'], name=a['name'], agency=a['agency'],
        role=AGENCY_ROLE.get(a['job'], 'OTHER'), confirmation_items=a['items'],
        confirmation_received_on=D(a['on']), confirmation_recorded_by=who_user(a['by']),
        confirmation_expires_on=D(a['exp']), local_induction_done=a['ind'],
        id_checked_on_arrival=a['id_on'])
    if a.get('vby'):
        vals['confirmation_verified_by'] = who_user(a['vby'])
        vals['confirmation_verified_at'] = T(a['vat'] or a['on'], '14:00')
    ins('agency_worker', id=U('agency', a['id']), **vals)

_dvla = [
    ('ST-0042', 'Xy 7k Lm 9p', 'B, C1, D1', 0, '2026-06-07', '2026-12-08'),
    ('ST-0043', 'Qw 2r Tz 5b', 'B, C1', 6, '2026-07-27', '2026-10-27'),
    ('ST-0101', 'Hj 4n Kp 8s', 'B, C1', 3, '2026-09-10', '2027-03-13'),
    ('ST-0106', 'Lm 6d Rs 1q', 'B, C1, D1', 0, '2026-10-16', '2027-04-15'),
    ('ST-0089', 'Zx 9c Vb 3n', 'B, C1', 0, '2026-04-28', '2026-10-28'),
]
for pid, code, cats, pts, on, nxt in _dvla:
    if pid not in STAFF_ID:
        continue
    ins('dvla_check', id=U('dvla', pid), organisation_id=ORG, staff_id=STAFF_ID[pid],
        check_code=code, categories=cats, points=pts, checked_on=D(on), next_check_on=D(nxt),
        recorded_by=u(2))

_hcpc = [
    ('ST-0042', 'PA123456', '2026-09-27', '2027-09-26'),
    ('ST-0106', 'PA654321', '2026-10-16', '2028-09-26'),
]
for pid, no, on, exp in _hcpc:
    if pid not in STAFF_ID:
        continue
    ins('hcpc_registration', id=U('hcpc', pid), organisation_id=ORG, staff_id=STAFF_ID[pid],
        registration_no=no, checked_on=D(on), expires_on=D(exp), recorded_by=u(2))

# ---- planned training sessions (Staff › Training › Planned sessions) ---------------------------
_tplan_inv = [STAFF_ID[p] for p in ('ST-0042', 'ST-0102', 'ST-0089') if p in STAFF_ID]
ins('training_plan', id=U('tplan', 'TP-01'), organisation_id=ORG, code='TP-01',
    course_code='TR-BLS', planned_on=D('2026-12-01'), places=8,
    invited_staff_ids=_tplan_inv, status='PLANNED', created_by=u(2))

# C8 catch-up: existing DBs already have the DBS row; set where it came from and who uploaded it.
# Evidence versions are guarded against edits, so the guard is lifted for this sample row only, and
# only when it still needs the change.
_evv, _jr = U('evv', 'staff|ST-0051|DBS'), USERS['Jordan Reed']
q(f"""DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM evidence_version WHERE id = '{_evv}'
              AND (channel <> 'CANDIDATE_PORTAL' OR uploaded_by IS DISTINCT FROM '{_jr}'::uuid)) THEN
    ALTER TABLE evidence_version DISABLE TRIGGER evidence_version_guard_trg;
    UPDATE evidence_version SET channel = 'CANDIDATE_PORTAL', uploaded_by = '{_jr}' WHERE id = '{_evv}';
    ALTER TABLE evidence_version ENABLE TRIGGER evidence_version_guard_trg;
  END IF;
END $$""", when='always')
q('''UPDATE staff SET user_id = coalesce(user_id, $2) WHERE id = $1''',
  STAFF_ID['ST-0051'], USERS['Jordan Reed'], when='always')

# C6: existing checks and defects get their codes in migration 0055 (the rows are guarded).


# C6: new checks, defects and bookings continue after the highest sample code (VDI-6001, DEF-083…).
for _t, _p, _floor in (('vdi', 'VDI', 5999), ('defect', 'DEF', 0), ('supervision_booking', 'SUP', 199)):
    q(f"""INSERT INTO org_counter (organisation_id, prefix, value)
          SELECT $1, '{_p}', greatest({_floor}, max(substring(code from '[0-9]+')::int))
            FROM {_t} WHERE organisation_id = $1 AND code ~ '^{_p}-[0-9]+$'
          HAVING count(*) > 0
          ON CONFLICT (organisation_id, prefix) DO UPDATE SET value = greatest(org_counter.value, EXCLUDED.value)""",
      ORG, when='always')

out = {'base': BASE, 'org': ORG, 'marker': MARKER, 'anchor': anchor, 'always': always, 'once': once}
json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
print(f'wrote {OUT}: {len(always)} always, {len(once)} once')
