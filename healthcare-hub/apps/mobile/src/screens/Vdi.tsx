import { useState } from 'react';
import { View } from 'react-native';
import { useToday } from '../app/hooks';
import { useNav } from '../app/nav';
import { useServices } from '../app/services';
import type { PendingFile } from '../core/outbox';
import { Banner, Button, Card, Choice, Field, P, Screen } from '../ui/kit';

type R = 'PASS' | 'FAIL' | 'NA';
const OPTIONS = [
  { value: 'PASS' as const, label: 'Pass' },
  { value: 'FAIL' as const, label: 'Fail' },
  { value: 'NA' as const, label: 'N/A' },
];

/**
 * Vehicle daily inspection from the template for this vehicle type. Every item needs an answer; a
 * failure needs a reason (and a photo where possible). A failed critical item makes the server raise
 * a stop-use defect and alert control when this is sent — the app cannot override that.
 */
export function Vdi() {
  const { outbox, sync, files, takePhoto, callControl, clock } = useServices();
  const nav = useNav();
  const today = useToday();
  const shift = today.data?.today.shift ?? null;
  const tpl = shift?.vdiTemplate ?? null;
  const [answers, setAnswers] = useState<Record<string, R>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Record<string, PendingFile>>({});
  const [odometer, setOdometer] = useState('');
  const [notes, setNotes] = useState('');
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<null | { criticalFail: boolean }>(null);

  if (!shift || !tpl)
    return (
      <Screen title="Vehicle check" onBack={nav.back}>
        <P>{today.loading ? 'Loading…' : 'There is no vehicle check to do for this shift.'}</P>
      </Screen>
    );

  const missing = tpl.items.filter((i) => !answers[i.code]);
  const noReason = tpl.items.filter(
    (i) => answers[i.code] === 'FAIL' && (reasons[i.code] ?? '').trim().length < 3,
  );
  const odo = /^\d{1,7}$/.test(odometer) ? Number(odometer) : null;
  const criticalFail = tpl.items.some((i) => i.critical && answers[i.code] === 'FAIL');

  const addPhoto = async (code: string, label: string) => {
    const p = await takePhoto();
    if (!p) return;
    const kept = await files.keep(p.uri);
    setPhotos((x) => ({
      ...x,
      [code]: {
        uri: kept.uri,
        mime: p.mime,
        sizeBytes: kept.sizeBytes,
        title: `VDI photo – ${shift.vehicle.callsign} – ${label}`,
        target: { kind: 'vdiItem', code },
      },
    }));
  };

  const submit = async () => {
    setTried(true);
    if (missing.length > 0 || noReason.length > 0 || odo === null) return;
    await outbox.enqueue({
      type: 'VDI',
      label: `Vehicle check – ${shift.vehicle.callsign}`,
      payload: {
        vehicleId: shift.vehicle.id,
        templateId: tpl.id,
        shiftId: shift.id,
        odometer: odo,
        capturedAt: clock().toISOString(),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        results: tpl.items.map((i) => ({
          code: i.code,
          result: answers[i.code]!,
          ...(answers[i.code] === 'FAIL' ? { reason: reasons[i.code]!.trim() } : {}),
        })),
      },
      files: Object.entries(photos)
        .filter(([code]) => answers[code] === 'FAIL')
        .map(([, f]) => f),
    });
    void sync.run();
    setDone({ criticalFail });
  };

  if (done)
    return (
      <Screen title="Vehicle check" onBack={nav.back}>
        {done.criticalFail ? (
          <>
            <Banner tone="RED">
              A critical item failed. Do not use this vehicle. Control is alerted when the check is
              received.
            </Banner>
            <Button kind="danger" label="Call control" onPress={callControl} />
          </>
        ) : (
          <Banner tone="GREEN">Vehicle check saved. It is sent as soon as you are online.</Banner>
        )}
        <Button label="Back to my shift" onPress={nav.back} />
      </Screen>
    );

  return (
    <Screen title={`Vehicle check – ${shift.vehicle.callsign}`} onBack={nav.back}>
      <P muted>Answer every item. Failed items need a reason; add a photo where you can.</P>
      {tpl.items.map((i) => (
        <Card key={i.code} title={`${i.label}${i.critical ? ' (critical)' : ''}`}>
          <Choice
            label={i.label}
            options={OPTIONS}
            value={answers[i.code] ?? null}
            onChange={(v) => setAnswers((a) => ({ ...a, [i.code]: v }))}
          />
          {tried && !answers[i.code] && <Banner tone="RED">Answer this item.</Banner>}
          {answers[i.code] === 'FAIL' && (
            <View style={{ gap: 8 }}>
              <Field
                label={`What is wrong – ${i.label}`}
                value={reasons[i.code] ?? ''}
                onChangeText={(v) => setReasons((r) => ({ ...r, [i.code]: v }))}
                error={tried && (reasons[i.code] ?? '').trim().length < 3 ? 'Give a reason' : null}
              />
              <Button
                kind="secondary"
                label={photos[i.code] ? 'Retake photo' : 'Add photo'}
                onPress={() => void addPhoto(i.code, i.label)}
              />
              {photos[i.code] && <P muted>Photo attached.</P>}
            </View>
          )}
        </Card>
      ))}
      <Field
        label="Odometer (miles)"
        value={odometer}
        onChangeText={setOdometer}
        keyboardType="number-pad"
        error={tried && odo === null ? 'Enter the odometer reading' : null}
      />
      <Field label="Notes (optional)" value={notes} onChangeText={setNotes} multiline />
      {criticalFail && (
        <Banner tone="RED">
          A critical item has failed: the vehicle will be stopped from use.
        </Banner>
      )}
      {tried && (missing.length > 0 || noReason.length > 0 || odo === null) && (
        <Banner tone="RED">Some answers are missing.</Banner>
      )}
      <Button label="Submit vehicle check" onPress={() => void submit()} />
    </Screen>
  );
}
