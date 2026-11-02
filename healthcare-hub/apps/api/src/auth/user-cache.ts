import { Injectable } from '@nestjs/common';
import type { ResolvedUser } from '@hub/db';

const TTL_MS = 30_000; // revocation latency bound (SECURITY_COMPLIANCE §1)

/** Short-lived cache of IdP subject -> user. Evicted immediately when a user's status changes. */
@Injectable()
export class UserCache {
  private readonly map = new Map<string, { user: ResolvedUser | null; at: number }>();

  get(sub: string): { user: ResolvedUser | null } | undefined {
    const hit = this.map.get(sub);
    if (hit && Date.now() - hit.at < TTL_MS) return { user: hit.user };
    return undefined;
  }
  set(sub: string, user: ResolvedUser | null): void {
    if (this.map.size > 5_000) this.map.clear();
    this.map.set(sub, { user, at: Date.now() });
  }
  evictSubject(sub: string): void {
    this.map.delete(sub);
  }
  evictUser(userId: string): void {
    for (const [k, v] of this.map) if (v.user?.id === userId) this.map.delete(k);
  }
}
