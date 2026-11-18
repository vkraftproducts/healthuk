/* eslint-disable no-console */
// DEV/DEMO ONLY: `pnpm db:seed:v36` after `db:seed` and `db:seed:sectors`. Loads the v36 prototype's
// sample records into the demo organisation. Set V36_SEED_FORCE=1 to re-apply the first-time records.
// A failure is reported but does not stop the stack from starting: the app still works without it.
import { seedV36 } from '../src/admin/seed-v36.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL is required');
seedV36(url, { force: process.env.V36_SEED_FORCE === '1' })
  .then((r) =>
    console.log(
      r.skippedOnce
        ? `v36 sample data already loaded (names refreshed: ${r.always} steps)`
        : `loaded the v36 sample data (${r.once} records, dates moved by ${r.offsetDays} days)`,
      r.movedDays
        ? `; moved the sample dates forward ${r.movedDays} day(s) to today${
            r.stuck.length ? ` (left as they were: ${r.stuck.join(', ')})` : ''
          }`
        : '',
    ),
  )
  .catch((e: Error) => {
    console.error(`v36 sample data NOT loaded: ${e.message}`);
    if (process.env.V36_SEED_STRICT === '1') process.exit(1);
  });
