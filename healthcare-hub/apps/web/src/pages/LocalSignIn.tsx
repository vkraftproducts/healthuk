import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { AUTH_MESSAGES, passwordProblem } from '@hub/contracts';
import { LocalAuthError, type LocalAuthClient, type LocalStep } from '../auth.js';
import { BRAND, BrandMark, HeroArt } from '../brand.js';

type Step =
  | { kind: 'credentials' }
  | { kind: 'mfa'; challengeId: string }
  | { kind: 'mfa-setup'; challengeId: string; secret?: string; otpauthUri?: string }
  | { kind: 'password-change'; challengeId: string };

const input = 'field mt-1 block w-full px-3 py-2 text-base';
const primary = 'btn-primary w-full py-3 text-base';
const secondary = 'text-sm font-semibold text-hub-teal-dark underline underline-offset-2';

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
      // An expired or used-up challenge cannot be retried: start again from the password.
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
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={showPassword}
        onChange={(e) => setShowPassword(e.target.checked)}
        className="accent-hub-teal"
      />
      Show password
    </label>
  );

  const codeField = (
    <div>
      <label htmlFor={`${ids}-code`} className="block text-sm font-semibold">
        6-digit code
      </label>
      <input
        id={`${ids}-code`}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        className={input}
        aria-describedby={`${ids}-code-hint`}
      />
      <p id={`${ids}-code-hint`} className="mt-1 text-xs text-hub-muted">
        From the authenticator app on your phone. A new code appears every 30 seconds.
      </p>
    </div>
  );

  let body: ReactNode;
  if (step.kind === 'credentials') {
    body = (
      <form onSubmit={submitCredentials} className="space-y-4" noValidate>
        <div>
          <label htmlFor={`${ids}-username`} className="block text-sm font-semibold">
            Username
          </label>
          <p id={`${ids}-username-hint`} className="text-xs text-hub-muted">
            Your work email address.
          </p>
          <input
            id={`${ids}-username`}
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className={input}
            aria-describedby={`${ids}-username-hint`}
          />
        </div>
        <div>
          <label htmlFor={`${ids}-password`} className="block text-sm font-semibold">
            Password
          </label>
          <input
            id={`${ids}-password`}
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={input}
          />
        </div>
        {showToggle}
        <button type="submit" disabled={busy} className={primary}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-xs text-hub-muted">
          Forgotten your password? Ask your organisation administrator to reset it.
        </p>
      </form>
    );
  } else if (step.kind === 'mfa') {
    const { challengeId } = step;
    body = (
      <form onSubmit={(e) => submitCode(e, challengeId)} className="space-y-4" noValidate>
        <h2 className="text-lg font-semibold">Enter your authentication code</h2>
        <p className="text-sm">{AUTH_MESSAGES.mfaNeeded}.</p>
        {codeField}
        <button type="submit" disabled={busy} className={primary}>
          {busy ? 'Checking…' : 'Verify code'}
        </button>
        <button type="button" onClick={restart} className={secondary}>
          Cancel and start again
        </button>
      </form>
    );
  } else if (step.kind === 'mfa-setup') {
    const { challengeId, secret, otpauthUri } = step;
    body = (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Set up multi-factor sign-in</h2>
        <p className="text-sm">
          {AUTH_MESSAGES.mfaNeeded}. Add Healthcare Hub to an authenticator app on your phone (for
          example Microsoft Authenticator), then enter the code it shows.
        </p>
        {!secret ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => startEnrolment(challengeId)}
            className={primary}
          >
            {busy ? 'Preparing…' : 'Show my set-up key'}
          </button>
        ) : (
          <form onSubmit={(e) => submitCode(e, challengeId)} className="space-y-4" noValidate>
            <div className="space-y-2 rounded-md border border-hub-line bg-hub-row p-3 text-sm">
              <p>
                In the app choose “Enter a set-up key” (time-based) and type this key. It is shown
                only now; do not share it.
              </p>
              <p>
                <span className="font-semibold">Set-up key: </span>
                <code className="break-all font-mono" aria-label="Set-up key">
                  {secret}
                </code>
              </p>
              <p>
                <span className="font-semibold">Or paste this link into the app: </span>
                <code className="break-all font-mono text-xs" aria-label="Set-up link">
                  {otpauthUri}
                </code>
              </p>
            </div>
            {codeField}
            <button type="submit" disabled={busy} className={primary}>
              {busy ? 'Checking…' : 'Confirm and sign in'}
            </button>
          </form>
        )}
        <button type="button" onClick={restart} className={secondary}>
          Cancel and start again
        </button>
      </div>
    );
  } else {
    const { challengeId } = step;
    body = (
      <form onSubmit={(e) => submitNewPassword(e, challengeId)} className="space-y-4" noValidate>
        <h2 className="text-lg font-semibold">Choose a new password</h2>
        <p id={`${ids}-new-hint`} className="text-sm">
          You signed in with a temporary password. Choose a new one: at least 12 characters, not
          your username and not a common password.
        </p>
        <div>
          <label htmlFor={`${ids}-new`} className="block text-sm font-semibold">
            New password
          </label>
          <input
            id={`${ids}-new`}
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className={input}
            aria-describedby={`${ids}-new-hint`}
          />
        </div>
        <div>
          <label htmlFor={`${ids}-confirm`} className="block text-sm font-semibold">
            Confirm new password
          </label>
          <input
            id={`${ids}-confirm`}
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className={input}
          />
        </div>
        {showToggle}
        <button type="submit" disabled={busy} className={primary}>
          {busy ? 'Saving…' : 'Save password and sign in'}
        </button>
        <button type="button" onClick={restart} className={secondary}>
          Cancel and start again
        </button>
      </form>
    );
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <section
        aria-label={`About ${BRAND.name}`}
        className={
          'on-dark relative flex flex-col justify-between overflow-hidden md:sticky md:top-0 md:h-screen border-b border-hub-line bg-hub-navy/90 px-8 py-8 text-white ' +
          'md:w-[42%] md:border-b-0 md:border-r md:px-12 md:py-12'
        }
      >
        <HeroArt />
        <div className="relative">
          <BrandMark />
          <p className="mb-10 mt-8 max-w-sm font-display text-3xl font-semibold leading-tight tracking-tight text-hub-ink">
            Operations and compliance, in one place.
          </p>
        </div>
        <p className="relative text-xs text-hub-muted">
          Internal measures are not CQC ratings. Access is logged.
        </p>
      </section>

      <main id="main" className="flex flex-1 items-center justify-center p-6">
        <div className="hud glass rise-in w-full max-w-md space-y-6 rounded-2xl border border-hub-line p-8 shadow-panel">
          <div>
            <h1 className="font-display text-2xl font-bold">
              Sign in with your organisation account
            </h1>
            <p className="mt-1 text-sm text-hub-muted">
              Managers, directors, administrators, HR, governance and auditors also need a code from
              an authenticator app.
            </p>
          </div>

          {notice && (
            <p role="status" className="rounded-md border border-sky-700 bg-sky-50 p-3 text-sm">
              {notice}
            </p>
          )}
          <div aria-live="assertive" aria-atomic="true">
            {error && (
              <div
                role="alert"
                className="rounded-md border-2 border-red-700 bg-red-50 p-3 text-sm text-red-900"
              >
                <p className="font-semibold">
                  <span aria-hidden="true">⚠ </span>There is a problem
                </p>
                <p>{error}</p>
              </div>
            )}
          </div>

          {body}
        </div>
      </main>
    </div>
  );
}
