import { pino, type Logger } from 'pino';

/**
 * Pino with redaction. CLAUDE.md #7: no patient data or PII in logs, URLs or query strings.
 * Log IDs, not names. Request logs keep the path only (query strings are dropped).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.email',
  '*.displayName',
  '*.name',
  '*.firstName',
  '*.lastName',
  '*.dob',
  '*.dateOfBirth',
  '*.address',
  '*.phone',
  '*.postcode',
  '*.nhsNumber',
  '*.patientRef',
  '*.patient',
  '*.dbsCertificateNumber',
  '*.niNumber',
];

export function createLogger(level: string, destination?: NodeJS.WritableStream): Logger {
  return pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: {
        req: (req: { id?: string; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          path: (req.url ?? '').split('?')[0],
        }),
      },
    },
    destination,
  );
}
