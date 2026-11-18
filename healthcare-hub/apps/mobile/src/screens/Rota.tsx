import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { errorText } from '../app/hooks';
import { useNav } from '../app/nav';
import { useOnline, useServices } from '../app/services';
import { Banner, Button, Card, Choice, Field, P, Row, Screen, StatusPill, words } from '../ui/kit';
import { day, time } from '../ui/theme';

/**
 * v36 (17 Nov 2026): crew clock in and out, offer to cover open shifts and ask for or answer shift
 * swaps. These need the server (they change the rota), so they are online only and say so; nothing
 * here is queued. The server decides every rule; the app only shows what it is allowed to do.
 */
type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const span = (a: string, b: string) => `${day(a)} ${time(a)}–${time(b)}`;

export function Rota() {
  const { api, clock } = useServices();
  const online = useOnline();
  const nav = useNav();
  const [mine, setMine] = useState<R[] | null>(null);
  const [open, setOpen] = useState<R[]>([]);
  const [swaps, setSwaps] = useState<R[]>([]);
  const [options, setOptions] = useState<{ mine: R[]; colleagues: R[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: 'GREEN' | 'RED'; text: string } | null>(null);
  const [breaks, setBreaks] = useState('0');
  const [asking, setAsking] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    if (!online) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [m, o, s] = await Promise.all([
        api.get<{ data: R[] }>('/api/v1/shift-time/mine'),
        api.get<{ data: R[] }>('/api/v1/open-shifts'),
        api.get<{ data: R[] }>('/api/v1/shift-swaps'),
      ]);
      setMine(m.data);
      setOpen(o.data);
      setSwaps(s.data);
    } catch (e) {
      setMsg({ tone: 'RED', text: errorText(e) });
    } finally {
      setLoading(false);
    }
  }, [api, online]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'GREEN', text: done });
      await load();
    } catch (e) {
      setMsg({ tone: 'RED', text: errorText(e) });
    }
  };

  const startAsking = async () => {
    setAsking(true);
    try {
      setOptions(await api.get('/api/v1/shift-swaps/options'));
    } catch (e) {
      setMsg({ tone: 'RED', text: errorText(e) });
    }
  };

  const now = clock().getTime();
  const breakMin = /^\d{1,3}$/.test(breaks.trim()) ? Number(breaks) : null;

  return (
    <Screen
      title="Shifts and hours"
      onBack={nav.back}
      onRefresh={() => void load()}
      refreshing={loading}
    >
      {!online && (
        <Banner tone="AMBER">
          Offline – clocking in, open shifts and swaps need a connection. Nothing here is saved on
          the device.
        </Banner>
      )}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <Card title="Clock in and out">
        {loading && !mine && <P muted>Loading…</P>}
        {mine && mine.length === 0 && <P muted>No shifts in the last two weeks or tomorrow.</P>}
        {(mine ?? []).map((a) => {
          const e = a.entry as R | null;
          const canIn =
            !e && now >= Date.parse(a.plannedStart) - 3_600_000 && now <= Date.parse(a.plannedEnd);
          const clockedIn = e && !e.clockOut && e.source === 'CREW_APP';
          return (
            <View key={a.assignmentId} style={{ gap: 6 }}>
              <Row label={a.vehicleLabel} value={span(a.plannedStart, a.plannedEnd)} />
              {e && (
                <P muted>
                  Clocked {time(e.clockIn)}–{e.clockOut ? time(e.clockOut) : 'now'}
                  {e.breakMinutes ? ` · ${e.breakMinutes} min breaks` : ''}
                  {e.corrected ? ' · corrected by a manager' : ''}
                </P>
              )}
              {canIn && (
                <Button
                  label="Clock in"
                  disabled={!online}
                  onPress={() =>
                    void act(
                      () => api.post('/api/v1/shift-time/clock-in', { assignmentId: a.assignmentId }),
                      'Clocked in.',
                    )
                  }
                />
              )}
              {clockedIn && (
                <>
                  <Field
                    label="Breaks taken (minutes)"
                    value={breaks}
                    onChangeText={setBreaks}
                    keyboardType="number-pad"
                    error={breakMin === null ? 'Enter whole minutes' : null}
                  />
                  <Button
                    label="Clock out"
                    disabled={!online || breakMin === null}
                    onPress={() =>
                      void act(
                        () =>
                          api.post(`/api/v1/shift-time/${e.id}/clock-out`, { breakMinutes: breakMin }),
                        'Clocked out.',
                      )
                    }
                  />
                </>
              )}
            </View>
          );
        })}
      </Card>

      <Card title="Open shifts">
        {open.length === 0 && <P muted>No open shifts need cover.</P>}
        {open.map((o) => (
          <View key={o.id} style={{ gap: 6 }}>
            <Row label={`${words(o.role)} on ${o.vehicleLabel}`} value={span(o.startsAt, o.endsAt)} />
            {o.note && <P muted>{o.note}</P>}
            {o.offeredByMe ? (
              <>
                <StatusPill status="AMBER" label="You offered – control will confirm" />
                <Button
                  kind="secondary"
                  label={`Withdraw offer ${o.code}`}
                  disabled={!online}
                  onPress={() =>
                    void act(() => api.post(`/api/v1/open-shifts/${o.id}/withdraw-offer`), 'Offer withdrawn.')
                  }
                />
              </>
            ) : (
              <Button
                label={`Offer to cover ${o.code}`}
                disabled={!online}
                onPress={() =>
                  void act(() => api.post(`/api/v1/open-shifts/${o.id}/offer`), 'Offer sent to control.')
                }
              />
            )}
          </View>
        ))}
      </Card>

      <Card title="Shift swaps">
        {swaps.length === 0 && <P muted>No swaps.</P>}
        {swaps.map((w) => (
          <View key={w.id} style={{ gap: 6 }}>
            <Row label={`${w.from.staffName} ⇄ ${w.to.staffName}`} value={words(w.status)} />
            <P muted>
              {w.from.vehicleLabel} {span(w.from.startsAt, w.from.endsAt)} for {w.to.vehicleLabel}{' '}
              {span(w.to.startsAt, w.to.endsAt)} · {w.reason}
            </P>
            {w.decisionNote && <P muted>{w.decisionNote}</P>}
            {w.canAgree && (
              <>
                <Button
                  label={`Agree to swap ${w.code}`}
                  disabled={!online}
                  onPress={() =>
                    void act(() => api.post(`/api/v1/shift-swaps/${w.id}/agree`), 'Agreed – control will approve.')
                  }
                />
                <Button
                  kind="secondary"
                  label={`Decline swap ${w.code}`}
                  disabled={!online}
                  onPress={() => void act(() => api.post(`/api/v1/shift-swaps/${w.id}/decline`), 'Declined.')}
                />
              </>
            )}
            {w.canWithdraw && (
              <Button
                kind="secondary"
                label={`Withdraw swap ${w.code}`}
                disabled={!online}
                onPress={() => void act(() => api.post(`/api/v1/shift-swaps/${w.id}/withdraw`), 'Withdrawn.')}
              />
            )}
          </View>
        ))}
        {!asking ? (
          <Button kind="secondary" label="Ask to swap a shift" disabled={!online} onPress={() => void startAsking()} />
        ) : (
          <View style={{ gap: 6 }}>
            {options && options.mine.length === 0 && <P muted>You have no planned shifts in the next 28 days.</P>}
            {options && options.mine.length > 0 && (
              <>
                <Choice
                  label="My shift"
                  value={from}
                  onChange={setFrom}
                  options={options.mine.map((o) => ({
                    value: o.assignmentId as string,
                    label: `${o.vehicleLabel} ${span(o.startsAt, o.endsAt)}`,
                  }))}
                />
                <Choice
                  label="Their shift"
                  value={to}
                  onChange={setTo}
                  options={options.colleagues.map((o) => ({
                    value: o.assignmentId as string,
                    label: `${o.staffName}: ${o.vehicleLabel} ${span(o.startsAt, o.endsAt)}`,
                  }))}
                />
                <Field label="Reason" value={reason} onChangeText={setReason} />
                <Button
                  label="Send swap request"
                  disabled={!online || !from || !to || reason.trim().length < 3}
                  onPress={() =>
                    void act(async () => {
                      await api.post('/api/v1/shift-swaps', {
                        fromAssignmentId: from,
                        toAssignmentId: to,
                        reason: reason.trim(),
                      });
                      setAsking(false);
                      setFrom(null);
                      setTo(null);
                      setReason('');
                    }, 'Swap asked for – your colleague needs to agree, then control approves.')
                  }
                />
              </>
            )}
            <Button kind="secondary" label="Cancel" onPress={() => setAsking(false)} />
          </View>
        )}
      </Card>
    </Screen>
  );
}
