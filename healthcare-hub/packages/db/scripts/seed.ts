/* eslint-disable no-console */
import { seed } from '../src/admin/index.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL is required');
seed(url)
  .then(() => console.log('seeded Example organisation / Watford'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
