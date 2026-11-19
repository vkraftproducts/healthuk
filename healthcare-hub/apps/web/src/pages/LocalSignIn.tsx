import { useId, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { Alert, Button, Card, Checkbox, Input, Space, Typography } from 'antd';
import { AUTH_MESSAGES, passwordProblem } from '@hub/contracts';
import { LocalAuthError, type LocalAuthClient, type LocalStep } from '../auth.js';
import { BRAND, BrandMark } from '../brand.js';

/** A label above its box and an optional hint below it (no inline labels or colons). */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-hub-ink">
        {label}
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className="text-xs text-hub-muted">
          {hint}
        </span>
      )}
    </div>
  );
}

const WHAT_IT_COVERS = [
  'Staff readiness, training and pre-employment checks',
  'Vehicle checks, defects and safe return to service',
  'Incidents, safeguarding and complaints',
  'Evidence and governance, ready for CQC',
];

type Step =
  | { kind: 'credentials' }
  | { kind: 'mfa'; challengeId: string }
  | { kind: 'mfa-setup'; challengeId: string; secret?: string; otpauthUri?: string }
  | { kind: 'password-change'; challengeId: string };

/**
 * Username + password sign-in run by the Healthcare Hub API (VITE_AUTH_MODE=local, ADR 0006):
 * credentials, then (for privileged roles) a TOTP code or TOTP enrolment, then a forced password
 * change after an administrator reset. Errors are announced (aria-live) and shown as text with an
 * icon, never by colour alone.
 */
