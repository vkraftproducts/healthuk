import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import type { Logger } from 'pino';
import { CONFIG, type AppConfig } from '../../config.js';
import { LOGGER } from '../../logger.provider.js';

const CHANNEL = 'hub_changes';
const RECONNECT_MS = 2_000;

export type LiveSignal = 'change' | 'shutdown';
type Listener = (signal: LiveSignal) => void;

/**
 * One Postgres LISTEN connection per API instance, shared by every open stream. It carries only
 * organisation ids (0013_live_changes.sql) and is used for nothing else, so it never sees tenant
 * data and does not need a tenant context.
 */
@Injectable()
export class LiveChanges implements OnModuleDestroy {
  private readonly listeners = new Map<string, Set<Listener>>();
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /** Resolves once listening, so a change made after this returns is never missed. */
  async subscribe(orgId: string, listener: Listener): Promise<() => void> {
    await this.ensureConnected();
    const set = this.listeners.get(orgId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(orgId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(orgId) === set) this.listeners.delete(orgId);
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.broadcast('shutdown');
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  private ensureConnected(): Promise<void> {
    if (this.client) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.config.DATABASE_URL });
    const lost = () => {
      if (this.client !== client) return;
      this.client = null;
      if (!this.stopped) this.scheduleReconnect();
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', (m) => {
      if (m.channel === CHANNEL && m.payload) this.notify(m.payload);
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.client = client;
  }

  private scheduleReconnect(): void {
    this.retry = setTimeout(() => {
      this.ensureConnected()
        // Anything could have changed while disconnected: have every screen refetch.
        .then(() => this.broadcast('change'))
        .catch((e: unknown) => {
          this.log.warn({ error: (e as Error).message }, 'live changes reconnect failed');
          if (!this.stopped) this.scheduleReconnect();
        });
    }, RECONNECT_MS);
  }

  private notify(orgId: string): void {
    this.listeners.get(orgId)?.forEach((l) => l('change'));
  }

  private broadcast(signal: LiveSignal): void {
    for (const set of this.listeners.values()) set.forEach((l) => l(signal));
  }
}
