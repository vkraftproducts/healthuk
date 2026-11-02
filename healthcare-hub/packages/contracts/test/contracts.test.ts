import { describe, expect, it } from 'vitest';
import { MeResponse, PageQuery, Problem, buildOpenApi, isoDate } from '../src/index.js';

describe('contracts', () => {
  it('caps page size at 100', () => {
    expect(PageQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(PageQuery.parse({}).limit).toBe(25);
  });
  it('accepts only date-only strings for date fields', () => {
    expect(isoDate.safeParse('2026-11-12').success).toBe(true);
    expect(isoDate.safeParse('2026-11-12T00:00:00Z').success).toBe(false);
  });
  it('requires problem+json fields', () => {
    expect(
      Problem.safeParse({ type: 't', title: 'x', status: 404, code: 'NOT_FOUND' }).success,
    ).toBe(true);
    expect(
      Problem.safeParse({ type: 't', title: 'x', status: 200, code: 'NOT_FOUND' }).success,
    ).toBe(false);
  });
  it('generates OpenAPI for every registered route', () => {
    const doc = buildOpenApi();
    const paths = Object.keys(doc.paths);
    expect(paths.slice(0, 3)).toEqual(['/healthz', '/readyz', '/api/v1/me']);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/audit-log',
        '/api/v1/audit-log/verify-chain',
        '/api/v1/admin/users',
        '/api/v1/admin/roles',
      ]),
    );
    expect(paths.every((p) => !p.includes(':'))).toBe(true); // OpenAPI {param} style
    expect(MeResponse.shape.permissions).toBeDefined();
  });
});
