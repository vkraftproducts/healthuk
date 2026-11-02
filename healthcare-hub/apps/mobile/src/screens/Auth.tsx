import { useEffect, useState } from 'react';
import { useServices } from '../app/services';
import type { WipeReason } from '../core/session';
import { MAX_UNLOCK_FAILURES } from '../core/session';
import { Banner, Button, P, Screen } from '../ui/kit';

const WIPED: Record<WipeReason, string> = {
  SIGNED_OUT: 'You have signed out. Data has been removed from this device.',
  DEVICE_REVOKED: 'This device has been signed out by your organisation. Data has been removed.',
  USER_INACTIVE: 'Your access has ended. Data has been removed from this device.',
  UNLOCK_FAILED: 'Too many failed unlock attempts. Data has been removed from this device.',
};

export function SignIn({ why }: { why?: WipeReason }) {
  const { session } = useServices();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Screen title="Healthcare Hub crew">
      {why && <Banner tone={why === 'SIGNED_OUT' ? 'GREEN' : 'RED'}>{WIPED[why]}</Banner>}
      <P>Sign in with your work account.</P>
      <Button
        label={busy ? 'Signing in…' : 'Sign in'}
        disabled={busy}
        onPress={() => {
          setBusy(true);
          setErr(null);
          session
            .signIn()
            .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Sign-in failed'))
            .finally(() => setBusy(false));
        }}
      />
      {err && <Banner tone="RED">{err}</Banner>}
    </Screen>
  );
}

export function Unlock() {
  const { session } = useServices();
  const [failures, setFailures] = useState(0);
  useEffect(() => {
    void session.unlockFailures().then(setFailures);
  }, [session]);
  const left = MAX_UNLOCK_FAILURES - failures;
  return (
    <Screen title="Unlock">
      <P>Unlock with your fingerprint, face or device passcode.</P>
      {failures > 0 && (
        <Banner tone="AMBER">
          Unlock failed. {left} attempt{left === 1 ? '' : 's'} left before data is removed from this
          device.
        </Banner>
      )}
      <Button
        label="Unlock"
        onPress={() =>
          void session.unlock().then(async (r) => {
            if (r === 'FAILED') setFailures(await session.unlockFailures());
          })
        }
      />
    </Screen>
  );
}
