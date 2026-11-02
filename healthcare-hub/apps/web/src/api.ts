import { MeResponse, Problem } from '@hub/contracts';
import type { AuthClient } from './auth.js';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** Server-written explanation (problem+json `detail`); never contains personal data. */
    public readonly detail: string | null = null,
  ) {
    super(`API ${status} ${code}`);
  }
}

export interface ApiClient {
  me(orgId: string | null): Promise<MeResponse>;
  readyz(): Promise<{ status: string }>;
  /** Generic authenticated calls for the admin screens (responses are validated by the caller). */
  get(path: string, orgId: string | null): Promise<unknown>;
  send(
    method: 'POST' | 'PATCH',
    path: string,
    orgId: string | null,
    body: unknown,
    version?: number,
  ): Promise<unknown>;
  /** Authenticated file download (CSV exports, evidence packs). */
  download?(path: string, orgId: string | null): Promise<Blob>;
}

export function createApiClient(auth: AuthClient, baseUrl = ''): ApiClient {
  async function request(
    path: string,
    orgId: string | null,
    authenticated = true,
    init: { method?: string; body?: unknown; version?: number } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (authenticated) headers.authorization = `Bearer ${await auth.getToken()}`;
    if (orgId) headers['x-org-id'] = orgId;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.version !== undefined) headers['if-match'] = `"${init.version}"`;
    const res = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) {
      const parsed = Problem.safeParse(await res.json().catch(() => null));
      throw new ApiError(
        res.status,
        parsed.success ? parsed.data.code : 'INTERNAL',
        parsed.success ? (parsed.data.detail ?? null) : null,
      );
    }
    return res.json();
  }
  return {
    me: async (orgId) => MeResponse.parse(await request('/api/v1/me', orgId)),
    readyz: async () => (await request('/readyz', null, false)) as { status: string },
    get: (path, orgId) => request(path, orgId),
    send: (method, path, orgId, body, version) =>
      request(path, orgId, true, { method, body, version }),
    async download(path, orgId) {
      const headers: Record<string, string> = { authorization: `Bearer ${await auth.getToken()}` };
      if (orgId) headers['x-org-id'] = orgId;
      const res = await fetch(`${baseUrl}${path}`, { headers });
      if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED');
      return res.blob();
    },
  };
}
