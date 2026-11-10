/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_MOCK_OIDC_URL?: string;
  /** dev (default in development) | local (username + password, ADR 0006) | entra */
  readonly VITE_AUTH_MODE?: 'dev' | 'local' | 'entra';
  /** Logo: pulse (default, Pulse Cross) or rapid (backup, Rapid Response ambulance). */
  readonly VITE_BRAND_LOGO?: 'pulse' | 'rapid';
}
