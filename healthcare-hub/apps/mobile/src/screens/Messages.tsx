import { View } from 'react-native';
import { useOnline, useOutboxItems, useServices } from '../app/services';
import type { OutboxItem } from '../core/outbox';
import { Banner, Button, Card, P, PendingBadge, Row, Screen, StatusPill } from '../ui/kit';
import { time } from '../ui/theme';

/**
 * Items waiting to send, and anything the server could not accept. Conflicts (e.g. a job reassigned
 * while offline) show the server's current state; nothing is overwritten silently.
 */
export function Messages() {
  const { outbox, sync, callControl } = useServices();
  const online = useOnline();
  const items = useOutboxItems();
  const problems = items.filter((i) => i.state !== 'PENDING');
  const pending = items.filter((i) => i.state === 'PENDING');
  return (
    <Screen title="Messages">
      {problems.length > 0 && (
        <Banner tone="RED">
          {problems.length} item{problems.length === 1 ? '' : 's'} could not be accepted. Read each
          one and call control if unsure.
        </Banner>
      )}
      {problems.map((i) => (
        <Card
          key={i.clientSubmissionId}
          title={i.label}
          right={
            <StatusPill
              status={i.state}
              label={i.state === 'CONFLICT' ? 'Needs reconciling' : 'Not accepted'}
            />
          }
        >
          <Row label="Recorded" value={time(i.capturedAt)} />
          <P>{i.error?.detail ?? 'The server did not accept this.'}</P>
          <ServerState item={i} />
          <Button kind="danger" label="Call control" onPress={callControl} />
          {i.state === 'REJECTED' && (
            <Button
              kind="secondary"
              label="Try sending again"
              onPress={() => void outbox.retryNow(i.clientSubmissionId).then(() => sync.run())}
            />
          )}
          <Button
            kind="secondary"
            label="I have dealt with this – remove"
            onPress={() => void outbox.dismiss(i.clientSubmissionId)}
          />
        </Card>
      ))}
      <Card title="Waiting to send" right={<PendingBadge label={`${pending.length} pending`} />}>
        {pending.length === 0 && <P muted>Everything has been sent.</P>}
        {pending.map((i) => (
          <View key={i.clientSubmissionId}>
            <Row label={i.label} value={time(i.capturedAt)} />
            {i.attempts > 0 && (
              <P muted>
                Tried {i.attempts} time{i.attempts === 1 ? '' : 's'}; will retry automatically.
              </P>
            )}
          </View>
        ))}
        <Button
          label="Send now"
          disabled={!online || pending.length === 0}
          onPress={() => void sync.run()}
        />
        {!online && <P muted>You are offline. Items are sent automatically when you reconnect.</P>}
      </Card>
    </Screen>
  );
}

function ServerState({ item }: { item: OutboxItem }) {
  const s = item.serverState;
  if (!s) return null;
  const state = typeof s.state === 'string' ? s.state : null;
  const code = typeof s.code === 'string' ? s.code : null;
  return (
    <View style={{ gap: 4 }}>
      <P muted>Current state on the server:</P>
      {code && <Row label="Reference" value={code} />}
      {state && <Row label="State" value={state.replace(/_/g, ' ').toLowerCase()} />}
    </View>
  );
}
