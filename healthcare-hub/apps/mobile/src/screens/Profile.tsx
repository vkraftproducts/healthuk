import { useState } from 'react';
import { errorText, useProfile, useToday } from '../app/hooks';
import { useServices } from '../app/services';
import type { DeviceDto } from '@hub/contracts';
import { Banner, Button, Card, P, Row, Screen, StatusPill, words } from '../ui/kit';

/** Own training and expiries, submitted documents, supervision/appraisal tasks; sign out. */
export function Profile() {
  const { api, session, deviceId, outbox } = useServices();
  const today = useToday();
  const p = useProfile(today.data?.today.cacheUntil ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const signOut = async () => {
    setErr(null);
    const unsent = await outbox.pendingCount();
    if (unsent > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    try {
      const me = await deviceId();
      const devices = await api.get<{ data: DeviceDto[] }>('/api/v1/devices');
      const mine = devices.data.find((d) => d.deviceId === me && !d.revokedAt);
      if (mine) await api.delete(`/api/v1/devices/${mine.id}`);
    } catch (e) {
      setErr(`${errorText(e)} This device was signed out locally.`);
    }
    await session.signOut();
  };
  const d = p.data;
  return (
    <Screen title="My profile">
      {p.error && <Banner tone="RED">{p.error}</Banner>}
      {d && (
        <>
          <Card title={d.displayName} right={<StatusPill status={d.overallStatus} />}>
            <Row label="Staff number" value={d.staffNo} />
            {d.jobTitle && <Row label="Job title" value={d.jobTitle} />}
            <Row label="Roles" value={d.roles.map(words).join(', ') || 'None'} />
          </Card>
          <Card title="Training and checks">
            {d.requirements.length === 0 && <P muted>Nothing recorded yet.</P>}
            {d.requirements.map((r) => (
              <Card key={r.id} title={r.title} right={<StatusPill status={r.status} />}>
                <P muted>{r.reasonText}</P>
                {r.expiryDate && <Row label="Expires" value={r.expiryDate} />}
                {r.dueDate && <Row label="Due" value={r.dueDate} />}
              </Card>
            ))}
          </Card>
          <Card title="Documents I have submitted">
            {d.documents.length === 0 && <P muted>None.</P>}
            {d.documents.map((x) => (
              <Row key={x.id} label={x.title} value={<StatusPill status={x.state} />} />
            ))}
          </Card>
          <Card title="Supervision and appraisal">
            {d.tasks.length === 0 && <P muted>Nothing due.</P>}
            {d.tasks.map((t) => (
              <Row
                key={t.id}
                label={t.title}
                value={<StatusPill status={t.status} label={t.reasonText} />}
              />
            ))}
          </Card>
        </>
      )}
      {confirming && (
        <Banner tone="RED">
          Some items have not been sent yet. Signing out deletes them from this device. Press sign
          out again to continue.
        </Banner>
      )}
      {err && <Banner tone="AMBER">{err}</Banner>}
      <Button
        kind="danger"
        label="Sign out and remove data from this device"
        onPress={() => void signOut()}
      />
    </Screen>
  );
}
