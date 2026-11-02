import type { JobState } from '@hub/rules';
import { useState } from 'react';
import { View } from 'react-native';
import { useJob, useToday } from '../app/hooks';
import { useNav } from '../app/nav';
import { useOnline, useOutboxItems, useServices } from '../app/services';
import {
  ACTION_LABEL,
  crewNextStates,
  DOWNTIME_TEXT,
  NEEDS_REASON,
  offlineBlocked,
  stateWithPending,
  STATE_LABEL,
} from '../core/shift';
import {
  Banner,
  Button,
  Card,
  Field,
  P,
  PendingBadge,
  Row,
  Screen,
  StatusPill,
  words,
} from '../ui/kit';
import { time } from '../ui/theme';

/**
 * Assigned job: pickup window, addresses, mobility and access notes, then one large button per next
 * step. Updates are queued with the time they happened and sent when online (idempotent).
 */
export function JobDetail({ id }: { id: string }) {
  const s = useServices();
  s.useSecureScreen(); // patient details: no screenshots, blurred in the app switcher
  const online = useOnline();
  const nav = useNav();
  const today = useToday();
  const shiftEnd = today.data?.today.shift?.endsAt ?? null;
  const job = useJob(id, shiftEnd);
  const items = useOutboxItems();
  const [asking, setAsking] = useState<JobState | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const j = job.data;
  if (!j)
    return (
      <Screen title="Job" onBack={nav.back}>
        {job.loading ? (
          <P>Loading…</P>
        ) : (
          <Banner tone="RED">{job.error ?? 'Job not available.'}</Banner>
        )}
      </Screen>
    );
  const st = stateWithPending(j.id, j.state, items);
  const next = crewNextStates(st.state);
  const conflict = items.find(
    (i) => i.type === 'JOB_STATUS' && i.ref === j.id && i.state === 'CONFLICT',
  );

  const move = async (to: JobState, why?: string) => {
    setNote(null);
    if (offlineBlocked(to, online)) {
      setNote(DOWNTIME_TEXT);
      return;
    }
    if (NEEDS_REASON.includes(to) && !why) {
      setAsking(to);
      return;
    }
    await s.outbox.enqueue({
      type: 'JOB_STATUS',
      ref: j.id,
      label: `${j.code} – ${STATE_LABEL[to]}`,
      payload: { state: to, capturedAt: s.clock().toISOString(), ...(why ? { reason: why } : {}) },
    });
    setAsking(null);
    setReason('');
    void s.sync.run();
  };

  return (
    <Screen title={`Job ${j.code}`} onBack={nav.back}>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <StatusPill
          status={st.state === 'OFFERED' ? 'REQUIRED' : 'GREY'}
          label={STATE_LABEL[st.state]}
        />
        {st.pending && <PendingBadge />}
        {job.offline && <PendingBadge label="Offline copy" />}
      </View>
      {conflict && (
        <Banner tone="RED">
          This job changed while you were offline. Check Messages and call control.
        </Banner>
      )}
      <P muted>Only update the status when the vehicle is stationary.</P>

      {asking ? (
        <Card title={`${ACTION_LABEL[asking] ?? STATE_LABEL[asking]} – reason`}>
          <Field label="Reason" value={reason} onChangeText={setReason} multiline />
          <Button
            label="Confirm"
            disabled={reason.trim().length < 3}
            onPress={() => void move(asking, reason.trim())}
          />
          <Button kind="secondary" label="Cancel" onPress={() => setAsking(null)} />
        </Card>
      ) : (
        next.map((to) => (
          <Button
            key={to}
            kind={NEEDS_REASON.includes(to) ? 'secondary' : 'primary'}
            label={ACTION_LABEL[to] ?? STATE_LABEL[to]}
            onPress={() => void move(to)}
          />
        ))
      )}
      {note && (
        <>
          <Banner tone="RED">{note}</Banner>
          <Button kind="danger" label="Call control" onPress={s.callControl} />
        </>
      )}

      <Card title="Pickup">
        <Row label="Window" value={`${time(j.pickupFrom)} – ${time(j.pickupTo)}`} />
        {j.appointmentAt && <Row label="Appointment" value={time(j.appointmentAt)} />}
        <P>{j.pickupAddress}</P>
        <Button
          kind="secondary"
          label="Open pickup in maps"
          onPress={() => s.openMaps(j.pickupAddress)}
        />
      </Card>
      <Card title="Destination">
        <P>{j.destinationAddress}</P>
        <Button
          kind="secondary"
          label="Open destination in maps"
          onPress={() => s.openMaps(j.destinationAddress)}
        />
      </Card>
      {j.patientContact ? (
        <Card title="Patient">
          <Row label="Name" value={j.patientContact.name} />
          {j.patientContact.phone && <Row label="Phone" value={j.patientContact.phone} />}
          <P muted>Shown only during your shift.</P>
        </Card>
      ) : (
        <P muted>Patient details are shown from one hour before your shift until it ends.</P>
      )}
      <Card title="Mobility and needs">
        <Row label="Mobility" value={words(j.mobility)} />
        <Row label="Crew needed" value={String(j.crewSize)} />
        <Row label="Escorts" value={String(j.escorts)} />
        <Row label="Stairs" value={j.stairs ? 'Yes' : 'No'} />
        <Row label="Infection precautions" value={j.infectionPrecautions ? 'Yes' : 'No'} />
        {j.commsNeeds && <Row label="Communication" value={j.commsNeeds} />}
      </Card>
      <Card title="Access and handover notes">
        <P>Read the current approved plan before moving the patient.</P>
        {j.accessNotes ? <P>{j.accessNotes}</P> : <P muted>No access notes.</P>}
        {!j.accessPlanReviewed && (
          <Banner tone="AMBER">The access plan has not been reviewed by control.</Banner>
        )}
      </Card>
      <Card title="Required equipment">
        {j.requiredEquipment.length === 0 ? (
          <P muted>No special equipment.</P>
        ) : (
          j.requiredEquipment.map((e) => <P key={e}>• {words(e)}</P>)
        )}
        <P muted>Equipment was checked against the vehicle when the job was allocated.</P>
      </Card>
      <Button kind="danger" label="Call control / report concern" onPress={s.callControl} />
      <Button
        kind="secondary"
        label="Report vehicle defect"
        onPress={() => nav.push({ name: 'defect', jobId: j.id })}
      />
    </Screen>
  );
}
