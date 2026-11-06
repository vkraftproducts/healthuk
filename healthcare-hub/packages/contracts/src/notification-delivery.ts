import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';

/**
 * Email and push delivery of escalations. A person registers their own push devices and sets their
 * own email and push switches; the organisation's channel settings still apply on top.
 */

const ExpoToken = z
  .string()
  .trim()
  .regex(
    /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/,
    'Expected an Expo push token',
  );

export const PushDeviceRegisterInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('EXPO'), token: ExpoToken }),
  z.strictObject({
    kind: z.literal('WEB_PUSH'),
    /** The PushSubscription endpoint. Never put personal data in it; the browser chooses it. */
    endpoint: z.string().trim().url().max(1000).startsWith('https://'),
    keys: z
      .strictObject({
        p256dh: z.string().trim().min(10).max(200),
        auth: z.string().trim().min(8).max(100),
      })
      .optional(),
  }),
]);
export type PushDeviceRegisterInput = z.infer<typeof PushDeviceRegisterInput>;

/** The token or endpoint is never returned. */
export const PushDeviceDto = z.object({
  id: uuid,
  kind: z.enum(['EXPO', 'WEB_PUSH']),
  createdAt: isoDateTime,
  lastRegisteredAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
});
export type PushDeviceDto = z.infer<typeof PushDeviceDto>;

export const NotificationPreferencesInput = z
  .strictObject({ email: z.boolean(), push: z.boolean() })
  .partial()
  .refine((v) => v.email !== undefined || v.push !== undefined, 'Send email, push or both');
export type NotificationPreferencesInput = z.infer<typeof NotificationPreferencesInput>;

export const NotificationPreferencesDto = z.object({
  email: z.boolean(),
  push: z.boolean(),
  /** The organisation's channel switches (Settings); when off, nobody gets that channel. */
  organisation: z.object({ email: z.boolean(), push: z.boolean() }),
});
export type NotificationPreferencesDto = z.infer<typeof NotificationPreferencesDto>;

/** Most live push registrations per person per organisation; the oldest is revoked beyond it. */
export const MAX_PUSH_DEVICES = 10;
