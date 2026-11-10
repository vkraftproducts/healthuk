/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_MOCK_OIDC_URL?: string;
  /** dev (default in development) | local (username + password, ADR 0006) | entra */
  readonly VITE_AUTH_MODE?: 'dev' | 'local' | 'entra';
  /** Logo: vkraft (default), pulse (Pulse Cross) or rapid (Rapid Response ambulance). */
  readonly VITE_BRAND_LOGO?: 'vkraft' | 'pulse' | 'rapid';
}
