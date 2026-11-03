import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CONFIG, type AppConfig } from '../../config.js';
import type { HubRequestContext } from '../../common/context.js';
import { Hub } from '../../common/context.js';
import { OrgMember } from '../../common/decorators.js';
import { LiveChanges } from './live.service.js';

const HEARTBEAT_MS = 25_000;
/** Bursts become one signal; screens refetch everything they show on each signal anyway. */
const COALESCE_MS = 300;

@Controller('live')
export class LiveController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LiveChanges) private readonly live: LiveChanges,
  ) {}

  /**
   * Server-sent events: `ready` once listening, then `change` when this organisation's data
   * changed. The stream says only that something changed; screens refetch through the normal
   * endpoints, so what anyone sees is still decided there. It ends after a short life, so a
   * reconnect has to pass the access checks again and a revoked person drops off.
   */
  @OrgMember()
  @Get('changes')
  async changes(@Hub() hub: HubRequestContext, @Res() reply: FastifyReply): Promise<void> {
    const pending: { timer: NodeJS.Timeout | null } = { timer: null };
    let cleanup = () => {};
    const send = (event: string) => reply.raw.write(`event: ${event}\ndata: {}\n\n`);
    const unsubscribe = await this.live.subscribe(hub.orgId as string, (signal) => {
      if (signal === 'shutdown') return cleanup();
      pending.timer ??= setTimeout(() => {
        pending.timer = null;
        send('change');
      }, COALESCE_MS);
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    send('ready');

    const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), HEARTBEAT_MS);
    const lifetime = setTimeout(() => cleanup(), this.config.LIVE_STREAM_MAX_SECONDS * 1000);
    let closed = false;
    cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      if (pending.timer) clearTimeout(pending.timer);
      reply.raw.end();
    };
    reply.raw.on('close', cleanup);
  }
}
