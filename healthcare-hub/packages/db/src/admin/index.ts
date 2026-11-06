// Operational entry points (roles/database bootstrap, migrations, synthetic seed).
// Used by CLI scripts, CI and test harnesses. NOT for request-handling code.
export { bootstrap } from './bootstrap.js';
export { migrate } from './migrate.js';
export { seed, SEED_IDS, SEED_USERS, SEED_SUPPORT } from './seed.js';
export { syncSystemRoles } from './system-roles.js';
export {
  checkDevLogin,
  DEV_DEFAULT_PASSWORD,
  ensureDevAuth,
  seedDevCredentials,
  setDevPassword,
} from './dev-auth.js';
