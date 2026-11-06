import { createPrivateKey, sign as signWith, type KeyObject } from 'node:crypto';
import type { Mailer } from './notifications.js';

/**
 * Delivery of escalation notifications. A `NotificationSender` delivers one generic message to one
 * person over one channel through a pluggable transport. Messages never carry patient data, names
 * or record titles (non-negotiable 7); transports must not log addresses, tokens or content.
 */
export interface OutboundMessage {
  subject: string;
  body: string;
  /** Opaque in-app path such as `/staff/<uuid>`; never personal data. */
  linkPath: string;
  /** `appUrl + linkPath`. */
  url: string;
  alertId: string;
}

export interface DeliveryDevice {
  id: string;
  kind: 'EXPO' | 'WEB_PUSH';
  token: string;
}

export interface DeliveryRecipient {
  userId: string;
  email: string;
  devices: readonly DeliveryDevice[];
}

export interface SendOutcome {
  ok: boolean;
  /** Short error code from the transport (never content). */
  error?: string;
  /** Device ids the push service says are gone: the registrations are revoked. */
  invalidDeviceIds?: string[];
}

export interface NotificationSender {
  readonly channel: 'EMAIL' | 'PUSH';
  send(to: DeliveryRecipient, msg: OutboundMessage): Promise<SendOutcome>;
}

// ---- email -----------------------------------------------------------------------------------------

/** Email transport: the existing `Mailer` shape (SMTP, or the development outbox). */
export type EmailTransport = Mailer;

export class EmailSender implements NotificationSender {
  readonly channel = 'EMAIL' as const;
  constructor(private readonly transport: EmailTransport) {}
  async send(to: DeliveryRecipient, msg: OutboundMessage): Promise<SendOutcome> {
    if (!to.email) return { ok: false, error: 'NO_ADDRESS' };
    try {
      await this.transport.send({
        to: to.email,
        subject: msg.subject,
        text: `${msg.body}\n\nOpen Healthcare Hub: ${msg.url}\n`,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errorCode(e) };
    }
  }
}

/**
 * Development / test email transport: keeps what would be sent in memory and logs only the
 * recipient's domain. The durable record is the `notification_outbox` row itself.
 */
export class OutboxEmailTransport implements EmailTransport {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  constructor(private readonly log?: (msg: string, ctx: object) => void) {}
  async send(m: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(m);
    this.log?.('email (outbox, not sent)', { toDomain: m.to.split('@')[1] ?? 'unknown' });
  }
}

// ---- push ------------------------------------------------------------------------------------------

/** Generic push content: the app or service worker fetches details after sign-in. */
export interface PushContent {
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface PushDeliveryResult {
  ok: boolean;
  invalidToken?: boolean;
  error?: string;
}

export interface PushTransport {
  send(devices: readonly DeliveryDevice[], content: PushContent): Promise<PushDeliveryResult[]>;
}

export class PushSender implements NotificationSender {
  readonly channel = 'PUSH' as const;
  /** `transports` by device kind; a kind with no transport is not delivered (NO_TRANSPORT). */
  constructor(
    private readonly transports: Partial<Record<DeliveryDevice['kind'], PushTransport>>,
  ) {}
  async send(to: DeliveryRecipient, msg: OutboundMessage): Promise<SendOutcome> {
    if (to.devices.length === 0) return { ok: false, error: 'NO_DEVICE' };
    const content: PushContent = {
      title: 'Healthcare Hub',
      body: msg.subject,
      data: { type: 'ESCALATION', id: msg.alertId, path: msg.linkPath },
    };
    const invalid: string[] = [];
    const errors: string[] = [];
    let delivered = false;
    for (const kind of ['EXPO', 'WEB_PUSH'] as const) {
      const devices = to.devices.filter((d) => d.kind === kind);
      if (devices.length === 0) continue;
      const transport = this.transports[kind];
      if (!transport) {
        errors.push('NO_TRANSPORT');
        continue;
      }
      let results: PushDeliveryResult[];
      try {
        results = await transport.send(devices, content);
      } catch (e) {
        errors.push(errorCode(e));
        continue;
      }
      results.forEach((r, i) => {
        if (r.ok) delivered = true;
        else {
          if (r.invalidToken) invalid.push(devices[i]!.id);
          errors.push(r.error ?? 'ERROR');
        }
      });
    }
    return delivered
      ? { ok: true, invalidDeviceIds: invalid }
      : {
          ok: false,
          error: [...new Set(errors)].join(',').slice(0, 120),
          invalidDeviceIds: invalid,
        };
  }
}

/** Development / test push transport: records what would be sent; logs counts only. */
export class OutboxPushTransport implements PushTransport {
  readonly sent: { device: DeliveryDevice; content: PushContent }[] = [];
  constructor(private readonly log?: (msg: string, ctx: object) => void) {}
  async send(devices: readonly DeliveryDevice[], content: PushContent) {
    for (const device of devices) this.sent.push({ device, content });
    this.log?.('push (outbox, not sent)', { devices: devices.length });
    return devices.map(() => ({ ok: true }));
  }
}

/** Expo push service (the crew app registers Expo push tokens). */
export class ExpoPushTransport implements PushTransport {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly accessToken?: string,
    private readonly url = 'https://exp.host/--/api/v2/push/send',
  ) {}
  async send(devices: readonly DeliveryDevice[], content: PushContent) {
    if (devices.length === 0) return [];
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(
        devices.map((d) => ({
          to: d.token,
          title: content.title,
          body: content.body,
          data: content.data,
          sound: 'default',
          priority: 'high',
        })),
      ),
    });
    if (!res.ok) return devices.map(() => ({ ok: false, error: `HTTP_${res.status}` }));
    const json = (await res.json()) as {
      data?: { status: string; details?: { error?: string } }[];
    };
    return devices.map((_, i) => {
      const r = json.data?.[i];
      if (r?.status === 'ok') return { ok: true };
      const code = r?.details?.error ?? 'UnknownError';
      return { ok: false, invalidToken: code === 'DeviceNotRegistered', error: code };
    });
  }
}

