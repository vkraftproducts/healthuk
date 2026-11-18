import { Link } from '@tanstack/react-router';
import { Alert, Input, Select, Typography } from 'antd';
import { KpiCards, Ms, WfCard, WfTag, WfTask, type KTone } from '../../v36/ui.js';
import { useMemo, useState, type ReactNode } from 'react';
import { fmtDate, fmtDateTime, words } from '../../components.js';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';
import { EVENT_TEXT } from '../alerts/Alerts.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface AlertItem {
  key: string;
  event: string;
  title: string;
  reasonText: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  raisedAt: string;
  dueOn: string | null;
  state: 'OPEN' | 'ACKNOWLEDGED';
  why: string;
  link: string;
}

export type Task = {
  id: string;
  title: string;
  area: string;
  detail: string;
  tag: string;
  tagTone: 'purple' | 'amber' | 'blue' | 'red' | 'grey' | 'green';
  link: string;
  search?: { tab: string };
  params?: { id: string };
  overdue?: boolean;
  signOff?: boolean;
};

function TaskLink({ task, children }: { task: Task; children: ReactNode }) {
  if (task.params) {
    return (
      <Link to={task.link as '/staff/$id'} params={task.params} aria-label={`${task.title} – open`}>
        {children}
      </Link>
    );
  }
  return (
    <Link
      to={task.link as string}
      {...(task.search ? { search: task.search } : {})}
      aria-label={`${task.title} – open`}
    >
      {children}
    </Link>
  );
}

/**
 * Role inbox matching v36 My work: four KPI cards + a single filterable task list.
 * Composed from existing queues — no new domain API.
 */
