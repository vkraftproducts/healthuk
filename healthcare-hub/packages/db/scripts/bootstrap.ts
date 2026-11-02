/* eslint-disable no-console */
import { bootstrap } from '../src/admin/index.js';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

bootstrap({
  superuserUrl:
    process.env.DATABASE_SUPERUSER_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres',
  adminUrl: required('DATABASE_ADMIN_URL'),
  appUrl: required('DATABASE_URL'),
})
  .then(() => console.log('bootstrap complete'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
