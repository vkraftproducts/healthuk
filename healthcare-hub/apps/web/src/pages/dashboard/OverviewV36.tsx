// v36 Dashboard › Overview: four counters, "Needs attention now" and "Fleet now".
import { useNavigate } from '@tanstack/react-router';
import { useApp } from '../../shell/AppContext.js';
import { useOne } from '../settings/hooks.js';
import { readiness } from '../staff/v36/shared.js';
import { KpiCards, WfCard, WfTag, type KTone } from '../../v36/ui.js';
import { useMyTasks } from '../work/MyWork.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const VEHICLE: Record<string, { tone: KTone; word: string; icon: string }> = {
  AVAILABLE: { tone: 'green', word: 'Available', icon: 'check_circle' },
  IN_USE: { tone: 'blue', word: 'In use', icon: 'local_shipping' },
  RESTRICTED: { tone: 'amber', word: 'Restricted', icon: 'warning' },
  BLOCKED: { tone: 'red', word: 'Blocked', icon: 'block' },
  OFF_ROAD: { tone: 'red', word: 'Off road', icon: 'block' },
  IN_REPAIR: { tone: 'amber', word: 'In repair', icon: 'build' },
  RETIRED: { tone: 'grey', word: 'Retired', icon: 'remove_circle' },
};

export function OverviewV36() {
  const { me } = useApp();
  const can = (p: string) => me.permissions.includes(p);
  const navigate = useNavigate();
  const tasks = useMyTasks();
  const vehicles = useOne<{ data: Row[] }>(can('fleet.vehicle.view') ? '/api/v1/vehicles' : null);
  const staff = useOne<{ data: Row[] }>(
    can('staff.profile.view_basic') ? '/api/v1/staff?limit=100&lifecycle=ACTIVE' : null,
  );
  const vs = vehicles.data?.data ?? [];
  const available = vs.filter((v) => v.status === 'AVAILABLE' || v.status === 'IN_USE').length;
  const blocked = vs.filter((v) => ['BLOCKED', 'OFF_ROAD'].includes(String(v.status))).length;
  const people = staff.data?.data ?? [];
  const ready = people.filter((r) => readiness(r).word === 'Ready').length;
  const overdue = tasks.filter((t) => t.overdue);
  const attention = [...overdue, ...tasks.filter((t) => !t.overdue)].slice(0, 6);
  const goWork = () => void navigate({ to: '/', search: { tab: 'work' } });

  return (
    <div className="wf-stack">
      <KpiCards
        items={[
          {
            title: 'Waiting for you',
            value: tasks.length,
            foot: 'Across all workflows',
            tone: 'blue',
            icon: 'inbox',
            onClick: goWork,
          },
          {
            title: 'Overdue and escalating',
            value: overdue.length,
            foot: 'Owner, lead or manager told',
            tone: overdue.length ? 'red' : 'green',
            icon: 'error',
            onClick: goWork,
          },
          ...(vehicles.data
            ? [
                {
                  title: 'Vehicles available',
                  value: `${available} of ${vs.length}`,
                  foot: blocked ? `${blocked} blocked` : 'None blocked',
                  tone: (blocked ? 'amber' : 'green') as KTone,
                  icon: 'ambulance',
                  onClick: () => void navigate({ to: '/vehicles' }),
                },
              ]
            : []),
          ...(staff.data
            ? [
                {
                  title: 'Staff ready for shifts',
                  value: `${ready} of ${people.length}`,
                  foot: 'All checks verified and in date',
                  tone: (ready === people.length ? 'green' : 'amber') as KTone,
                  icon: 'badge',
                  onClick: () => void navigate({ to: '/staff' }),
                },
              ]
            : []),
        ]}
      />
      <div className="hh-two">
        <WfCard
          title="Needs attention now"
          extra={
            <button
              type="button"
              className="wf-btn sm ant-btn ant-btn-default ant-btn-sm"
              onClick={goWork}
            >
              All {tasks.length}
            </button>
          }
        >
          <table className="wf-t ant-t" aria-label="Needs attention now">
            <thead className="ant-table-thead">
              <tr>
                <th className="ant-table-cell" scope="col">
                  Item
                </th>
                <th className="ant-table-cell" scope="col">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="ant-table-tbody">
              {attention.length === 0 && (
                <tr className="ant-table-row">
                  <td className="ant-table-cell" colSpan={2}>
                    Nothing needs your attention right now.
                  </td>
                </tr>
              )}
              {attention.map((t) => (
                <tr
                  key={t.id}
                  className="ant-table-row row-click"
                  tabIndex={0}
                  role="button"
                  onClick={() => void navigate({ to: t.link, search: t.search })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void navigate({ to: t.link, search: t.search });
                  }}
                >
                  <td className="ant-table-cell">
                    <b>{t.title}</b>
                    <span className="sub">
                      {t.area} · {t.detail}
                    </span>
                  </td>
                  <td className="ant-table-cell">
                    <WfTag tone={t.tagTone} icon={t.overdue ? 'error' : 'schedule'}>
                      {t.tag}
                    </WfTag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </WfCard>
        {vehicles.data && (
          <WfCard
            title="Fleet now"
            extra={
              <button
                type="button"
                className="wf-btn sm ant-btn ant-btn-default ant-btn-sm"
                onClick={() => void navigate({ to: '/vehicles' })}
              >
                All vehicles
              </button>
            }
          >
            <table className="wf-t ant-t" aria-label="Fleet now">
              <thead className="ant-table-thead">
                <tr>
                  <th className="ant-table-cell" scope="col">
                    Vehicle
                  </th>
                  <th className="ant-table-cell" scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="ant-table-tbody">
                {vs.map((v) => {
                  const st = VEHICLE[String(v.status)] ?? {
                    tone: 'grey' as KTone,
                    word: String(v.status),
                    icon: 'help',
                  };
                  return (
                    <tr
                      key={v.id}
                      className="ant-table-row row-click"
                      tabIndex={0}
                      role="button"
                      onClick={() => void navigate({ to: '/vehicles/$id', params: { id: v.id } })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')
                          void navigate({ to: '/vehicles/$id', params: { id: v.id } });
                      }}
                    >
                      <td className="ant-table-cell">
                        <b>{v.callsign}</b>
                        <span className="sub">{v.vehicleType ?? v.registration ?? ''}</span>
                      </td>
                      <td className="ant-table-cell">
                        <WfTag tone={st.tone} icon={st.icon}>
                          {st.word}
                        </WfTag>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </WfCard>
        )}
      </div>
    </div>
  );
}
