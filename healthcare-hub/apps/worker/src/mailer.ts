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

interface SmtpTransport {
  sendMail(m: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * SMTP mailer (EMAIL_TRANSPORT=smtp) through nodemailer, loaded only when SMTP is configured so
 * development and tests never need it. Plain text only; errors surface as codes, never content.
 */
export function smtpMailer(smtpUrl: string, from: string): Mailer {
  let transport: Promise<SmtpTransport> | null = null;
  const load = async (): Promise<SmtpTransport> => {
    const spec = 'nodemailer';
    const mod = (await import(spec)) as {
      default?: { createTransport(url: string): SmtpTransport };
      createTransport?: (url: string) => SmtpTransport;
    };
    const create = mod.default?.createTransport ?? mod.createTransport;
    if (!create) throw new Error('nodemailer is not installed');
    return create(smtpUrl);
  };
  return {
    send: async (m) => {
      transport ??= load().catch((e: unknown) => {
        transport = null;
        throw e;
      });
      await (await transport).sendMail({ from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
