import { useState } from 'react';
import { useToday } from '../app/hooks';
import { useNav } from '../app/nav';
import { useServices } from '../app/services';
import { Banner, Button, Choice, Field, P, Screen, Toggle } from '../ui/kit';

type T = 'PRE_SHIFT' | 'BETWEEN_PATIENT' | 'ENHANCED';
const TYPES = [
  { value: 'PRE_SHIFT' as const, label: 'Pre-shift' },
  { value: 'BETWEEN_PATIENT' as const, label: 'Between patients' },
  { value: 'ENHANCED' as const, label: 'Enhanced' },
];
const METHODS = [
  { value: 'DETERGENT_WIPE', label: 'Detergent wipe' },
  { value: 'CHLORINE', label: 'Chlorine-based' },
  { value: 'STEAM_OR_FOG', label: 'Steam or fogging' },
] as const;
type M = (typeof METHODS)[number]['value'];

/** Cleaning confirmation: type, method and an explicit confirmation. */
export function Cleaning() {
  const { outbox, sync, clock } = useServices();
  const nav = useNav();
  const today = useToday();
  const shift = today.data?.today.shift ?? null;
  const [type, setType] = useState<T | null>(shift?.state === 'STARTED' ? null : 'PRE_SHIFT');
  const [method, setMethod] = useState<M | null>(null);
  const [notes, setNotes] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!shift)
    return (
      <Screen title="Cleaning" onBack={nav.back}>
        <P>{today.loading ? 'Loading…' : 'You need a shift to record cleaning.'}</P>
      </Screen>
    );
  const ok = !!type && !!method && confirmed;
  const submit = async () => {
    if (!ok) return;
    const m = METHODS.find((x) => x.value === method)!.label;
    await outbox.enqueue({
      type: 'CLEANING',
      label: `Cleaning – ${shift.vehicle.callsign}`,
      payload: {
        vehicleId: shift.vehicle.id,
        shiftId: shift.id,
        type,
        capturedAt: clock().toISOString(),
        notes: `Method: ${m}${notes.trim() ? `. ${notes.trim()}` : ''}`.slice(0, 500),
      },
    });
    void sync.run();
    setSaved(true);
  };
  return (
    <Screen title={`Cleaning – ${shift.vehicle.callsign}`} onBack={nav.back}>
      {saved ? (
        <>
          <Banner tone="GREEN">Cleaning recorded. It is sent as soon as you are online.</Banner>
          <Button label="Back to my shift" onPress={nav.back} />
        </>
      ) : (
        <>
          <Choice label="Type of clean" options={TYPES} value={type} onChange={setType} />
          <Choice label="Method" options={METHODS} value={method} onChange={setMethod} />
          <Field label="Notes (optional)" value={notes} onChangeText={setNotes} multiline />
          <Toggle
            label="I confirm the vehicle has been cleaned to the required standard"
            value={confirmed}
            onChange={setConfirmed}
          />
          <Button label="Confirm cleaning" disabled={!ok} onPress={() => void submit()} />
        </>
      )}
    </Screen>
  );
}
