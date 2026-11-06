// Local development only: prints the current 6-digit code for a TOTP secret shown on the
// "Set up your authenticator" screen, for testers without an authenticator app.
// Usage: pnpm --filter @hub/api totp <SECRET>
import { TOTP_STEP_SECONDS, totpCode } from '../src/auth/totp.js';

const secret = (process.argv[2] ?? '').replace(/\s+/g, '').toUpperCase();
if (!/^[A-Z2-7]+$/.test(secret)) {
  console.error(
    'Usage: pnpm --filter @hub/api totp <SECRET> (the base32 key from the setup screen)',
  );
  process.exit(1);
}
const now = Date.now();
const left = TOTP_STEP_SECONDS - (Math.floor(now / 1000) % TOTP_STEP_SECONDS);
console.log(`${totpCode(secret, now)} (valid for ${left} more seconds)`);
