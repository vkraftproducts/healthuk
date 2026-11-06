import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTH_MESSAGES } from '@hub/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAuthClient, NotSignedInError } from '../src/auth.js';
import { SignIn } from '../src/pages/SignIn.js';

type Reply = { status: number; body: unknown };

/** Fake API: answers each POST in turn and records what was sent (path + body). */
function fakeApi(replies: Reply[]) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({
        path: new URL(url, 'http://web.test').pathname,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      const next = replies.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  );
  return sent;
}

const token = { access_token: 'tok-local-1', token_type: 'Bearer', expires_in: 900 };
const problem = (status: number, code: string, detail: string) => ({
  status,
  body: { type: 'about:blank', title: 'x', status, code, detail },
});

function renderLocal() {
  const auth = new LocalAuthClient('');
  const onSignedIn = vi.fn();
  render(<SignIn auth={auth} onSignedIn={onSignedIn} />);
  return { auth, onSignedIn };
}

async function enterCredentials(username = 'crew@example.test', password = 'Synthetic-pass-1') {
  await userEvent.type(screen.getByLabelText('Username'), username);
  await userEvent.type(screen.getByLabelText('Password'), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('local sign-in page [ADR 0006]', () => {
  it('shows a labelled username and password form with a show-password toggle', async () => {
    renderLocal();
    expect(
      screen.getByRole('heading', { name: 'Sign in with your organisation account' }),
    ).toBeInTheDocument();
    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('signs in, keeping the token in memory only', async () => {
    const sent = fakeApi([{ status: 200, body: token }]);
    const { auth, onSignedIn } = renderLocal();
    await enterCredentials();
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(sent[0]).toEqual({
      path: '/api/v1/auth/login',
      body: { username: 'crew@example.test', password: 'Synthetic-pass-1' },
    });
    expect(await auth.getToken()).toBe('tok-local-1');
    const stored = JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage });
    expect(stored).not.toContain('tok-local-1');
    expect(stored).not.toContain('Synthetic-pass-1');
    auth.signOut();
    await expect(auth.getToken()).rejects.toBeInstanceOf(NotSignedInError);
  });

  it('announces the generic error and clears the password', async () => {
    fakeApi([problem(401, 'UNAUTHENTICATED', AUTH_MESSAGES.invalid)]);
    const { onSignedIn } = renderLocal();
    await enterCredentials();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('There is a problem');
    expect(alert).toHaveTextContent(AUTH_MESSAGES.invalid);
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('asks for the authenticator code when the role needs MFA', async () => {
    const sent = fakeApi([
      { status: 200, body: { mfaRequired: true, challengeId: 'challenge-abcdefghijklmnop' } },
      problem(401, 'UNAUTHENTICATED', AUTH_MESSAGES.badCode),
      { status: 200, body: token },
    ]);
    const { onSignedIn } = renderLocal();
    await enterCredentials('manager@example.test');
    expect(
      await screen.findByRole('heading', { name: 'Enter your authentication code' }),
    ).toBeInTheDocument();
    expect(screen.getByText(`${AUTH_MESSAGES.mfaNeeded}.`)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('6-digit code'), '111111');
    await userEvent.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_MESSAGES.badCode);

    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify code' }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(sent[2]).toEqual({
      path: '/api/v1/auth/mfa/verify',
      body: { challengeId: 'challenge-abcdefghijklmnop', code: '123456' },
    });
  });

  it('walks through TOTP enrolment, showing the key and link as text', async () => {
    fakeApi([
      {
        status: 200,
        body: { mfaSetupRequired: true, challengeId: 'challenge-enrol-123456789' },
      },
      {
        status: 200,
        body: {
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/Healthcare%20Hub:hr%40example.test?secret=JBSWY3DP',
        },
      },
      { status: 200, body: token },
    ]);
    const { onSignedIn } = renderLocal();
    await enterCredentials('hr@example.test');
    expect(
      await screen.findByRole('heading', { name: 'Set up multi-factor sign-in' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show my set-up key' }));
    expect(await screen.findByText('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByText(/^otpauth:\/\/totp\//)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('6-digit code'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and sign in' }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });

  it('makes a person with a temporary password choose a new one', async () => {
    fakeApi([
      {
        status: 200,
        body: { passwordChangeRequired: true, challengeId: 'challenge-pw-1234567890' },
      },
      { status: 200, body: token },
    ]);
    const { onSignedIn } = renderLocal();
    await enterCredentials('new.starter@example.test', 'Abcde-Fghij-Klmno-Pqrst');
    expect(
      await screen.findByRole('heading', { name: 'Choose a new password' }),
    ).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('New password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Save password and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 12 characters.');
    expect(onSignedIn).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('New password'));
    await userEvent.clear(screen.getByLabelText('Confirm new password'));
    await userEvent.type(screen.getByLabelText('New password'), 'Synthetic-New-Pass-77');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'Synthetic-New-Pass-77');
    await userEvent.click(screen.getByRole('button', { name: 'Save password and sign in' }));
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
  });
});
