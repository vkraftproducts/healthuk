/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_MOCK_OIDC_URL?: string;
  /** dev (default in development) | local (username + password, ADR 0006) | entra */
  readonly VITE_AUTH_MODE?: 'dev' | 'local' | 'entra';
  /** Shown on sign-in, in the sidebar and as the page title (default "Healthcare Hub"). */
  readonly VITE_BRAND_NAME?: string;
  /** Optional line under the brand name, e.g. the registered company name. */
  readonly VITE_BRAND_LEGAL_NAME?: string;
}
