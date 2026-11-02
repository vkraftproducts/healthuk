import { buildOpenApi } from '@hub/contracts';
import { describe, expect, it } from 'vitest';
import { discoverRoutes } from './route-discovery.js';

describe('OpenAPI registry', () => {
  it('documents every controller route (and nothing else)', () => {
    const doc = buildOpenApi();
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(doc.paths))
      for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${path}`);
    const implemented = new Set(
      discoverRoutes()
        .filter((r) => r.openApiPath !== '/api/v1/openapi.json')
        .map((r) => `${r.method} ${r.openApiPath}`),
    );
    expect([...implemented].filter((x) => !documented.has(x)).sort()).toEqual([]);
    expect([...documented].filter((x) => !implemented.has(x)).sort()).toEqual([]);
  });
});
