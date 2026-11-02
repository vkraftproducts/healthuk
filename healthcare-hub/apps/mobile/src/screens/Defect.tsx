import { useState } from 'react';
import { useToday } from '../app/hooks';
import { useNav } from '../app/nav';
import { useOutboxItems, useServices } from '../app/services';
import type { PendingFile } from '../core/outbox';
import { stateWithPending, UNDER_WAY } from '../core/shift';
import { Banner, Button, Choice, Field, P, Screen, Toggle } from '../ui/kit';

type Sev = 'CRITICAL' | 'MAJOR' | 'MINOR';
const SEVERITY = [
  { value: 'CRITICAL' as const, label: 'Critical' },
  { value: 'MAJOR' as const, label: 'Major' },
  { value: 'MINOR' as const, label: 'Minor' },
];
const GUIDANCE: Record<Sev, string> = {
  CRITICAL:
    'Unsafe to drive or to carry patients (brakes, steering, tyres, lights, tail-lift, oxygen).',
  MAJOR: 'Needs repair soon but the vehicle can be used with care until then.',
  MINOR: 'Cosmetic or comfort issue.',
};

/**
 * Report a defect. A critical or stop-use defect blocks the vehicle on the server. During a journey
 * the app tells the crew to contact control now; it never tells them to leave a patient (APP-02).
 */
export function Defect({ jobId }: { jobId?: string }) {
  const { outbox, sync, files, takePhoto, callControl, clock } = useServices();
  const nav = useNav();
  const today = useToday();
  const items = useOutboxItems();
  const shift = today.data?.today.shift ?? null;
  const [severity, setSeverity] = useState<Sev | null>(null);
  const [stopUse, setStopUse] = useState(false);
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<PendingFile[]>([]);
  const [saved, setSaved] = useState(false);

  const underWay = (shift?.jobs ?? []).some((j) =>
    UNDER_WAY.includes(stateWithPending(j.id, j.state, items).state),
  );
  const serious = severity === 'CRITICAL' || stopUse;
  const contactNow = serious && (underWay || !!jobId);

  if (!shift)
    return (
      <Screen title="Report defect" onBack={nav.back}>
        <P>
          {today.loading ? 'Loading…' : 'You need a shift on a vehicle to report a defect here.'}
        </P>
        <Button kind="danger" label="Call control" onPress={callControl} />
      </Screen>
    );

  const addPhoto = async () => {
    const p = await takePhoto();
    if (!p) return;
    const kept = await files.keep(p.uri);
    setPhotos((x) => [
      ...x,
      {
        uri: kept.uri,
        mime: p.mime,
        sizeBytes: kept.sizeBytes,
        title: `Defect photo – ${shift.vehicle.callsign}`,
        target: { kind: 'append', key: 'photoEvidenceItemIds' },
      },
    ]);
  };
  const ok = !!severity && description.trim().length >= 3;
  const submit = async () => {
    if (!ok) return;
    await outbox.enqueue({
      type: 'DEFECT',
      label: `Defect – ${shift.vehicle.callsign}`,
      payload: {
        vehicleId: shift.vehicle.id,
        severity,
        stopUse: severity === 'CRITICAL' || stopUse,
        description: description.trim(),
        discoveredAt: clock().toISOString(),
      },
      files: photos,
    });
    void sync.run();
    setSaved(true);
  };

  return (
    <Screen title={`Report defect – ${shift.vehicle.callsign}`} onBack={nav.back}>
      {contactNow && (
        <>
          <Banner tone="RED">
            Contact control now. Stay with your patient; control will tell you what to do next.
          </Banner>
          <Button kind="danger" label="Call control now" onPress={callControl} />
        </>
      )}
      {saved ? (
        <>
          <Banner tone="GREEN">
            Defect recorded. Control is alerted as soon as it is received
            {serious ? '; the vehicle is stopped from use' : ''}.
          </Banner>
          <Button label="Done" onPress={nav.back} />
        </>
      ) : (
        <>
          <Choice label="Severity" options={SEVERITY} value={severity} onChange={setSeverity} />
          {severity && <P muted>{GUIDANCE[severity]}</P>}
          <Toggle
            label="Stop using this vehicle"
            value={severity === 'CRITICAL' || stopUse}
            onChange={setStopUse}
          />
          <Field
            label="What is wrong"
            value={description}
            onChangeText={setDescription}
            multiline
          />
          <Button
            kind="secondary"
            label={`Add photo (${photos.length}/6)`}
            disabled={photos.length >= 6}
            onPress={() => void addPhoto()}
          />
          <Button label="Send defect report" disabled={!ok} onPress={() => void submit()} />
        </>
      )}
    </Screen>
  );
}
