import type { SyncItemResult, SyncResultDto } from '@hub/contracts';
import { ApiError, NetworkError, type Api } from './api';
import { withFileIds, type Outbox, type OutboxItem, type PendingFile } from './outbox';
import type { Clock, FileStore, LocalStore } from './ports';

export interface SyncReport {
  attempted: number;
  accepted: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  retrying: number;
  /** False when the server could not be reached at all. */
  reachedServer: boolean;
}

const BATCH = 50;
const LAST_SYNC_KEY = 'meta:lastSyncedAt';

/**
 * Sends due outbox items to POST /crew/sync. Runs on connectivity regained, app foreground and
 * every 60 seconds while online (see useSyncLoop). Single-flight: overlapping triggers share one run.
 */
export class SyncEngine {
  private current: Promise<SyncReport> | null = null;

  constructor(
    private readonly d: {
      api: Api;
      outbox: Outbox;
      files: FileStore;
      store: LocalStore;
      clock: Clock;
      isOnline: () => boolean;
    },
  ) {}

  run(): Promise<SyncReport> {
    if (!this.current)
      this.current = this.doRun().finally(() => {
        this.current = null;
      });
    return this.current;
  }

  async lastSyncedAt(): Promise<Date | null> {
    const c = await this.d.store.getCache(LAST_SYNC_KEY);
    return c ? new Date(c.value) : null;
  }

  private async doRun(): Promise<SyncReport> {
    const report: SyncReport = {
      attempted: 0,
      accepted: 0,
      duplicates: 0,
      conflicts: 0,
      rejected: 0,
      retrying: 0,
      reachedServer: false,
    };
    if (!this.d.isOnline()) return report;
    const due = await this.d.outbox.due();
    const ready: OutboxItem[] = [];
    for (const item of due) {
      const up = await this.uploadFiles(item, report);
      if (up === 'STOP') return report;
      if (up) ready.push(up);
    }
    for (let i = 0; i < ready.length; i += BATCH) {
      const ok = await this.sendBatch(ready.slice(i, i + BATCH), report);
      if (!ok) break;
    }
    if (report.reachedServer || due.length === 0) {
      const now = this.d.clock();
      await this.d.store.setCache(
        LAST_SYNC_KEY,
        now.toISOString(),
        new Date(now.getTime() + 365 * 86_400_000).toISOString(),
      );
    }
    return report;
  }

  /** Returns the item ready to send, null to skip this round, or 'STOP' when offline/revoked. */
  private async uploadFiles(
    item: OutboxItem,
    report: SyncReport,
  ): Promise<OutboxItem | null | 'STOP'> {
    let current = item;
    const put = async (i: number, f: PendingFile) => {
      current = { ...current, files: current.files.map((x, j) => (j === i ? f : x)) };
      await this.d.outbox.save(current);
    };
    try {
      for (let i = 0; i < current.files.length; i += 1) {
        let f = current.files[i]!;
        if (f.evidenceItemId && !f.evidenceVersionId) continue; // already uploaded
        if (!f.evidenceVersionId) {
          // Request a signed upload link and send the bytes; remember the version so a retry
          // only has to complete it rather than upload again.
          const t = await this.d.api.post<{
            evidenceItemId: string;
            evidenceVersionId: string;
            uploadUrl: string;
          }>('/api/v1/evidence/uploads', { title: f.title, mime: f.mime, sizeBytes: f.sizeBytes });
          await this.d.api.putBytes(t.uploadUrl, await this.d.files.read(f.uri), f.mime);
          f = { ...f, evidenceItemId: t.evidenceItemId, evidenceVersionId: t.evidenceVersionId };
          await put(i, f);
        }
        await this.d.api.post(`/api/v1/evidence/${f.evidenceVersionId}/complete`);
        const completed: PendingFile = { ...f };
        delete completed.evidenceVersionId;
        await put(i, completed);
        await this.d.files.remove(f.uri);
      }
    } catch (e) {
      if (e instanceof NetworkError) {
        await this.d.outbox.retryLater(current, { code: 'OFFLINE', detail: null });
        report.retrying += 1;
        return 'STOP';
      }
      if (e instanceof ApiError && e.status === 401) return 'STOP';
      if (e instanceof ApiError && !e.transient) {
        await this.d.outbox.applyResult(current, result(current, 'REJECTED', e));
        report.rejected += 1;
        return null;
      }
      await this.d.outbox.retryLater(current, {
        code: e instanceof ApiError ? e.code : 'UPLOAD_FAILED',
        detail: null,
      });
      report.retrying += 1;
      return null;
    }
    return current;
  }

  private async sendBatch(batch: OutboxItem[], report: SyncReport): Promise<boolean> {
    report.attempted += batch.length;
    let res: SyncResultDto;
    try {
      res = await this.d.api.post<SyncResultDto>('/api/v1/crew/sync', {
        items: batch.map((i) => ({
          clientSubmissionId: i.clientSubmissionId,
          type: i.type,
          ...(i.ref ? { ref: i.ref } : {}),
          payload: withFileIds(i.payload, i.files),
        })),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return false; // revoked or signed out
      if (e instanceof ApiError && e.status === 400 && batch.length > 1) {
        // One malformed item must not hold the rest back: send them one by one.
        report.attempted -= batch.length;
        for (const one of batch) await this.sendBatch([one], report);
        return true;
      }
      if (e instanceof ApiError && !e.transient) {
        report.reachedServer = true;
        for (const i of batch) await this.d.outbox.applyResult(i, result(i, 'REJECTED', e));
        report.rejected += batch.length;
        return true;
      }
      for (const i of batch)
        await this.d.outbox.retryLater(i, {
          code: e instanceof ApiError ? e.code : 'OFFLINE',
          detail: null,
        });
      report.retrying += batch.length;
      return false;
    }
    report.reachedServer = true;
    for (const r of res.results) {
      const item = batch.find((i) => i.clientSubmissionId === r.clientSubmissionId);
      if (!item) continue;
      await this.d.outbox.applyResult(item, r);
      if (r.outcome === 'ACCEPTED') report.accepted += 1;
      else if (r.outcome === 'DUPLICATE') report.duplicates += 1;
      else if (r.outcome === 'CONFLICT') report.conflicts += 1;
      else if (r.outcome === 'REJECTED') report.rejected += 1;
      else report.retrying += 1;
    }
    return true;
  }
}

function result(i: OutboxItem, outcome: SyncItemResult['outcome'], e: ApiError): SyncItemResult {
  return {
    clientSubmissionId: i.clientSubmissionId,
    type: i.type,
    outcome,
    status: e.status,
    code: e.code,
    detail: e.detail,
    entityId: null,
    serverState: null,
  };
}
