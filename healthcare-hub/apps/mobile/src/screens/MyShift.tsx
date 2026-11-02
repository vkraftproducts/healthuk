import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { errorText, useToday } from '../app/hooks';
import { useNav } from '../app/nav';
import { useOnline, useOutboxItems, useServices } from '../app/services';
import { gateWithPending, startDecision, stateWithPending, STATE_LABEL } from '../core/shift';
import { Banner, Button, Card, P, PendingBadge, Row, Screen, StatusPill, words } from '../ui/kit';
import { day, time } from '../ui/theme';

/** Wireframe 05 "My shift": vehicle, crew, the three gate cards, start shift, quick actions. */
export function MyShift() {
  const { api, outbox, sync, clock, callControl } = useServices();
  const online = useOnline();
  const nav = useNav();
  const today = useToday();
  const items = useOutboxItems();
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [msg, setMsg] = useState<{ tone: 'GREEN' | 'RED' | 'AMBER'; text: string } | null>(null);
  const [checks, setChecks] = useState<{ code: string; reasonText: string }[]>([]);

  useEffect(() => {
    void sync.lastSyncedAt().then(setLastSync);
  }, [sync, items]);
  // When queued work is accepted, show the server's view (gates, vehicle status) straight away.
  const sentCount = useRef(items.length);
  const { refresh } = today;
  useEffect(() => {
    if (online && items.length < sentCount.current) void refresh();
    sentCount.current = items.length;
  }, [items.length, online, refresh]);

  const t = today.data?.today;
  const shift = t?.shift ?? null;
  const pending = items.filter((i) => i.state === 'PENDING').length;
  const problems = items.length - pending;
  const cards = shift ? gateWithPending(shift, items) : [];
  const decision =
    t && today.data
      ? startDecision({ today: t, savedAt: today.data.savedAt, cards, online, now: clock() })
      : null;
  const startedLocally = items.some(
    (i) => i.type === 'SHIFT_START' && i.ref === shift?.id && i.state === 'PENDING',
  );

  const start = async () => {
    if (!shift || !decision) return;
    setMsg(null);
    setChecks([]);
    if (decision.kind === 'OFFLINE_OK') {
      await outbox.enqueue({
        type: 'SHIFT_START',
        ref: shift.id,
        payload: {},
        label: `Shift start – ${shift.vehicle.callsign}`,
      });
      // The banner below says "Shift started on this device – pending sync".
      return;
    }
    try {
      await api.post(`/api/v1/shifts/${shift.id}/start`);
      setMsg({ tone: 'GREEN', text: 'Shift started.' });
      await today.refresh();
    } catch (e) {
      const ae = e as { checks?: { code: string; reasonText: string; result: string }[] | null };
      setChecks((ae.checks ?? []).filter((c) => c.result !== 'PASS'));
      setMsg({ tone: 'RED', text: errorText(e) });
    }
  };

  return (
    <Screen title="My shift" onRefresh={() => void today.refresh()} refreshing={today.loading}>
      <View accessibilityRole="summary" style={{ gap: 6 }}>
        <Text style={{ fontSize: 17, fontWeight: '600' }}>{day(clock())}</Text>
        <Row
          label={online ? '● Online' : '○ Offline'}
          value={lastSync ? `Synced ${time(lastSync)}` : 'Not synced yet'}
        />
        {pending > 0 && (
          <Button
            kind="secondary"
            label={`${pending} waiting to send`}
            onPress={() => nav.setTab('messages')}
          />
        )}
        {problems > 0 && (
          <Banner tone="RED">
            {problems} item{problems === 1 ? '' : 's'} need{problems === 1 ? 's' : ''} your
            attention in Messages.
          </Banner>
        )}
      </View>
      {today.offline && today.data && (
        <Banner tone="AMBER">
          Offline – showing what this device last received at {time(today.data.savedAt)}.
        </Banner>
      )}
      {today.error && <Banner tone="RED">{today.error}</Banner>}
      {today.loading && !today.data && <P muted>Loading your shift…</P>}
      {t && !shift && (
        <Card title="No shift today">
          {t.upcoming.length === 0 ? (
            <P muted>No shifts in the next 7 days.</P>
          ) : (
            t.upcoming.map((u) => (
              <Row
                key={u.id}
                label={day(u.startsAt)}
                value={`${time(u.startsAt)} ${u.vehicleCallsign}`}
              />
            ))
          )}
        </Card>
      )}
      {shift && (
        <>
          <Card
            title={`${shift.vehicle.callsign} · ${shift.vehicle.registration}`}
            right={<StatusPill status={shift.vehicle.status} />}
          >
            <Row label="Shift" value={`${time(shift.startsAt)} – ${time(shift.endsAt)}`} />
            <Row label="Your role" value={words(shift.myRole)} />
            {shift.vehicle.statusReason && <P muted>{shift.vehicle.statusReason}</P>}
            <Text style={{ fontWeight: '700', marginTop: 4 }}>Crew</Text>
            {shift.crew.map((c, i) => (
              <Row
                key={`${c.displayName}-${i}`}
                label={c.me ? `${c.displayName} (you)` : c.displayName}
                value={words(c.role)}
              />
            ))}
          </Card>

          {cards.map((c) => (
            <Card key={c.code} title={c.label} right={<StatusPill status={c.state} />}>
              <P muted>{c.reasonText}</P>
              {c.code === 'VDI' && c.state === 'REQUIRED' && shift.state === 'PLANNED' && (
                <Button label="Start vehicle check" onPress={() => nav.push({ name: 'vdi' })} />
              )}
              {c.code === 'CLEANING' && c.state === 'REQUIRED' && shift.state === 'PLANNED' && (
                <Button
                  label="Complete cleaning confirmation"
                  onPress={() => nav.push({ name: 'cleaning' })}
                />
              )}
              {c.state === 'BLOCKED' && (
                <Button kind="danger" label="Call control" onPress={callControl} />
              )}
            </Card>
          ))}

          {shift.state === 'STARTED' || startedLocally ? (
            <Banner tone="GREEN">
              Shift started{startedLocally ? ' on this device – pending sync' : ''}.
            </Banner>
          ) : (
            <>
              {decision?.kind === 'BLOCKED' && <Banner tone="RED">{decision.text}</Banner>}
              {decision?.kind === 'DOWNTIME' && (
                <>
                  <Banner tone="RED">{decision.text}</Banner>
                  <Button kind="danger" label="Call control" onPress={callControl} />
                </>
              )}
              <Button
                label="Start shift"
                disabled={decision?.kind !== 'ONLINE' && decision?.kind !== 'OFFLINE_OK'}
                onPress={() => void start()}
              />
            </>
          )}
          {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
          {checks.map((c) => (
            <P key={c.code}>✕ {c.reasonText}</P>
          ))}

          <Card title="Today's jobs">
            {shift.jobs.length === 0 && <P muted>No jobs allocated yet.</P>}
            {shift.jobs.map((j) => {
              const st = stateWithPending(j.id, j.state, items);
              return (
                <View key={j.id} style={{ gap: 4 }}>
                  <Button
                    kind="secondary"
                    label={`${j.code} · pick up ${time(j.pickupFrom)}–${time(j.pickupTo)}`}
                    onPress={() => nav.push({ name: 'job', id: j.id })}
                  />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <StatusPill
                      status={st.state === 'OFFERED' ? 'REQUIRED' : 'GREY'}
                      label={STATE_LABEL[st.state]}
                    />
                    {st.pending && <PendingBadge />}
                  </View>
                </View>
              );
            })}
          </Card>
        </>
      )}
      <Card title="Quick actions">
        <Button kind="secondary" label="Fuel receipt" onPress={() => nav.push({ name: 'fuel' })} />
        <Button
          kind="secondary"
          label="Report defect"
          onPress={() => nav.push({ name: 'defect' })}
        />
      </Card>
    </Screen>
  );
}
