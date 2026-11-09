import { DataTable, StatusBadge } from '@hub/ui';
import { useMemo, useState } from 'react';
import { ActionDialog, input, smallButton, useCan } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { ROLE_LABEL } from '../staff/labels.js';
import { useOne } from './hooks.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PACK_LABEL: Record<string, string> = {
  AMBULANCE_V1: 'Ambulance',
  DENTAL_V1: 'Dental (draft, needs specialist validation)',
  CARE_HOME_V1: 'Care home (draft, needs specialist validation)',
  NHS_CONTRACT_V1: 'NHS contract items (check against your contract)',
  CUSTOM: 'Our own',
};
const NEEDS_SPECIALIST = new Set(['DENTAL_V1', 'CARE_HOME_V1']);
const SUBJECT_LABEL: Record<string, string> = {
  STAFF: 'Staff',
  VEHICLE: 'Vehicle',
  EQUIPMENT: 'Equipment',
  PREMISES: 'Premises',
  ORGANISATION: 'Organisation',
};
const BASIS_LABEL: Record<string, string> = {
  STATUTORY: 'Law',
  LAW: 'Law',
  REGULATORY_GUIDANCE: 'Regulatory guidance',
  PROFESSIONAL_GUIDANCE: 'Professional guidance',
  GOOD_PRACTICE: 'Good practice',
  MANUFACTURER: 'Manufacturer',
  CONTRACT: 'Contract',
  ORG_POLICY: 'Local policy',
  LOCAL_POLICY: 'Local policy',
};
const BLOCKING_LABEL: Record<string, string> = {
  NONE: 'Does not block',
  POLICY: 'Policy (exception possible)',
  DEPLOYMENT_CRITICAL: 'Blocks deployment',
  STATUTORY: 'Blocks (law)',
  SAFETY_CRITICAL: 'Blocks (safety)',
};

const latest = (t: Row): Row | undefined =>
  (t.versions as Row[]).slice().sort((a, b) => b.version - a.version)[0];
const effective = (t: Row): Row | undefined =>
  (t.versions as Row[]).find((v) => v.status === 'EFFECTIVE');

function recurrenceText(r: Row | undefined): string {
  if (!r) return '';
  if (r.type === 'EVENT_TRIGGERED') return 'When something changes';
  if (r.type === 'PER_SHIFT') return 'Every shift';
  const i = r.interval as { unit: string; every: number } | undefined;
  if (!i) return '';
  const unit = i.unit.toLowerCase().replace(/s$/, '');
  return `Every ${i.every} ${unit}${i.every === 1 ? '' : 's'}`;
}

/**
 * A5: the requirement library. What has to be checked, why (legal basis), and for which roles,
 * vehicles, equipment and premises. Nothing can be checked, and nobody approved for a role, until
 * this is set up (findings 2, 5, 74).
 */
