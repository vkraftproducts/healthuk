import { AUTH_MESSAGES } from '@hub/contracts';
import { Alert, Button, Card, Radio, Space, Typography } from 'antd';
import { useState, type FormEvent } from 'react';
import { DEV_USERS, DEV_USER_GROUPS, LocalAuthClient, type AuthClient } from '../auth.js';
import { BRAND, BrandMark, HeroArt } from '../brand.js';
import { LocalSignIn } from './LocalSignIn.js';

interface SignInProps {
  auth: AuthClient;
  onSignedIn: () => void;
  /** Why the user is here again, e.g. "Your session ended". */
  notice?: string | null;
}

/**
 * Sign-in page. Local mode (VITE_AUTH_MODE=local, ADR 0006): username and password checked by the
 * API. Otherwise the existing Entra / development pick-a-user page below.
 */
export function SignIn(props: SignInProps) {
  if (props.auth instanceof LocalAuthClient)
    return <LocalSignIn auth={props.auth} onSignedIn={props.onSignedIn} notice={props.notice} />;
  return <IdpSignIn {...props} />;
}

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect width="8" height="8" fill="currentColor" />
      <rect x="10" width="8" height="8" fill="currentColor" />
      <rect y="10" width="8" height="8" fill="currentColor" />
      <rect x="10" y="10" width="8" height="8" fill="currentColor" />
    </svg>
  );
}

/**
 * Production: Microsoft Entra External ID (ADR-0003). Development: pick one of the seeded
 * synthetic users; the mock sign-in server mints a token for them (never in production).
 */
function IdpSignIn({ auth, onSignedIn, notice }: SignInProps) {
  const [user, setUser] = useState<string>(DEV_USERS[0].key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.signIn(auth.kind === 'dev' ? user : undefined);
      onSignedIn();
    } catch (err) {
      const offline =
        err instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine);
      setError(
        offline ? AUTH_MESSAGES.offline : err instanceof Error ? err.message : 'Sign-in failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <section
        aria-label={`About ${BRAND.name}`}
        className="on-dark relative flex flex-col justify-between overflow-hidden md:sticky md:top-0 md:h-screen border-b border-hub-line bg-hub-navy/90 px-8 py-8 text-white md:w-[42%] md:border-b-0 md:border-r md:px-12 md:py-12"
      >
        <HeroArt />
        <div className="relative">
          <BrandMark />
          <div className="mb-10 mt-8 max-w-sm space-y-4">
            <Typography.Title level={2} className="!text-hub-ink !mb-0 font-display">
              Operations and compliance, in one place.
            </Typography.Title>
            <Typography.Paragraph className="!text-slate-200 !mb-0">
              Staff readiness, vehicles, audits, premises safety and the work planner for your
              service. Evidence counts only once it is verified.
            </Typography.Paragraph>
          </div>
        </div>
        <Typography.Text className="relative !text-xs !text-hub-muted">
          Internal measures are not CQC ratings. Access is logged.
        </Typography.Text>
      </section>

      <main id="main" className="flex flex-1 items-center justify-center p-6">
        <Card className="rise-in w-full max-w-md shadow-panel" styles={{ body: { padding: 32 } }}>
          <Space direction="vertical" size="large" className="w-full">
            <div>
              <Typography.Title level={1} className="!text-2xl !mb-1">
                Sign in
              </Typography.Title>
              <Typography.Text type="secondary" className="text-sm">
                Use your organisation account. Multi-factor authentication is required.
              </Typography.Text>
            </div>

            {notice && <Alert type="info" showIcon role="status" message={notice} />}
            {error && <Alert type="error" showIcon role="alert" message={error} />}

            {auth.kind === 'entra' ? (
              <Button
                type="primary"
                size="large"
                block
                disabled={busy}
                onClick={() => void go()}
                icon={<MicrosoftIcon />}
              >
                Sign in with Microsoft
              </Button>
            ) : (
              <form onSubmit={(e) => void go(e)} noValidate>
                <Space direction="vertical" size="middle" className="w-full">
                  <fieldset className="m-0 border-0 p-0">
                    <Typography.Text className="mb-2 block text-sm font-semibold text-hub-ink">
                      Development sign-in: choose a synthetic user
                    </Typography.Text>
                    {Object.entries(DEV_USER_GROUPS).map(([org, heading]) => (
                      <div key={org} role="group" aria-label={heading}>
                        <Typography.Text
                          type="secondary"
                          className="block pt-2 text-xs font-semibold uppercase"
                        >
                          {heading}
                        </Typography.Text>
                        <Radio.Group
                          className="mt-1.5 flex w-full flex-col gap-1.5"
                          value={user}
                          onChange={(e) => setUser(e.target.value)}
                          name="dev-user"
                        >
                          {DEV_USERS.filter((u) => u.org === org).map((u) => (
                            <Radio
                              key={u.key}
                              value={u.key}
                              className="!m-0 rounded-md border border-hub-line px-3 py-1.5 [&>.ant-radio]:self-center"
                            >
                              <span className="flex flex-1 flex-wrap justify-between gap-x-3">
                                <span className="font-semibold text-hub-ink">{u.name}</span>
                                <span className="text-hub-muted">{u.role}</span>
                              </span>
                            </Radio>
                          ))}
                        </Radio.Group>
                      </div>
                    ))}
                  </fieldset>
                  <Button type="primary" htmlType="submit" size="large" block disabled={busy}>
                    {busy ? 'Signing in…' : 'Sign in'}
                  </Button>
                  <Typography.Text type="secondary" className="text-xs">
                    Development only. Production uses Microsoft sign-in; these synthetic accounts
                    come from <code>pnpm db:seed</code> (dental and care home users from{' '}
                    <code>pnpm db:seed:sectors</code>).
                  </Typography.Text>
                </Space>
              </form>
            )}
          </Space>
        </Card>
      </main>
    </div>
  );
}