import { useState, type FormEvent } from 'react';
import type { AuthClient } from '../auth.js';

/**
 * Sign-in page. Production: Microsoft Entra External ID (ADR-0003). Development: username and
 * password, checked by the mock sign-in server against the development database (never in production).
 */
export function SignIn({
  auth,
  onSignedIn,
  notice,
}: {
  auth: AuthClient;
  onSignedIn: () => void;
  /** Why the user is here again, e.g. "Your session ended". */
  notice?: string | null;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.signIn(
        auth.kind === 'dev' ? username : undefined,
        auth.kind === 'dev' ? password : undefined,
      );
      onSignedIn();
    } catch (err) {
      setPassword('');
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-hub-bg md:flex-row">
      <section
        aria-label="About Healthcare Hub"
        className="flex flex-col justify-between bg-hub-navy px-8 py-8 text-white md:w-[40%] md:px-12 md:py-12"
      >
        <div className="text-[15px] font-bold tracking-wide">HEALTHCARE HUB</div>
        <div className="my-10 max-w-md space-y-4">
          <p className="text-3xl font-bold leading-tight">
            Operations and compliance, in one place.
          </p>
          <p className="text-slate-200">
            Staff readiness, vehicles, audits, premises safety and the work planner for your
            service. Evidence counts only once it is verified.
          </p>
        </div>
        <p className="text-xs text-slate-300">
          Internal measures are not CQC ratings. Access is logged.
        </p>
      </section>

      <main id="main" className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-md space-y-6 rounded-lg border border-hub-line bg-white p-8">
          <div>
            <h1 className="text-2xl font-bold">Sign in</h1>
            <p className="mt-1 text-sm text-hub-muted">
              {auth.kind === 'entra'
                ? 'Use your organisation account. Multi-factor authentication is required.'
                : 'Development sign-in. There is no second factor here; production requires one.'}
            </p>
          </div>

          {notice && (
            <p role="status" className="rounded-md border border-sky-700 bg-sky-50 p-3 text-sm">
              {notice}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-md border border-red-700 bg-red-50 p-3 text-sm text-red-900"
            >
              {error}
            </p>
          )}

          {auth.kind === 'entra' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void go()}
              className="flex w-full items-center justify-center gap-3 rounded-md bg-hub-teal px-4 py-3 font-semibold text-white hover:bg-hub-teal-dark disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <rect width="8" height="8" fill="#fff" />
                <rect x="10" width="8" height="8" fill="#fff" />
                <rect y="10" width="8" height="8" fill="#fff" />
                <rect x="10" y="10" width="8" height="8" fill="#fff" />
              </svg>
              Sign in with Microsoft
            </button>
          ) : (
            <form onSubmit={(e) => void go(e)} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="sign-in-username" className="text-sm font-semibold text-hub-navy">
                  Username
                </label>
                <input
                  id="sign-in-username"
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-md border border-hub-line px-3 py-2"
                />
              </div>
              <div className="space-y-1">
                <label htmlFor="sign-in-password" className="text-sm font-semibold text-hub-navy">
                  Password
                </label>
                <input
                  id="sign-in-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-hub-line px-3 py-2"
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-md bg-hub-teal px-4 py-3 font-semibold text-white hover:bg-hub-teal-dark disabled:opacity-50"
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