export function LibraryPanel() {
  const { api, orgId, me } = useApp();
  const can = useCan();
  const templates = useOne<{ data: Row[] }>('/api/v1/requirements/templates');
  const roleMaps = useOne<{ data: Row[] }>('/api/v1/staff/role-requirements');
  const [pack, setPack] = useState('AMBULANCE_V1');
  const [adopting, setAdopting] = useState<Row | null>(null);
  const [publishing, setPublishing] = useState<{ t: Row; v: Row } | null>(null);
  const [specialist, setSpecialist] = useState('');
  const [specialistOrg, setSpecialistOrg] = useState('');
  const [mapRole, setMapRole] = useState('DRIVER');
  const [mapTemplate, setMapTemplate] = useState('');
  const [removing, setRemoving] = useState<Row | null>(null);
  const all = templates.data?.data ?? [];
  const ours = all.filter((t) => !t.isLibrary);
  const library = all.filter((t) => t.isLibrary && t.pack === pack);
  const packs = [...new Set(all.filter((t) => t.isLibrary).map((t) => t.pack as string))];
  const adoptedCodes = new Set(ours.map((t) => t.code as string));
  const maps = roleMaps.data?.data ?? [];
  const byTemplate = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of maps) m.set(r.templateId, [...(m.get(r.templateId) ?? []), r.role]);
    return m;
  }, [maps]);
  const staffEffective = ours.filter((t) => {
    const v = effective(t);
    return v && v.subjectType === 'STAFF';
  });
  const canEdit = can('admin.settings.manage');
  const canPublish = can('admin.requirements.publish');
  const canMap = can('staff.profile.manage') && can('compliance.requirement.manage');

  return (
    <div className="space-y-6">
      <p className="rounded-lg border border-hub-line bg-hub-card p-3 text-sm">
        The requirement library says what has to be checked, why (its legal basis) and how often.
        Adopt the items that apply to you, have a second person publish them, then map staff items
        to roles. Each person, vehicle, asset or premises item then gets the requirement as
        &ldquo;awaiting evidence&rdquo;, and nobody can be approved for a role until its items are
        verified.
      </p>

      <section aria-labelledby="ours-h" className="space-y-2">
        <h2 id="ours-h" className="text-lg font-semibold">
          Our requirements ({ours.length})
        </h2>
        {templates.isError && <p role="alert">The library could not be loaded.</p>}
        <DataTable<Row>
          caption="Requirements adopted by this organisation"
          rows={ours}
          rowKey={(t) => t.id}
          emptyMessage="Nothing adopted yet. Adopt items from the library below."
          columns={[
            {
              key: 't',
              header: 'Requirement',
              cell: (t) => (
                <span>
                  <strong>{t.title}</strong>
                  <span className="block text-xs text-slate-700">
                    {t.code} · {PACK_LABEL[t.pack] ?? t.pack}
                  </span>
                </span>
              ),
            },
            {
              key: 's',
              header: 'Applies to',
              cell: (t) => SUBJECT_LABEL[latest(t)?.subjectType] ?? latest(t)?.subjectType,
            },
            {
              key: 'b',
              header: 'Basis',
              cell: (t) => (
                <span>
                  {BASIS_LABEL[latest(t)?.basisType] ?? latest(t)?.basisType}
                  {latest(t)?.regulationRef && (
                    <span className="block text-xs text-slate-700">{latest(t)!.regulationRef}</span>
                  )}
                </span>
              ),
            },
            { key: 'r', header: 'How often', cell: (t) => recurrenceText(latest(t)?.recurrence) },
            {
              key: 'k',
              header: 'Effect if missing',
              cell: (t) => BLOCKING_LABEL[latest(t)?.blocking] ?? latest(t)?.blocking,
            },
            {
              key: 'st',
              header: 'Status',
              cell: (t) =>
                effective(t) ? (
                  <StatusBadge status="GREEN" reason={`Published v${effective(t)!.version}`} />
                ) : (
                  <StatusBadge status="AMBER" reason="Draft: needs a second person to publish" />
                ),
            },
            {
              key: 'roles',
              header: 'Roles',
              cell: (t) =>
                (byTemplate.get(t.id) ?? []).map((r) => ROLE_LABEL[r] ?? r).join(', ') || '—',
            },
            {
              key: 'a',
              header: 'Action',
              cell: (t) => {
                const draft = (t.versions as Row[]).find((v) => v.status === 'DRAFT');
                if (!draft || !canPublish) return null;
                const mine = draft.createdBy === me.user.id;
                return (
                  <button
                    className={smallButton}
                    disabled={mine}
                    title={mine ? 'Another person must publish what you drafted' : undefined}
                    aria-label={`Publish ${t.title}`}
                    onClick={() => setPublishing({ t, v: draft })}
                  >
                    Publish
                  </button>
                );
              },
            },
          ]}
        />
      </section>

      <section aria-labelledby="roles-h" className="space-y-2">
        <h2 id="roles-h" className="text-lg font-semibold">
          What each role needs
        </h2>
        <p className="text-sm text-slate-700">
          Only published staff requirements can be mapped. Changing a role&apos;s list applies at
          once to everyone who holds the role.
        </p>
        <ul className="grid gap-2 md:grid-cols-2">
          {Object.entries(ROLE_LABEL).map(([role, label]) => {
            const items = maps.filter((m) => m.role === role);
            return (
              <li key={role} className="rounded-lg border border-hub-line bg-hub-card p-3 text-sm">
                <strong>{label}</strong>
                {items.length === 0 ? (
                  <p className="mt-1 text-amber-900">
                    Nothing mapped: nobody can be approved for this role.
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {items.map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-2">
                        <span>
                          {ours.find((t) => t.id === m.templateId)?.title ??
                            m.templateTitle ??
                            m.templateId}
                        </span>
                        {canMap && (
                          <button
                            className={smallButton}
                            aria-label={`Remove ${m.templateTitle} from ${label}`}
                            onClick={() => setRemoving(m)}
                          >
                            Remove
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {canMap && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-hub-line bg-hub-card p-3">
            <label className="flex flex-col text-sm">
              Role
              <select
                className={input}
                value={mapRole}
                onChange={(e) => setMapRole(e.target.value)}
              >
                {Object.entries(ROLE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-sm">
              Requirement
              <select
                className={input}
                value={mapTemplate}
                onChange={(e) => setMapTemplate(e.target.value)}
              >
                <option value="">Choose a published staff requirement</option>
                {staffEffective
                  .filter((t) => !maps.some((m) => m.role === mapRole && m.templateId === t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </select>
            </label>
            <MapButton role={mapRole} templateId={mapTemplate} onDone={() => setMapTemplate('')} />
          </div>
        )}
      </section>

      <section aria-labelledby="lib-h" className="space-y-2">
        <h2 id="lib-h" className="text-lg font-semibold">
          Library
        </h2>
        <label className="flex flex-col text-sm">
          Pack
          <select
            className={`${input} max-w-sm`}
            value={pack}
            onChange={(e) => setPack(e.target.value)}
          >
            {packs.map((p) => (
              <option key={p} value={p}>
                {PACK_LABEL[p] ?? p}
              </option>
            ))}
          </select>
        </label>
        {NEEDS_SPECIALIST.has(pack) && (
          <p
            role="note"
            className="rounded border border-amber-700 bg-amber-50 p-2 text-sm text-amber-900"
          >
            Draft content: it has not been validated. Adopting an item needs the name of the
            specialist who has checked it for your organisation, and the pack must be switched on
            for your organisation.
          </p>
        )}
        <DataTable<Row>
          caption="Library items"
          rows={library}
          rowKey={(t) => t.id}
          emptyMessage="No items in this pack."
          columns={[
            {
              key: 't',
              header: 'Requirement',
              cell: (t) => (
                <span>
                  <strong>{t.title}</strong>
                  <span className="block text-xs text-slate-700">{t.code}</span>
                </span>
              ),
            },
            {
              key: 's',
              header: 'Applies to',
              cell: (t) => SUBJECT_LABEL[latest(t)?.subjectType] ?? latest(t)?.subjectType,
            },
            {
              key: 'b',
              header: 'Legal basis',
              cell: (t) => (
                <span>
                  {BASIS_LABEL[latest(t)?.basisType] ?? latest(t)?.basisType}
                  <span className="block text-xs text-slate-700">
                    {latest(t)?.regulationRef}
                    {latest(t)?.sourceUrl && (
                      <>
                        {' '}
                        <a
                          className="underline"
                          href={latest(t)!.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          source
                        </a>
                      </>
                    )}
                  </span>
                </span>
              ),
            },
            { key: 'r', header: 'How often', cell: (t) => recurrenceText(latest(t)?.recurrence) },
            {
              key: 'k',
              header: 'Effect if missing',
              cell: (t) => BLOCKING_LABEL[latest(t)?.blocking] ?? latest(t)?.blocking,
            },
            {
              key: 'a',
              header: 'Action',
              cell: (t) =>
                adoptedCodes.has(t.code) ? (
                  <span>Adopted</span>
                ) : canEdit ? (
                  <button
                    className={smallButton}
                    aria-label={`Adopt ${t.title}`}
                    onClick={() => setAdopting(t)}
                  >
                    Adopt
                  </button>
                ) : null,
            },
          ]}
        />
      </section>

      <ActionDialog
        open={adopting !== null}
        title={`Adopt ${adopting?.title ?? ''}`}
        confirmLabel="Adopt as draft"
        confirmDisabled={
          NEEDS_SPECIALIST.has(adopting?.pack) &&
          (specialist.trim().length < 3 || specialistOrg.trim().length < 2)
        }
        onCancel={() => {
          setAdopting(null);
          setSpecialist('');
          setSpecialistOrg('');
        }}
        fields={
          NEEDS_SPECIALIST.has(adopting?.pack) ? (
            <div className="grid gap-2">
              <label className="flex flex-col text-sm">
                Specialist who validated this content (required)
                <input
                  className={input}
                  value={specialist}
                  onChange={(e) => setSpecialist(e.target.value)}
                />
              </label>
              <label className="flex flex-col text-sm">
                Their organisation (required)
                <input
                  className={input}
                  value={specialistOrg}
                  onChange={(e) => setSpecialistOrg(e.target.value)}
                />
              </label>
            </div>
          ) : undefined
        }
        onConfirm={() =>
          api.send(
            'POST',
            `/api/v1/requirements/templates/${adopting!.id}/adopt`,
            orgId,
            NEEDS_SPECIALIST.has(adopting!.pack)
              ? {
                  specialistValidatedBy: specialist.trim(),
                  specialistOrganisation: specialistOrg.trim(),
                }
              : {},
          )
        }
      >
        <p>
          This copies the item into your requirements as a draft. A second person must publish it
          before it applies to anyone.
        </p>
      </ActionDialog>

      <ActionDialog
        open={publishing !== null}
        title={`Publish ${publishing?.t.title ?? ''}`}
        confirmLabel="Publish"
        onCancel={() => setPublishing(null)}
        onConfirm={() =>
          api.send(
            'POST',
            `/api/v1/requirements/templates/${publishing!.t.id}/versions/${publishing!.v.id}/publish`,
            orgId,
            {},
          )
        }
      >
        <p>
          Publishing makes version {publishing?.v.version} effective. Everyone and everything it
          applies to gets it as &ldquo;awaiting evidence&rdquo;. Your name is recorded as the
          approver.
        </p>
      </ActionDialog>

      <ActionDialog
        open={removing !== null}
        title="Stop requiring this for the role"
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          api.send('DELETE', `/api/v1/staff/role-requirements/${removing!.id}`, orgId, undefined)
        }
      >
        <p>
          People who hold the role keep the item on record, but it stops counting towards their
          readiness.
        </p>
      </ActionDialog>
    </div>
  );
}

function MapButton({
  role,
  templateId,
  onDone,
}: {
  role: string;
  templateId: string;
  onDone: () => void;
}) {
  const { api, orgId } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={smallButton} disabled={!templateId} onClick={() => setOpen(true)}>
        Add to role
      </button>
      <ActionDialog
        open={open}
        title={`Require this for ${ROLE_LABEL[role] ?? role}`}
        confirmLabel="Add"
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          await api.send('POST', '/api/v1/staff/role-requirements', orgId, { role, templateId });
          onDone();
        }}
      >
        <p>Everyone who holds this role gets it now as &ldquo;awaiting evidence&rdquo;.</p>
      </ActionDialog>
    </>
  );
}
