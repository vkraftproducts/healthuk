import type { Mailer } from '@hub/domain';

/**
 * Development mailer: logs the recipient id domain only, never content. The Azure Communication
 * Services mailer replaces this in deployed environments (M8 hardening).
 */
export function logMailer(log: (msg: string, ctx: object) => void): Mailer {
  return {
    send: async (m) => {
      log('email (dev, not sent)', { toDomain: m.to.split('@')[1] ?? 'unknown' });
    },
  };
}
