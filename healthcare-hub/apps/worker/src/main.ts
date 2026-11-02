import { PgBoss } from 'pg-boss';
import pino from 'pino';
import { createDb } from '@hub/db';
import {
  breachClockAlerts,
  ExpoPushSender,
  LocalBlobStore,
  MemoryPushSender,
  pushAll,
  jobTimingAll,
  notifyAll,
  reconcileAll,
  runRetention,
  runPendingExports,
  snapshotAll,
  verifyAuditChains,
} from '@hub/domain';
import { loadConfig } from './config.js';
import { logMailer } from './mailer.js';

const LONDON = 'Europe/London';
const QUEUES = [
  'reconcile-statuses',
  'send-notifications',
  'status-snapshot',
  'audit-verify',
  'generate-exports',
  'job-timing',
  'send-push',
  'retention',
  'breach-clock',
] as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const log = (msg: string, ctx: object): void => logger.warn(ctx, msg);
  const db = createDb(config.DATABASE_URL);
  const boss = new PgBoss(config.QUEUE_DATABASE_URL);
  boss.on('error', (e: Error) => logger.error({ error: e.message }, 'queue error'));
  await boss.start();
  for (const q of QUEUES) await boss.createQueue(q);

  // Every handler is idempotent: a retry or a duplicate run changes nothing.
  await boss.work('reconcile-statuses', async () => {
    const r = await reconcileAll(db, new Date(), log);
    logger.info(r, 'reconciled');
  });
  await boss.work('send-notifications', async () => {
    const r = await notifyAll(db, new Date(), logMailer(log), config.WEB_ORIGIN, log);
    logger.info(r, 'notifications');
  });
  await boss.work('status-snapshot', async () => {
    logger.info({ rows: await snapshotAll(db, new Date()) }, 'snapshot');
  });
  await boss.work('audit-verify', async () => {
    const r = await verifyAuditChains(db);
    if (r.broken.length > 0) logger.error({ broken: r.broken }, 'AUDIT CHAIN BROKEN');
    else logger.info({ checked: r.checked }, 'audit chains intact');
  });

  const store = new LocalBlobStore(config.EVIDENCE_DIR);
  await boss.work('generate-exports', async () => {
    const n = await runPendingExports(db, store);
    if (n > 0) logger.info({ exports: n }, 'exports generated');
  });

  await boss.work('job-timing', async () => {
    const r = await jobTimingAll(db, new Date(), log);
    if (r.raised > 0 || r.failed > 0) logger.info(r, 'job timing alerts');
  });

  const push =
    config.PUSH_PROVIDER === 'expo'
      ? new ExpoPushSender(fetch, undefined, config.EXPO_ACCESS_TOKEN)
      : new MemoryPushSender();
  await boss.work('send-push', async () => {
    const r = await pushAll(db, new Date(), push, log);
    if (r.sent > 0 || r.failed > 0 || r.dead > 0) logger.info(r, 'push');
  });

  // Retention acts only on approved rules: anonymises patient contacts, lists the rest for review.
  await boss.work('retention', async () => {
    logger.info(await runRetention(db, new Date()), 'retention');
  });
  // The 72-hour ICO clock for personal data breaches reaches the privacy lead in time.
  await boss.work('breach-clock', async () => {
    const n = await breachClockAlerts(db, new Date());
    if (n > 0) logger.info({ changed: n }, 'breach clock alerts');
  });

  // 15-minute incremental reconcile; the 02:00 Europe/London run also snapshots and verifies.
  await boss.schedule('reconcile-statuses', '*/15 * * * *', undefined, { tz: LONDON });
  await boss.schedule('send-notifications', '*/5 * * * *', undefined, { tz: LONDON });
  await boss.schedule('status-snapshot', '5 2 * * *', undefined, { tz: LONDON });
  await boss.schedule('audit-verify', '30 2 * * *', undefined, { tz: LONDON });
  await boss.schedule('generate-exports', '* * * * *', undefined, { tz: LONDON });
  // Unacknowledged offers and late jobs reach control within a few minutes (JOB-04).
  await boss.schedule('job-timing', '*/2 * * * *', undefined, { tz: LONDON });
  // Generic crew pushes (type + id only) go out within a minute.
  await boss.schedule('send-push', '* * * * *', undefined, { tz: LONDON });
  await boss.schedule('retention', '15 3 * * *', undefined, { tz: LONDON });
  await boss.schedule('breach-clock', '*/15 * * * *', undefined, { tz: LONDON });
  logger.info('worker started');

  const stop = async (): Promise<void> => {
    await boss.stop({ graceful: true });
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : 'unknown'}\n`);
  process.exit(1);
});
