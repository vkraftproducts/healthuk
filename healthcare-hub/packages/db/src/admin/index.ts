// Operational entry points (roles/database bootstrap, migrations, synthetic seed).
// Used by CLI scripts, CI and test harnesses. NOT for request-handling code.
export { bootstrap } from './bootstrap.js';
export { migrate } from './migrate.js';
export { seed, SEED_IDS, SEED_USERS, SEED_SUPPORT } from './seed.js';
export { seedSectors, SECTOR_IDS, SECTOR_USERS } from './seed-sectors.js';
export { seedLocalCredentials, DEFAULT_SEED_LOCAL_PASSWORD } from './seed-credentials.js';
export { syncSystemRoles } from './system-roles.js';
