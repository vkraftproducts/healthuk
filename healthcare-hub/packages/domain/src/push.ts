import { SYSTEM_USER_ID, type Db, type TenantTx } from '@hub/db';
import { pushPayload, syncBackoffMs, type PushKind } from '@hub/rules';

/**
 * Push notifications to the crew app (APP-02). Messages are queued in the same transaction as the
 * change that caused them and sent by the worker. Payloads are generic: type + opaque id only.
 */
export interface PushTarget {
  token: string;
  platform: 'IOS' | 'ANDROID';
}
export interface PushResult {
  ok: boolean;
  /** The push service says this token is no longer valid: the device registration is revoked. */
  invalidToken?: boolean;
  error?: string;
}
export interface PushSender {
  send(targets: PushTarget[], payload: ReturnType<typeof pushPayload>): Promise<PushResult[]>;
}

/** Development / test sender: records what would be sent (never the patient — there is none). */
export class MemoryPushSender implements PushSender {
  readonly sent: { target: PushTarget; payload: ReturnType<typeof pushPayload> }[] = [];
  async send(targets: PushTarget[], payload: ReturnType<typeof pushPayload>) {
    for (const target of targets) this.sent.push({ target, payload });
    return targets.map(() => ({ ok: true }));
  }
}

/** Expo push service adapter (EAS builds register Expo push tokens). */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly url = 'https://exp.host/--/api/v2/push/send',
    private readonly accessToken?: string,
  ) {}
  async send(targets: PushTarget[], payload: ReturnType<typeof pushPayload>) {
    if (targets.length === 0) return [];
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(
        targets.map((t) => ({
          to: t.token,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          sound: 'default',
          priority: 'high',
        })),
      ),
    });
    if (!res.ok) return targets.map(() => ({ ok: false, error: `HTTP ${res.status}` }));
    const json = (await res.json()) as {
      data?: { status: string; details?: { error?: string }; message?: string }[];
    };
    return targets.map((_, i) => {
      const r = json.data?.[i];
      if (r?.status === 'ok') return { ok: true };
      const code = r?.details?.error ?? 'UnknownError';
      return { ok: false, invalidToken: code === 'DeviceNotRegistered', error: code };
    });
  }
}

/** Queues one message per user; the dedupe key makes re-queuing the same event harmless. */
export async function queuePush(
  tx: TenantTx,
  m: { orgId: string; userIds: readonly string[]; kind: PushKind; refId: string; event: string },
): Promise<number> {
  const users = [...new Set(m.userIds)];
  if (users.length === 0) return 0;
  const r = await tx.pushMessage.createMany({
    data: users.map((userId) => ({
      organisationId: m.orgId,
      userId,
      kind: m.kind,
      refId: m.refId,
      dedupeKey: `${m.kind}:${m.refId}:${m.event}:${userId}`,
    })),
    skipDuplicates: true,
  });
  return r.count;
}

/** Users actively crewing a shift (those with app accounts). */
export async function shiftCrewUserIds(tx: TenantTx, shiftId: string): Promise<string[]> {
  const crew = await tx.crewAssignment.findMany({
    where: { shiftId, active: true },
    select: { staffId: true },
  });
  const staff = await tx.staff.findMany({
    where: { id: { in: crew.map((c) => c.staffId) }, userId: { not: null } },
    select: { userId: true },
  });
  return staff.map((s) => s.userId as string);
}

const MAX_ATTEMPTS = 8;

/** Sends due messages for one organisation. Users with no live device are marked sent (nothing to do). */
export async function sendPendingPush(
  tx: TenantTx,
  now: Date,
  sender: PushSender,
): Promise<{ sent: number; failed: number; dead: number }> {
  const out = { sent: 0, failed: 0, dead: 0 };
  // New messages are stamped by the database (column default), so due-ness uses its clock too.
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const due = await tx.pushMessage.findMany({
    where: { sentAt: null, dead: false, nextAttemptAt: { lte: clock!.now } },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  for (const m of due) {
    const devices = await tx.deviceSession.findMany({
      where: { userId: m.userId, revokedAt: null, pushToken: { not: null } },
    });
    const targets = devices.map((d) => ({ token: d.pushToken as string, platform: d.platform }));
    const results = await sender.send(targets, pushPayload(m.kind as PushKind, m.refId));
    for (const [i, r] of results.entries())
      if (r.invalidToken)
        await tx.deviceSession.update({ where: { id: devices[i]!.id }, data: { pushToken: null } });
    if (targets.length === 0 || results.some((r) => r.ok)) {
      await tx.pushMessage.update({ where: { id: m.id }, data: { sentAt: now } });
      out.sent += 1;
      continue;
    }
    const attempts = m.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await tx.pushMessage.update({
      where: { id: m.id },
      data: {
        attempts,
        dead,
        nextAttemptAt: new Date(now.getTime() + syncBackoffMs(attempts)),
        // Error codes from the push service only: never payload content.
        lastError: results
          .map((r) => r.error ?? 'error')
          .join(',')
          .slice(0, 200),
      },
    });
    if (dead) out.dead += 1;
    else out.failed += 1;
  }
  return out;
}

export async function pushAll(
  db: Db,
  now: Date,
  sender: PushSender,
  log?: (msg: string, ctx: object) => void,
): Promise<{ sent: number; failed: number; dead: number }> {
  const out = { sent: 0, failed: 0, dead: 0 };
  for (const orgId of await db.listOrganisations()) {
    try {
      const r = await db.withTenant({ orgId, userId: SYSTEM_USER_ID }, (tx) =>
        sendPendingPush(tx, now, sender),
      );
      out.sent += r.sent;
      out.failed += r.failed;
      out.dead += r.dead;
    } catch (e) {
      log?.('push failed', { orgId, error: e instanceof Error ? e.message : 'unknown' });
    }
  }
  return out;
}
