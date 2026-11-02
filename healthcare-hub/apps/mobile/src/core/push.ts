import { UUID_RE } from './ids';

/**
 * Push notifications carry only a type and an opaque id with generic text (non-negotiable 7). A tap
 * opens the right screen, which then fetches the details after sign-in and unlock.
 */
export type PushRoute =
  { screen: 'job'; id: string } | { screen: 'policies' } | { screen: 'shift' };

export function routeForPush(data: unknown): PushRoute | null {
  if (!data || typeof data !== 'object') return null;
  const { type, id } = data as { type?: unknown; id?: unknown };
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  switch (type) {
    case 'JOB_OFFERED':
    case 'JOB_CHANGED':
      return { screen: 'job', id };
    case 'POLICY_ACK':
      return { screen: 'policies' };
    case 'SHIFT_CHANGED':
      return { screen: 'shift' };
    default:
      return null;
  }
}
