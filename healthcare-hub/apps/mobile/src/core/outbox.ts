import type { SyncItemResult, SyncItemType } from '@hub/contracts';
import { OUTBOX_MAX_ATTEMPTS, syncBackoffMs } from '@hub/rules';
import type { Clock, LocalStore } from './ports';

/**
 * Offline outbox (MOBILE_APP "Offline & sync"): every submission is stored on the device first
 * with a client submission id, then replayed until the server has it. The server is idempotent on
 * that id, so a repeated send creates exactly one record (UAT-06). Nothing is silently dropped:
 * conflicts and rejections stay on the device until the person has seen them.
 */
export type OutboxState = 'PENDING' | 'CONFLICT' | 'REJECTED';

/** Where an uploaded photo's evidence id goes in the payload. */
export type FileTarget =
  | { kind: 'append'; key: string }
  | { kind: 'set'; key: string }
  | { kind: 'vdiItem'; code: string };

export interface PendingFile {
  uri: string;
  mime: 'image/jpeg' | 'image/png';
  sizeBytes: number;
  title: string;
  target: FileTarget;
  /** Set once the upload has been requested / completed, so a retry never uploads twice. */
  evidenceVersionId?: string;
  evidenceItemId?: string;
}

export interface OutboxItem {
  clientSubmissionId: string;
  type: SyncItemType;
  ref?: string;
  payload: Record<string, unknown>;
  /** Short description shown on the pending-sync list ("VDI – AMB-01"). No patient detail. */
  label: string;
  capturedAt: string;
  attempts: number;
  nextAttemptAt: string;
  state: OutboxState;
  files: PendingFile[];
  error: { code: string | null; detail: string | null } | null;
  serverState: Record<string, unknown> | null;
}

export interface EnqueueInput {
  type: SyncItemType;
  ref?: string;
  payload: Record<string, unknown>;
  label: string;
  files?: PendingFile[];
  capturedAt?: Date;
}

export class Outbox {
  private listeners = new Set<() => void>();
  constructor(
    private readonly store: LocalStore,
    private readonly newId: () => string,
    private readonly clock: Clock,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    for (const fn of this.listeners) fn();
  }

  async enqueue(i: EnqueueInput): Promise<OutboxItem> {
    const now = this.clock();
    const item: OutboxItem = {
      clientSubmissionId: this.newId(),
      type: i.type,
      ...(i.ref ? { ref: i.ref } : {}),
      payload: i.payload,
      label: i.label,
      capturedAt: (i.capturedAt ?? now).toISOString(),
      attempts: 0,
      nextAttemptAt: now.toISOString(),
      state: 'PENDING',
      files: i.files ?? [],
      error: null,
      serverState: null,
    };
    await this.store.putOutbox(item);
    this.changed();
    return item;
  }

  /** Oldest first: the server applies them in the order they happened. */
  async list(): Promise<OutboxItem[]> {
    const all = await this.store.listOutbox();
    return all.sort(
      (a, b) =>
        a.capturedAt.localeCompare(b.capturedAt) ||
        a.clientSubmissionId.localeCompare(b.clientSubmissionId),
    );
  }

  async due(now: Date = this.clock()): Promise<OutboxItem[]> {
    return (await this.list()).filter(
      (i) => i.state === 'PENDING' && new Date(i.nextAttemptAt).getTime() <= now.getTime(),
    );
  }

  async pendingCount(): Promise<number> {
    return (await this.list()).filter((i) => i.state === 'PENDING').length;
  }

  async save(item: OutboxItem): Promise<void> {
    await this.store.putOutbox(item);
  }

  async applyResult(item: OutboxItem, r: SyncItemResult): Promise<void> {
    switch (r.outcome) {
      case 'ACCEPTED':
      case 'DUPLICATE':
        await this.store.deleteOutbox(item.clientSubmissionId);
        break;
      case 'CONFLICT':
      case 'REJECTED':
        await this.store.putOutbox({
          ...item,
          state: r.outcome,
          error: { code: r.code, detail: r.detail },
          serverState: r.serverState,
        });
        break;
      case 'RETRY':
        await this.retryLater(item, { code: r.code, detail: r.detail });
        return;
    }
    this.changed();
  }

  /** Temporary failure: back off (15 s doubling, max 15 min); give up for review after 12 tries. */
  async retryLater(
    item: OutboxItem,
    error: { code: string | null; detail: string | null } | null,
  ): Promise<void> {
    const attempts = item.attempts + 1;
    const now = this.clock();
    if (attempts >= OUTBOX_MAX_ATTEMPTS)
      await this.store.putOutbox({
        ...item,
        attempts,
        state: 'REJECTED',
        error: {
          code: error?.code ?? 'NOT_SENT',
          detail: 'Could not be sent after several tries. Check with control.',
        },
      });
    else
      await this.store.putOutbox({
        ...item,
        attempts,
        error,
        nextAttemptAt: new Date(now.getTime() + syncBackoffMs(item.attempts)).toISOString(),
      });
    this.changed();
  }

  /** The person has reconciled a conflict or rejection (seen the server state, called control). */
  async dismiss(clientSubmissionId: string): Promise<void> {
    await this.store.deleteOutbox(clientSubmissionId);
    this.changed();
  }

  /** "Try again now" after a manual fix (e.g. connectivity restored, details corrected). */
  async retryNow(clientSubmissionId: string): Promise<void> {
    const item = (await this.list()).find((i) => i.clientSubmissionId === clientSubmissionId);
    if (!item) return;
    await this.store.putOutbox({
      ...item,
      state: 'PENDING',
      attempts: 0,
      nextAttemptAt: this.clock().toISOString(),
    });
    this.changed();
  }
}

/** The payload with uploaded photo evidence ids put where the server expects them. */
export function withFileIds(
  payload: Record<string, unknown>,
  files: readonly PendingFile[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const f of files) {
    if (!f.evidenceItemId) continue;
    const t = f.target;
    if (t.kind === 'set') out[t.key] = f.evidenceItemId;
    else if (t.kind === 'append') {
      const prev = Array.isArray(out[t.key]) ? (out[t.key] as unknown[]) : [];
      out[t.key] = [...prev, f.evidenceItemId];
    } else {
      const results = Array.isArray(out.results) ? (out.results as Record<string, unknown>[]) : [];
      out.results = results.map((r) =>
        r.code === t.code ? { ...r, photoEvidenceItemId: f.evidenceItemId } : r,
      );
    }
  }
  return out;
}
