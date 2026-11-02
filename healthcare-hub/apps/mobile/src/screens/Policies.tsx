import { useState } from 'react';
import { usePolicies, useToday } from '../app/hooks';
import { useOutboxItems, useServices } from '../app/services';
import { Banner, Button, Card, P, PendingBadge, Screen, StatusPill, Toggle } from '../ui/kit';

/** Pending policy acknowledgements; critical instructions need an explicit confirmation. */
export function Policies() {
  const { outbox, sync } = useServices();
  const today = useToday();
  const list = usePolicies(today.data?.today.cacheUntil ?? null);
  const items = useOutboxItems();
  const [confirm, setConfirm] = useState<Record<string, boolean>>({});

  const sent = (versionId: string) =>
    items.find((i) => i.type === 'POLICY_ACK' && i.ref === versionId);
  const ack = async (p: { versionId: string; code: string; critical: boolean }) => {
    if (p.critical && !confirm[p.versionId]) return;
    await outbox.enqueue({
      type: 'POLICY_ACK',
      ref: p.versionId,
      label: `Acknowledge ${p.code}`,
      payload: p.critical ? { confirmCritical: true } : {},
    });
    void sync.run();
  };
  const pending = (list.data ?? []).filter((p) => {
    const s = sent(p.versionId);
    return !s || s.state === 'PENDING';
  });
  return (
    <Screen title="Policies">
      {list.offline && list.data && (
        <Banner tone="AMBER">Offline – showing the last list received.</Banner>
      )}
      {list.error && <Banner tone="RED">{list.error}</Banner>}
      {!list.loading && pending.length === 0 && <P muted>Nothing to acknowledge.</P>}
      {pending.map((p) => {
        const s = sent(p.versionId);
        return (
          <Card
            key={p.versionId}
            title={`${p.code} ${p.title}`}
            right={
              <StatusPill
                status={p.critical ? 'RED' : 'AMBER'}
                label={p.critical ? 'Critical instruction' : 'Please read'}
              />
            }
          >
            <P muted>Version {p.version}</P>
            <P>{p.summary}</P>
            {s ? (
              <PendingBadge label="Acknowledged – pending sync" />
            ) : (
              <>
                {p.critical && (
                  <Toggle
                    label="I have read and understood this critical instruction"
                    value={!!confirm[p.versionId]}
                    onChange={(v) => setConfirm((c) => ({ ...c, [p.versionId]: v }))}
                  />
                )}
                <Button
                  label="Acknowledge"
                  disabled={p.critical && !confirm[p.versionId]}
                  onPress={() => void ack(p)}
                />
              </>
            )}
          </Card>
        );
      })}
    </Screen>
  );
}
