import { AUTH_MESSAGES } from '@hub/contracts';
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
            <p className="font-display text-3xl font-semibold leading-tight tracking-tight text-hub-ink">
              Operations and compliance, in one place.
            </p>
            <p className="text-slate-200">
              Staff readiness, vehicles, audits, premises safety and the work planner for your
              service. Evidence counts only once it is verified.
            </p>
          </div>
        </div>
        <p className="relative text-xs text-hub-muted">
          Internal measures are not CQC ratings. Access is logged.
        </p>
      </section>

      <main id="main" className="flex flex-1 items-center justify-center p-6">
        <div className="hud glass rise-in w-full max-w-md space-y-6 rounded-2xl border border-hub-line p-8 shadow-panel">
          <div>
            <h1 className="font-display text-2xl font-bold">Sign in</h1>
            <p className="mt-1 text-sm text-hub-muted">
              Use your organisation account. Multi-factor authentication is required.
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
              className="flex w-full items-center justify-center gap-3 rounded-lg bg-hub-teal px-4 py-3 font-semibold text-white disabled:opacity-50"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <rect width="8" height="8" fill="currentColor" />
                <rect x="10" width="8" height="8" fill="currentColor" />
                <rect y="10" width="8" height="8" fill="currentColor" />
                <rect x="10" y="10" width="8" height="8" fill="currentColor" />
              </svg>
              Sign in with Microsoft
            </button>
          ) : (
            <form onSubmit={(e) => void go(e)} className="space-y-4">
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-semibold text-hub-ink">
                  Development sign-in: choose a synthetic user
                </legend>
                {Object.entries(DEV_USER_GROUPS).map(([org, heading]) => (
                  <div key={org} role="group" aria-label={heading} className="space-y-1.5">
                    <p className="pt-2 text-xs font-semibold uppercase text-hub-muted">{heading}</p>
                    {DEV_USERS.filter((u) => u.org === org).map((u) => (
                      <label
                        key={u.key}
                        className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-1.5 text-sm ${
                          user === u.key
                            ? 'border-hub-teal bg-teal-50 ring-1 ring-hub-teal'
                            : 'border-hub-line hover:bg-hub-row'
                        }`}
                      >
                        <input
                          type="radio"
                          name="dev-user"
                          value={u.key}
                          checked={user === u.key}
                          onChange={() => setUser(u.key)}
                          className="accent-hub-teal"
                        />
                        <span className="flex flex-1 flex-wrap justify-between gap-x-3">
                          <span className="font-semibold text-hub-ink">{u.name}</span>
                          <span className="text-hub-muted">{u.role}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </fieldset>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-lg bg-hub-teal px-4 py-3 font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <p className="text-xs text-hub-muted">
                Development only. Production uses Microsoft sign-in; these synthetic accounts come
                from <code>pnpm db:seed</code> (dental and care home users from{' '}
                <code>pnpm db:seed:sectors</code>).
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
