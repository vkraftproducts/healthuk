import { londonDate } from '@hub/rules';
import { useState } from 'react';
import { useToday } from '../app/hooks';
import { useNav } from '../app/nav';
import { useServices } from '../app/services';
import type { PendingFile } from '../core/outbox';
import { Banner, Button, Choice, Field, P, Screen } from '../ui/kit';

const KIND = [
  { value: 'FUEL' as const, label: 'Fuel (litres)' },
  { value: 'CHARGING' as const, label: 'Charging (kWh)' },
];

/** Parses "61.23" or "£61.23" into pence; null when not a valid amount. */
export function toPence(v: string): number | null {
  const m = /^£?\s*(\d{1,6})(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

export function Fuel() {
  const { outbox, sync, files, takePhoto, clock } = useServices();
  const nav = useNav();
  const today = useToday();
  const shift = today.data?.today.shift ?? null;
  const [kind, setKind] = useState<'FUEL' | 'CHARGING'>('FUEL');
  const [qty, setQty] = useState('');
  const [amount, setAmount] = useState('');
  const [odometer, setOdometer] = useState('');
  const [receipt, setReceipt] = useState<PendingFile | null>(null);
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!shift)
    return (
      <Screen title="Fuel receipt" onBack={nav.back}>
        <P>{today.loading ? 'Loading…' : 'You need a shift on a vehicle to add a receipt here.'}</P>
      </Screen>
    );
  const pence = toPence(amount);
  const q = /^\d{1,5}(\.\d{1,2})?$/.test(qty.trim()) && Number(qty) > 0 ? Number(qty) : null;
  const odo =
    odometer.trim() === ''
      ? undefined
      : /^\d{1,7}$/.test(odometer.trim())
        ? Number(odometer)
        : null;

  const photo = async () => {
    const p = await takePhoto();
    if (!p) return;
    const kept = await files.keep(p.uri);
    setReceipt({
      uri: kept.uri,
      mime: p.mime,
      sizeBytes: kept.sizeBytes,
      title: `Receipt – ${shift.vehicle.callsign}`,
      target: { kind: 'set', key: 'receiptEvidenceItemId' },
    });
  };
  const submit = async () => {
    setTried(true);
    if (!pence || !q || odo === null) return;
    await outbox.enqueue({
      type: 'EXPENSE',
      label: `${kind === 'FUEL' ? 'Fuel' : 'Charging'} – ${shift.vehicle.callsign}`,
      payload: {
        vehicleId: shift.vehicle.id,
        spentOn: londonDate(clock()),
        category: kind,
        quantity: q,
        unit: kind === 'FUEL' ? 'LITRES' : 'KWH',
        amountPence: pence,
        ...(odo !== undefined ? { odometer: odo } : {}),
      },
      files: receipt ? [receipt] : [],
    });
    void sync.run();
    setSaved(true);
  };
  return (
    <Screen title={`Fuel receipt – ${shift.vehicle.callsign}`} onBack={nav.back}>
      {saved ? (
        <>
          <Banner tone="GREEN">Receipt saved. It is sent as soon as you are online.</Banner>
          <Button label="Done" onPress={nav.back} />
        </>
      ) : (
        <>
          <Button
            kind="secondary"
            label={receipt ? 'Retake receipt photo' : 'Photograph receipt'}
            onPress={() => void photo()}
          />
          <Choice label="Type" options={KIND} value={kind} onChange={setKind} />
          <Field
            label={kind === 'FUEL' ? 'Litres' : 'kWh'}
            value={qty}
            onChangeText={setQty}
            keyboardType="decimal-pad"
            error={tried && !q ? 'Enter the quantity' : null}
          />
          <Field
            label="Amount (£)"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            error={tried && !pence ? 'Enter the amount, for example 61.23' : null}
          />
          <Field
            label="Mileage (optional)"
            value={odometer}
            onChangeText={setOdometer}
            keyboardType="number-pad"
            error={tried && odo === null ? 'Whole miles only' : null}
          />
          <Button label="Save receipt" onPress={() => void submit()} />
        </>
      )}
    </Screen>
  );
}
