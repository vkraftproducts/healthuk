import { View } from 'react-native';
import { useToday } from '../app/hooks';
import { useNav } from '../app/nav';
import { useOutboxItems } from '../app/services';
import { stateWithPending, STATE_LABEL } from '../core/shift';
import { Button, Card, P, PendingBadge, Row, Screen, StatusPill, words } from '../ui/kit';
import { time } from '../ui/theme';

export function Jobs() {
  const today = useToday();
  const nav = useNav();
  const items = useOutboxItems();
  const jobs = today.data?.today.shift?.jobs ?? [];
  return (
    <Screen title="Jobs">
      {jobs.length === 0 && <P muted>{today.loading ? 'Loading…' : 'No jobs allocated to you.'}</P>}
      {jobs.map((j) => {
        const st = stateWithPending(j.id, j.state, items);
        return (
          <Card
            key={j.id}
            title={j.code}
            right={
              <StatusPill
                status={st.state === 'OFFERED' ? 'REQUIRED' : 'GREY'}
                label={STATE_LABEL[st.state]}
              />
            }
          >
            <Row label="Pick up" value={`${time(j.pickupFrom)} – ${time(j.pickupTo)}`} />
            <Row label="Mobility" value={words(j.mobility)} />
            {st.pending && (
              <View>
                <PendingBadge />
              </View>
            )}
            <Button label="Open job" onPress={() => nav.push({ name: 'job', id: j.id })} />
          </Card>
        );
      })}
    </Screen>
  );
}
