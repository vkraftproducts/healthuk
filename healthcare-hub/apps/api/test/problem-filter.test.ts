import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from 'pino';
import { ProblemFilter } from '../src/common/problem.filter.js';

function run(exception: unknown) {
  const reply = { status: vi.fn(), header: vi.fn(), send: vi.fn() };
  reply.status.mockReturnValue(reply);
  reply.header.mockReturnValue(reply);
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ id: 'req-1', method: 'GET', url: '/api/v1/me?x=1' }),
    }),
  } as unknown as ArgumentsHost;
  const log = { error: vi.fn() };
  new ProblemFilter(log as unknown as Logger).catch(exception, host);
  return { reply, log };
}

describe('ProblemFilter', () => {
  it('reports the rate limiter as 429 RATE_LIMITED, not an internal error', () => {
    const { reply, log } = run({ status: 429, code: 'RATE_LIMITED', title: 'Too many requests' });
    expect(reply.status).toHaveBeenCalledWith(429);
    expect(reply.send.mock.calls[0]![0]).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps unknown objects as 500 and logs only their type', () => {
    const { reply, log } = run({ secret: 'x' });
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(log.error.mock.calls[0]![0]).toEqual({ err: 'Object', reqId: 'req-1' });
  });
});
