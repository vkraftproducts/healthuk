/* eslint-disable no-console */
import { migrate } from '../src/admin/index.js';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL is required');
migrate(url)
  .then((a) => console.log(a.length ? `applied: ${a.join(', ')}` : 'up to date'))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
