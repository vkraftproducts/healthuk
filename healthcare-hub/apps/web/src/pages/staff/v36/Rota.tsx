// v36 Staff › Shifts: the week's rota by person, from the existing shifts endpoint (one call per
// day), with Working Time Regulations prompts from packages/rules. Prompts are reminders for the
// planner; the safety gates are enforced by the server at allocation and shift start.
import { LeftOutlined, RightOutlined, WarningOutlined } from '@ant-design/icons';
import { addDays, londonDate, londonTime, rotaWarnings } from '@hub/rules';
import { useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Alert, Button, Card, Space, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { useApp } from '../../../shell/AppContext.js';
import { Mut, PersonAvatar, RuleNote } from '../../../v36/kit.js';
import { ROLE_LABEL } from '../labels.js';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const mondayOf = (d: string) => {
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  return addDays(d, dow === 0 ? -6 : 1 - dow);
};
const head = (d: string) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${d}T12:00:00Z`));

interface Slot {
  shift: Row;
  role: string;
  start: Date;
  end: Date;
}

export function Rota() {
  const { api, orgId } = useApp();
  const { token } = theme.useToken();
  const today = londonDate(new Date());
  const [week, setWeek] = useState(mondayOf(today));
  // One day either side so rest before Monday's first shift is checked too.
  const fetchDays = useMemo(
    () => Array.from({ length: 9 }, (_, i) => addDays(week, i - 1)),
    [week],
  );
  const days = fetchDays.slice(1, 8);
  const qs = useQueries({
    queries: fetchDays.map((d) => ({
      queryKey: ['one', orgId, `/api/v1/shifts?date=${d}`],
      queryFn: async () => (await api.get(`/api/v1/shifts?date=${d}`, orgId)) as { data: Row[] },
      enabled: !!orgId,
      retry: false,
    })),
  });
  const loading = qs.some((q) => q.isLoading);
  const failed = qs.some((q) => q.isError);
  const shifts = useMemo(() => {
    const m = new Map<string, Row>();
    for (const q of qs) for (const s of q.data?.data ?? []) m.set(s.id, s);
    return [...m.values()];
  }, [qs]);
  const { people, warn } = useMemo(() => {
    const byStaff = new Map<string, { name: string; staffNo: string; slots: Slot[] }>();
    for (const s of shifts)
      if (s.state !== 'CANCELLED')
        for (const c of (s.crew as Row[]).filter((x) => x.active || s.state === 'ENDED')) {
          const p = byStaff.get(c.staffId) ?? {
            name: c.displayName,
            staffNo: c.staffNo,
            slots: [] as Slot[],
          };
          p.slots.push({
            shift: s,
            role: c.role,
            start: new Date(c.startsAt),
            end: new Date(c.endsAt),
          });
          byStaff.set(c.staffId, p);
        }
    const w = rotaWarnings(
      [...byStaff.entries()].flatMap(([staffId, p]) =>
        p.slots.map((x) => ({
          id: `${x.shift.id}:${staffId}`,
          staffId,
          startsAt: x.start,
          endsAt: x.end,
        })),
      ),
    );
    return {
      people: [...byStaff.entries()]
        .map(([id, p]) => ({ id, ...p }))
        .filter((p) => p.slots.some((x) => days.includes(londonDate(x.start))))
        .sort((a, b) => a.name.localeCompare(b.name)),
      warn: w,
    };
  }, [shifts, days]);
  const shown = new Set(
    people.flatMap((p) =>
      p.slots.filter((x) => days.includes(londonDate(x.start))).map((x) => `${x.shift.id}:${p.id}`),
    ),
  );
  const prompts = new Set(warn.filter((w) => shown.has(w.shiftId)).map((w) => w.shiftId)).size;
  const cell = {
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: 8,
    padding: 8,
    minHeight: 64,
  };
  return (
    <Card
      title="Rota"
      extra={
        <Space>
          <Button
            size="small"
            icon={<LeftOutlined />}
            aria-label="Previous week"
            onClick={() => setWeek(addDays(week, -7))}
          />
          <Button size="small" onClick={() => setWeek(mondayOf(today))}>
            This week
          </Button>
          <Button
            size="small"
            icon={<RightOutlined />}
            aria-label="Next week"
            onClick={() => setWeek(addDays(week, 7))}
          />
          <Link to="/planner">
            <Button type="primary" size="small">
              Plan a shift
            </Button>
          </Link>
        </Space>
      }
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 12 } }}
    >
      {failed && (
        <Alert
          type="error"
          showIcon
          message="Source unavailable: some days of the rota could not be loaded."
        />
      )}
      {prompts > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${prompts} shift${prompts === 1 ? '' : 's'} this week need a working-time check.`}
        />
      )}
      <div style={{ overflowX: 'auto' }}>
        <table
          style={{ borderCollapse: 'separate', borderSpacing: 6, minWidth: 960, width: '100%' }}
        >
          <caption className="sr-only">Rota for the week starting {head(week)}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Person</span>
              </th>
              {days.map((d) => (
                <th
                  key={d}
                  scope="col"
                  style={{
                    textAlign: 'left',
                    fontWeight: d === today ? 700 : 500,
                    color: d === today ? token.colorPrimary : undefined,
                  }}
                >
                  {head(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8}>
                  <Mut>Loading…</Mut>
                </td>
              </tr>
            ) : people.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <Mut>No crew rostered this week.</Mut>
                </td>
              </tr>
            ) : (
              people.map((p) => (
                <tr key={p.id}>
                  <th scope="row" style={{ textAlign: 'left', width: 170 }}>
                    <Space size={8}>
                      <PersonAvatar name={p.name} size={28} />
                      <Typography.Text strong>{p.name}</Typography.Text>
                    </Space>
                  </th>
                  {days.map((d) => {
                    const mine = p.slots.filter((x) => londonDate(x.start) === d);
                    const w = mine.flatMap((x) =>
                      warn.filter((y) => y.shiftId === `${x.shift.id}:${p.id}`),
                    );
                    return (
                      <td
                        key={d}
                        style={{
                          ...cell,
                          verticalAlign: 'top',
                          ...(w.length
                            ? { borderColor: token.colorWarning, background: token.colorWarningBg }
                            : {}),
                        }}
                      >
                        {mine.length === 0 ? (
                          <Mut>Off</Mut>
                        ) : (
                          mine.map((x) => (
                            <div key={x.shift.id}>
                              <Typography.Text strong style={{ fontSize: 13 }}>
                                {londonTime(x.start)}–{londonTime(x.end)}
                              </Typography.Text>
                              <div style={{ fontSize: 12 }}>
                                <Mut>
                                  {x.shift.vehicleCallsign} · {ROLE_LABEL[x.role] ?? x.role}
                                </Mut>
                              </div>
                            </div>
                          ))
                        )}
                        {w.map((m) => (
                          <div
                            key={`${m.shiftId}-${m.kind}`}
                            style={{ fontSize: 12, marginTop: 4 }}
                          >
                            <WarningOutlined aria-hidden="true" /> {m.text}
                          </div>
                        ))}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <RuleNote>
        Prompts follow the Working Time Regulations: 11 hours&apos; rest between shifts and a
        48-hour week unless the person has opted out. Open shifts, swaps, hours and patterns are in
        their own views above.
      </RuleNote>
    </Card>
  );
}