/** The signed-in person's tasks, composed from the existing queues (also used by the Overview). */
export function useMyTasks() {
  const { me, orgId } = useApp();
  const can = (p: string) => me.permissions.includes(p);

  const alertsOn =
    can('dashboard.view') ||
    can('compliance.action.manage') ||
    can('compliance.audit.run') ||
    can('events.event.manage') ||
    can('fleet.defect.manage') ||
    can('jobs.allocate') ||
    can('privacy.manage') ||
    can('compliance.requirement.view');
  const centre = useOne<{ items: AlertItem[] }>(orgId && alertsOn ? '/api/v1/alerts/centre' : null);
  const review = useOne<{ data: Row[] }>(
    orgId && can('compliance.evidence.verify') ? '/api/v1/evidence/review-queue' : null,
  );
  const actions = useOne<{ data: Row[] }>(
    orgId && (can('compliance.action.manage') || can('compliance.audit.view'))
      ? '/api/v1/actions?status=OPEN'
      : null,
  );
  const defects = useOne<{ data: Row[] }>(
    orgId && can('fleet.defect.manage') ? '/api/v1/defects?status=OPEN' : null,
  );
  const selfReq = useOne<{ data: Row[] }>(
    orgId && can('staff.profile.manage') ? '/api/v1/staff/self-requests' : null,
  );

  const tasks = useMemo(() => {
    const list: Task[] = [];

    for (const a of centre.data?.items ?? []) {
      if (a.state !== 'OPEN') continue;
      // v36: a task is work that is yours (you own it, or a rule sends it to you) or has been
      // escalated to you – 7 or more days overdue, or critical. Items you can merely see because of
      // your role stay on the Alerts page, not in your task list.
      const late = a.dueOn
        ? Math.floor(
            (Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(a.dueOn.slice(0, 10))) /
              86_400_000,
          )
        : 0;
      const yours = a.why === 'OWNER' || a.why === 'RULE';
      const escalated = !yours && (a.severity === 'CRITICAL' || late >= 7);
      if (!yours && !escalated) continue;
      const overdue =
        escalated ||
        a.severity === 'CRITICAL' ||
        a.severity === 'HIGH' ||
        (!!a.dueOn && a.dueOn < new Date().toISOString().slice(0, 10));
      const [to, qs] = a.link.split('?');
      const tab = new URLSearchParams(qs ?? '').get('tab');
      list.push({
        id: `alert-${a.key}`,
        title: escalated ? `Escalated: ${a.title}` : a.title,
        area: escalated ? 'Escalations' : 'Alerts',
        detail: EVENT_TEXT[a.event] ?? a.reasonText,
        tag: escalated
          ? late > 0
            ? `${late} days overdue · Escalated to you`
            : 'Escalated to you'
          : overdue
            ? 'Overdue or escalated'
            : words(a.severity),
        tagTone: overdue ? 'red' : a.severity === 'MEDIUM' ? 'amber' : 'blue',
        link: to || '/alerts',
        search: tab ? { tab } : undefined,
        overdue,
      });
    }

    for (const r of review.data?.data ?? []) {
      const reqs = (r.requirements as Row[] | undefined) ?? [];
      const label = reqs.length
        ? reqs.map((x) => `${x.templateTitle ?? 'Check'} – ${x.subjectLabel ?? ''}`).join('; ')
        : (r.forTitle ?? 'Evidence to verify');
      list.push({
        id: `ev-${r.id ?? r.versionId}`,
        title: `Verify ${label}`,
        area: 'Onboarding',
        detail:
          r.uploadedAt || r.createdAt
            ? `Uploaded ${fmtDateTime(r.uploadedAt ?? r.createdAt)}`
            : 'Waiting for verification',
        tag: 'Waiting',
        tagTone: 'blue',
        link: '/compliance',
        search: { tab: 'review' },
        signOff: true,
      });
    }

    for (const r of actions.data?.data ?? []) {
      const overdue = !!r.deadline && r.deadline < new Date().toISOString().slice(0, 10);
      list.push({
        id: `act-${r.id}`,
        title: r.title ?? r.code ?? 'Open action',
        area: 'Audits',
        detail: [r.code, r.deadline ? `Due ${fmtDate(r.deadline)}` : null]
          .filter(Boolean)
          .join(' · '),
        tag: overdue ? 'Overdue' : 'Open action',
        tagTone: overdue ? 'red' : 'amber',
        link: '/compliance',
        search: { tab: 'actions' },
        overdue,
        signOff: true,
      });
    }

    for (const r of defects.data?.data ?? []) {
      list.push({
        id: `def-${r.id}`,
        title: r.description
          ? `${r.vehicleCallsign ?? r.assetTag ?? 'Asset'}: ${r.description}`
          : `Defect on ${r.vehicleCallsign ?? r.assetTag ?? 'asset'}`,
        area: 'Fleet',
        detail: [words(r.severity), r.reviewBy ? `Review by ${fmtDate(r.reviewBy)}` : null]
          .filter(Boolean)
          .join(' · '),
        tag:
          r.severity === 'STOP_USE' || r.severity === 'CRITICAL'
            ? 'Blocked vehicle'
            : 'Open defect',
        tagTone: r.severity === 'STOP_USE' || r.severity === 'CRITICAL' ? 'red' : 'amber',
        link: '/vehicles',
        search: { tab: 'defects' },
        overdue: r.severity === 'STOP_USE' || r.severity === 'CRITICAL',
        signOff: true,
      });
    }

    for (const r of selfReq.data?.data ?? []) {
      list.push({
        id: `req-${r.id}`,
        title: `${words(r.kind ?? r.type ?? 'Request')} – ${r.staffName ?? r.displayName ?? 'Staff'}`,
        area: 'Staff',
        detail:
          r.createdAt || r.requestedAt
            ? `Requested ${fmtDateTime(r.createdAt ?? r.requestedAt)}`
            : 'Staff request',
        tag: 'Needs review',
        tagTone: 'purple',
        link: r.staffId ? '/staff/$id' : '/staff',
        params: r.staffId ? { id: r.staffId } : undefined,
        search: r.staffId ? undefined : { tab: 'requests' },
        signOff: true,
      });
    }

    return list;
  }, [centre.data, review.data, actions.data, defects.data, selfReq.data]);
  return tasks;
}