export interface VapidKeys {
  /** `mailto:` or `https:` contact for the push service. */
  subject: string;
  /** Base64url uncompressed P-256 public key (65 bytes), as given to the browser. */
  publicKey: string;
  /** Base64url P-256 private scalar (32 bytes). */
  privateKey: string;
}

/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and NO payload: the browser's service worker wakes
 * and shows fixed generic text, then fetches through the signed-in API. Sending no payload means
 * nothing about the item ever reaches the browser vendor's push service, and no encryption
 * library is needed.
 */
export class WebPushTransport implements PushTransport {
  private readonly key: KeyObject;
  constructor(
    private readonly vapid: VapidKeys,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly ttlSeconds = 86_400,
  ) {
    const pub = Buffer.from(vapid.publicKey, 'base64url');
    if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not a P-256 key');
    this.key = createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: vapid.privateKey,
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
  }

  /** The VAPID JWT for one push service origin (ES256, 12 hours). */
  vapidJwt(audience: string, now = Date.now()): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
      aud: audience,
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: this.vapid.subject,
    })}`;
    const sig = signWith('sha256', Buffer.from(unsigned), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    });
    return `${unsigned}.${sig.toString('base64url')}`;
  }

  async send(devices: readonly DeliveryDevice[]) {
    const out: PushDeliveryResult[] = [];
    for (const d of devices) {
      let audience: string;
      try {
        const u = new URL(d.token);
        if (u.protocol !== 'https:') throw new Error('not https');
        audience = u.origin;
      } catch {
        out.push({ ok: false, invalidToken: true, error: 'BAD_ENDPOINT' });
        continue;
      }
      try {
        const res = await this.fetchFn(d.token, {
          method: 'POST',
          headers: {
            ttl: String(this.ttlSeconds),
            urgency: 'high',
            authorization: `vapid t=${this.vapidJwt(audience)}, k=${this.vapid.publicKey}`,
            'content-length': '0',
          },
        });
        if (res.status >= 200 && res.status < 300) out.push({ ok: true });
        else
          out.push({
            ok: false,
            invalidToken: res.status === 404 || res.status === 410,
            error: `HTTP_${res.status}`,
          });
      } catch (e) {
        out.push({ ok: false, error: errorCode(e) });
      }
    }
    return out;
  }
}

/** A short, content-free error code for the outbox row and logs. */
export function errorCode(e: unknown): string {
  const raw = e instanceof Error ? ((e as { code?: unknown }).code ?? e.name) : 'ERROR';
  return String(raw)
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 60);
}