export function LocalSignIn({
  auth,
  onSignedIn,
  notice,
}: {
  auth: LocalAuthClient;
  onSignedIn: () => void;
  notice?: string | null;
}) {
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [username, setUsername] = useState(() => auth.rememberedUsername());
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  function follow(next: LocalStep) {
    setCode('');
    setPassword('');
    if (next.kind === 'signed-in') onSignedIn();
    else setStep(next);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed. Try again.';
      setError(message);
      if (err instanceof LocalAuthError && message === AUTH_MESSAGES.challengeExpired) {
        setStep({ kind: 'credentials' });
        setPassword('');
      }
    } finally {
      setBusy(false);
    }
  }

  function submitCredentials(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    void run(async () => {
      try {
        follow(await auth.login(username, password));
      } catch (err) {
        setPassword('');
        throw err;
      }
    });
  }

  function submitCode(e: FormEvent, challengeId: string) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    void run(async () => {
      try {
        follow(await auth.verifyMfa(challengeId, code.trim()));
      } catch (err) {
        setCode('');
        throw err;
      }
    });
  }

  function startEnrolment(challengeId: string) {
    void run(async () => {
      const r = await auth.setupMfa(challengeId);
      setStep({ kind: 'mfa-setup', challengeId, ...r });
    });
  }

  function submitNewPassword(e: FormEvent, challengeId: string) {
    e.preventDefault();
    const problem =
      passwordProblem(username, newPassword) ??
      (newPassword !== confirmPassword ? 'The two passwords do not match.' : null);
    if (problem) {
      setError(problem);
      return;
    }
    void run(async () => {
      follow(await auth.changeTemporaryPassword(challengeId, newPassword));
      setNewPassword('');
      setConfirmPassword('');
    });
  }

  function restart() {
    setStep({ kind: 'credentials' });
    setError(null);
    setCode('');
    setPassword('');
  }

  const showToggle = (
    <Checkbox checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)}>
      Show password
    </Checkbox>
  );

  const codeField = (
    <Field
      id={`${ids}-code`}
      label="6-digit code"
      hint="From the authenticator app on your phone. A new code appears every 30 seconds."
    >
      <Input
        size="large"
        id={`${ids}-code`}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        aria-describedby={`${ids}-code-hint`}
      />
    </Field>
  );

  let body: ReactNode;
  if (step.kind === 'credentials') {
    body = (
      <form onSubmit={submitCredentials} noValidate>
        <Space direction="vertical" size={20} className="w-full">
          <Field id={`${ids}-username`} label="Work email">
            <Input
              id={`${ids}-username`}
              name="username"
              size="large"
              type="email"
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="name@organisation.co.uk"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field id={`${ids}-password`} label="Password">
            <Input
              id={`${ids}-password`}
              name="password"
              size="large"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {showToggle}
          <Button type="primary" htmlType="submit" size="large" block disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Typography.Text type="secondary" className="block text-xs leading-relaxed">
            Forgotten your password? Ask your organisation administrator to reset it. Managers and
            other senior roles may be asked for a code from an authenticator app next.
          </Typography.Text>
        </Space>
      </form>
    );
  } else if (step.kind === 'mfa') {
    const { challengeId } = step;
    body = (
      <form onSubmit={(e) => submitCode(e, challengeId)} noValidate>
        <Space direction="vertical" size="middle" className="w-full">
          <Typography.Title level={2} className="!text-lg !mb-0">
            Enter your authentication code
          </Typography.Title>
          <Typography.Paragraph className="!mb-0">{AUTH_MESSAGES.mfaNeeded}.</Typography.Paragraph>
          {codeField}
          <Button type="primary" htmlType="submit" size="large" block disabled={busy}>
            {busy ? 'Checking…' : 'Verify code'}
          </Button>
          <Button type="link" onClick={restart} className="!px-0">
            Cancel and start again
          </Button>
        </Space>
      </form>
    );
  } else if (step.kind === 'mfa-setup') {
    const { challengeId, secret, otpauthUri } = step;
    body = (
      <Space direction="vertical" size="middle" className="w-full">
        <Typography.Title level={2} className="!text-lg !mb-0">
          Set up multi-factor sign-in
        </Typography.Title>
        <Typography.Paragraph className="!mb-0">
          {AUTH_MESSAGES.mfaNeeded}. Add Healthcare Hub to an authenticator app on your phone (for
          example Microsoft Authenticator), then enter the code it shows.
        </Typography.Paragraph>
        {!secret ? (
          <Button
            type="primary"
            size="large"
            block
            disabled={busy}
            onClick={() => startEnrolment(challengeId)}
          >
            {busy ? 'Preparing…' : 'Show my set-up key'}
          </Button>
        ) : (
          <form onSubmit={(e) => submitCode(e, challengeId)} noValidate>
            <Space direction="vertical" size="middle" className="w-full">
              <Card size="small" className="bg-hub-row">
                <Typography.Paragraph className="!mb-2 !text-sm">
                  In the app choose “Enter a set-up key” (time-based) and type this key. It is shown
                  only now; do not share it.
                </Typography.Paragraph>
                <Typography.Paragraph className="!mb-2 !text-sm">
                  <Typography.Text strong>Set-up key: </Typography.Text>
                  <Typography.Text code className="break-all" aria-label="Set-up key">
                    {secret}
                  </Typography.Text>
                </Typography.Paragraph>
                <Typography.Paragraph className="!mb-0 !text-sm">
                  <Typography.Text strong>Or paste this link into the app: </Typography.Text>
                  <Typography.Text code className="break-all text-xs" aria-label="Set-up link">
                    {otpauthUri}
                  </Typography.Text>
                </Typography.Paragraph>
              </Card>
              {codeField}
              <Button type="primary" htmlType="submit" size="large" block disabled={busy}>
                {busy ? 'Checking…' : 'Confirm and sign in'}
              </Button>
            </Space>
          </form>
        )}
        <Button type="link" onClick={restart} className="!px-0">
          Cancel and start again
        </Button>
      </Space>
    );
  } else {
    const { challengeId } = step;
    body = (
      <form onSubmit={(e) => submitNewPassword(e, challengeId)} noValidate>
        <Space direction="vertical" size="middle" className="w-full">
          <Typography.Title level={2} className="!text-lg !mb-0">
            Choose a new password
          </Typography.Title>
          <Typography.Paragraph id={`${ids}-new-hint`} className="!mb-0 text-sm">
            You signed in with a temporary password. Choose a new one: at least 12 characters, not
            your username and not a common password.
          </Typography.Paragraph>
          <Field id={`${ids}-new`} label="New password">
            <Input
              id={`${ids}-new`}
              size="large"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              aria-describedby={`${ids}-new-hint`}
            />
          </Field>
          <Field id={`${ids}-confirm`} label="Confirm new password">
            <Input
              id={`${ids}-confirm`}
              size="large"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Field>
          {showToggle}
          <Button type="primary" htmlType="submit" size="large" block disabled={busy}>
            {busy ? 'Saving…' : 'Save password and sign in'}
          </Button>
          <Button type="link" onClick={restart} className="!px-0">
            Cancel and start again
          </Button>
        </Space>
      </form>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-hub-row md:flex-row">
      <section
        aria-label={`About ${BRAND.name}`}
        className="relative flex flex-col justify-between gap-10 overflow-hidden px-8 py-8 text-white md:sticky md:top-0 md:h-screen md:w-[42%] md:px-14 md:py-12"
        style={{
          background:
            'radial-gradient(900px 500px at 0% 0%, rgba(96,165,250,0.35), transparent 60%), linear-gradient(155deg, #0b2a55 0%, #12407f 55%, #1667d9 100%)',
        }}
      >
        <div
          style={
            { '--side-ink': '#ffffff', '--side-mut': 'rgba(255,255,255,0.75)' } as CSSProperties
          }
        >
          <BrandMark />
        </div>
        <div className="max-w-md">
          <h2 className="m-0 font-display text-3xl font-semibold leading-tight tracking-tight text-white md:text-4xl">
            Operations and compliance, in one place.
          </h2>
          <p className="mt-4 hidden text-base leading-relaxed text-white/80 md:block">
            For independent ambulance, patient transport and care providers in England.
          </p>
          <ul className="mt-8 hidden list-none flex-col gap-3 p-0 md:flex">
            {WHAT_IT_COVERS.map((t) => (
              <li key={t} className="flex items-start gap-3 text-sm text-white/90">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full bg-white/15 text-xs"
                >
                  ✓
                </span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="m-0 hidden text-xs text-white/70 md:block">
          Internal measures are not CQC ratings. Access is logged.
        </p>
      </section>

      <main id="main" className="flex flex-1 items-center justify-center px-6 py-10">
        <Card
          className="rise-in w-full max-w-[420px] shadow-panel"
          styles={{ body: { padding: 36 } }}
        >
          <Space direction="vertical" size={24} className="w-full">
            <div>
              <Typography.Title level={1} className="!mb-1 !font-display !text-2xl !font-bold">
                Sign in
              </Typography.Title>
              <Typography.Text type="secondary" className="text-sm">
                Use your organisation account.
              </Typography.Text>
            </div>

            {notice && <Alert type="info" showIcon role="status" message={notice} />}
            <div aria-live="assertive" aria-atomic="true">
              {error && (
                <Alert
                  type="error"
                  showIcon
                  role="alert"
                  message="There is a problem"
                  description={error}
                />
              )}
            </div>

            {body}
          </Space>
        </Card>
      </main>
    </div>
  );
}