export function MyWork() {
  const { orgId } = useApp();
  const tasks = useMyTasks();
  const [q, setQ] = useState('');
  const [area, setArea] = useState('All');
  const [filter, setFilter] = useState<'all' | 'overdue' | 'signoff'>('all');

  if (!orgId)
    return <Typography.Text role="status">Select an organisation to continue.</Typography.Text>;

  const areas = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.area, (counts.get(t.area) ?? 0) + 1);
    return ['All', ...[...counts.keys()].sort()];
  }, [tasks]);

  const filtered = tasks.filter((t) => {
    if (area !== 'All' && t.area !== area) return false;
    if (filter === 'overdue' && !t.overdue) return false;
    if (filter === 'signoff' && !t.signOff) return false;
    if (q) {
      const hay = `${t.title} ${t.detail} ${t.area}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const waiting = tasks.length;
  const overdue = tasks.filter((t) => t.overdue).length;
  const signOff = tasks.filter((t) => t.signOff).length;

  const kpis = [
    {
      key: 'all' as const,
      title: 'Waiting for you',
      value: waiting,
      foot: 'Across all workflows',
      tone: 'blue',
    },
    {
      key: 'overdue' as const,
      title: 'Overdue or escalated',
      value: overdue,
      foot: 'Owner, lead or manager told',
      tone: 'red',
    },
    {
      key: 'signoff' as const,
      title: 'Needs your sign-off',
      value: signOff,
      foot: 'Second-person decisions',
      tone: 'purple',
    },
    {
      key: 'done' as const,
      title: 'Your actions today',
      value: 0,
      foot: 'Time-stamped in the audit trail',
      tone: 'green',
    },
  ];

  const AREA_ICON: Record<string, string> = {
    Alerts: 'notifications_active',
    Escalations: 'error',
    Audits: 'fact_check',
    Fleet: 'ambulance',
    Onboarding: 'person_add',
    Staff: 'group',
    Policies: 'policy',
    Shifts: 'swap_horiz',
    Incidents: 'report',
  };
  const TAG_ICON: Record<Task['tagTone'], string> = {
    purple: 'how_to_reg',
    amber: 'schedule',
    blue: 'info',
    red: 'error',
    grey: 'draft',
    green: 'check_circle',
  };

  return (
    <div className="wf-stack">
      <KpiCards
        items={kpis.map((k) => ({
          title: k.title,
          value: k.value,
          foot: k.foot,
          tone: k.tone as KTone,
          icon:
            k.tone === 'blue'
              ? 'info'
              : k.tone === 'red'
                ? 'error'
                : k.tone === 'purple'
                  ? 'how_to_reg'
                  : 'check_circle',
          active: filter === k.key,
          ...(k.key !== 'done'
            ? {
                onClick: () => {
                  setFilter(k.key);
                  setArea('All');
                },
              }
            : {}),
        }))}
      />

      <WfCard title="Your tasks" count={filtered.length}>
        <div className="wf-filters rec-f wk-f">
          <Input
            allowClear
            prefix={<Ms i="search" />}
            placeholder="Name, reference or text…"
            aria-label="Search your tasks"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 280, maxWidth: '100%' }}
          />
          <Select
            aria-label="Filter by area"
            value={area}
            onChange={setArea}
            style={{ minWidth: 180 }}
            options={areas.map((a) => ({
              value: a,
              label:
                a === 'All'
                  ? `All areas (${tasks.length})`
                  : `${a} (${tasks.filter((t) => t.area === a).length})`,
            }))}
          />
        </div>

        {filtered.length === 0 ? (
          <Alert
            type="info"
            role="status"
            showIcon
            message="Nothing is waiting on you right now."
          />
        ) : (
          <div className="wk-list" role="list">
            {filtered.map((t) => (
              <div role="listitem" key={t.id}>
                <TaskLink task={t}>
                  <WfTask
                    icon={AREA_ICON[t.area] ?? 'task'}
                    title={t.title}
                    detail={`${t.area} · ${t.detail}`}
                    tag={
                      <>
                        <WfTag tone={t.tagTone} icon={TAG_ICON[t.tagTone]}>
                          {t.tag}
                        </WfTag>
                        <Ms i="chevron_right" className="wf-go" />
                      </>
                    }
                  />
                </TaskLink>
              </div>
            ))}
          </div>
        )}
      </WfCard>
    </div>
  );
}
