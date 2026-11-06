/* eslint-disable no-console */
import { seedSectors } from '../src/admin/index.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL is required');
seedSectors(url)
  .then(() => console.log('seeded mock dental practice and mock care home (synthetic demo data)'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
