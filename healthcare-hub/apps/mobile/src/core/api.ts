/**
 * Thin API client. Every call carries the bearer token, the organisation and this device's id; the
 * server decides everything (non-negotiable 1). A revoked device or user is reported once so the
 * app can wipe itself on next contact (MOBILE_APP "Cache TTL").
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string | null,
    readonly checks: { code: string; result: string; reasonText: string }[] | null,
  ) {
    super(detail ?? code);
    this.name = 'ApiError';
  }
  /** Worth trying again later (server busy, timeout), rather than a decision. */
  get transient(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** No answer from the server (offline, DNS, timeout). */
export class NetworkError extends Error {
  constructor(message = 'No connection') {
    super(message);
    this.name = 'NetworkError';
  }
}

export type RevokedCode = 'DEVICE_REVOKED' | 'USER_INACTIVE';

export interface ApiOptions {
  baseUrl: string;
  fetch: typeof fetch;
  getToken: () => Promise<string | null>;
  getOrgId: () => string | null;
  getDeviceId: () => Promise<string>;
  onRevoked: (code: RevokedCode) => void;
  onSignedOut?: () => void;
  timeoutMs?: number;
}

export class Api {
  constructor(private readonly o: ApiOptions) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }
  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.o.getToken();
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-device-id': await this.o.getDeviceId(),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const org = this.o.getOrgId();
    if (org) headers['x-org-id'] = org;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.send(`${this.o.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (res.ok) return json as T;
    const p = (json ?? {}) as { code?: string; detail?: string; checks?: ApiError['checks'] };
    const code = typeof p.code === 'string' ? p.code : `HTTP_${res.status}`;
    if (res.status === 401) {
      if (code === 'DEVICE_REVOKED' || code === 'USER_INACTIVE') this.o.onRevoked(code);
      else this.o.onSignedOut?.();
    }
    throw new ApiError(res.status, code, p.detail ?? null, p.checks ?? null);
  }

  /** Uploads bytes to a signed, short-lived upload link (no auth header: the link is the grant). */
  async putBytes(url: string, body: Blob, mime: string): Promise<void> {
    const res = await this.send(url, { method: 'PUT', headers: { 'content-type': mime }, body });
    if (!res.ok) {
      const p = (safeJson(await res.text()) ?? {}) as { code?: string; detail?: string };
      throw new ApiError(res.status, p.code ?? `HTTP_${res.status}`, p.detail ?? null, null);
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 20_000);
    try {
      return await this.o.fetch(url, { ...init, signal: ctrl.signal });
    } catch {
      throw new NetworkError();
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
