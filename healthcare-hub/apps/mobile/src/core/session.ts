import type { AuthProvider, Biometrics, Clock, SecureKv, Tokens } from './ports';

export const KEYS = {
  tokens: 'hub.tokens',
  orgId: 'hub.orgId',
  deviceId: 'hub.deviceId',
  dbKey: 'hub.dbKey',
  bioFailures: 'hub.bioFailures',
} as const;

/** Five failed biometric unlocks wipe the device (MOBILE_APP "Cache TTL"). */
export const MAX_UNLOCK_FAILURES = 5;
const REFRESH_MARGIN_MS = 60_000;

export type SessionState = 'SIGNED_OUT' | 'LOCKED' | 'READY';
export type WipeReason = 'SIGNED_OUT' | 'DEVICE_REVOKED' | 'USER_INACTIVE' | 'UNLOCK_FAILED';

/**
 * Sign-in (Entra External ID, PKCE), biometric unlock for returning sessions, and the wipe rules.
 * Tokens live only in the hardware-backed secure store.
 */
export class Session {
  state: SessionState = 'SIGNED_OUT';
  private tokens: Tokens | null = null;
  private orgId: string | null = null;
  private listeners = new Set<(s: SessionState, why?: WipeReason) => void>();

  constructor(
    private readonly d: {
      kv: SecureKv;
      auth: AuthProvider;
      bio: Biometrics;
      wipe: () => Promise<void>;
      clock: Clock;
    },
  ) {}

  subscribe(fn: (s: SessionState, why?: WipeReason) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private set(s: SessionState, why?: WipeReason) {
    this.state = s;
    for (const fn of this.listeners) fn(s, why);
  }

  /** App launch: a stored session needs unlocking before anything is shown. */
  async restore(): Promise<SessionState> {
    const raw = await this.d.kv.get(KEYS.tokens);
    this.tokens = raw ? (JSON.parse(raw) as Tokens) : null;
    this.orgId = await this.d.kv.get(KEYS.orgId);
    this.set(this.tokens ? 'LOCKED' : 'SIGNED_OUT');
    return this.state;
  }

  /** The device must have a passcode (expo-local-authentication) before any data is stored. */
  async signIn(): Promise<void> {
    if (!(await this.d.bio.available()))
      throw new Error('Set a screen lock (passcode or biometrics) on this device to continue.');
    const t = await this.d.auth.signIn();
    await this.saveTokens(t);
    await this.d.kv.delete(KEYS.bioFailures);
    this.set('READY');
  }

  async unlock(): Promise<'OK' | 'FAILED' | 'WIPED'> {
    if (await this.d.bio.authenticate('Unlock Healthcare Hub')) {
      await this.d.kv.delete(KEYS.bioFailures);
      this.set('READY');
      return 'OK';
    }
    const failures = Number((await this.d.kv.get(KEYS.bioFailures)) ?? '0') + 1;
    if (failures >= MAX_UNLOCK_FAILURES) {
      await this.wipe('UNLOCK_FAILED');
      return 'WIPED';
    }
    await this.d.kv.set(KEYS.bioFailures, String(failures));
    return 'FAILED';
  }

  async unlockFailures(): Promise<number> {
    return Number((await this.d.kv.get(KEYS.bioFailures)) ?? '0');
  }

  /** App went to the background: require unlock again when it returns. */
  lock(): void {
    if (this.state === 'READY') this.set('LOCKED');
  }

  /** A current access token, refreshed shortly before expiry. Null when signed out. */
  async token(): Promise<string | null> {
    if (!this.tokens || this.state !== 'READY') return null;
    if (this.tokens.expiresAt - REFRESH_MARGIN_MS > this.d.clock().getTime())
      return this.tokens.accessToken;
    const next = this.tokens.refreshToken
      ? await this.d.auth.refresh(this.tokens.refreshToken).catch(() => null)
      : null;
    if (!next) {
      // Keep the encrypted outbox; the person signs in again to send it.
      this.tokens = null;
      await this.d.kv.delete(KEYS.tokens);
      this.set('SIGNED_OUT');
      return null;
    }
    await this.saveTokens(next);
    return next.accessToken;
  }

  getOrgId(): string | null {
    return this.orgId;
  }
  async setOrgId(id: string): Promise<void> {
    this.orgId = id;
    await this.d.kv.set(KEYS.orgId, id);
  }

  async signOut(): Promise<void> {
    await this.wipe('SIGNED_OUT');
  }

  /** Removes every trace of the session and its data from the device. */
  async wipe(why: WipeReason): Promise<void> {
    this.tokens = null;
    this.orgId = null;
    await this.d.wipe();
    this.set('SIGNED_OUT', why);
  }

  private async saveTokens(t: Tokens) {
    this.tokens = t;
    await this.d.kv.set(KEYS.tokens, JSON.stringify(t));
  }
}

/**
 * Everything the app holds: encrypted database rows, photos waiting to upload, secrets. A new
 * device id is issued afterwards, so a revoked registration is never reused.
 */
export async function wipeDevice(d: {
  kv: SecureKv;
  clearStore: () => Promise<void>;
  clearFiles: () => Promise<void>;
  clearNotifications?: () => Promise<void>;
}): Promise<void> {
  const steps: (() => Promise<unknown>)[] = [
    d.clearStore,
    d.clearFiles,
    ...(d.clearNotifications ? [d.clearNotifications] : []),
    ...Object.values(KEYS).map((k) => () => d.kv.delete(k)),
  ];
  // Every step runs even if one fails; the first failure is reported afterwards.
  const errors: unknown[] = [];
  for (const s of steps) await s().catch((e: unknown) => errors.push(e));
  if (errors.length > 0) throw errors[0];
}
