import Constants from 'expo-constants';

export interface MobileConfig {
  apiUrl: string;
  scheme: string;
  oidc: { issuer: string; clientId: string; scopes: string[] };
  /** Local development against the mock OIDC only. */
  devAuth: boolean;
  devUser: string;
  /** Development sign-in password for devUser (local development builds only). */
  devPassword: string;
  /** Control room number for one-tap "Call control" (APP-02). */
  controlPhone: string;
  easProjectId?: string;
}

export function loadConfig(): MobileConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as Partial<MobileConfig>;
  return {
    apiUrl: extra.apiUrl ?? 'http://localhost:3000',
    scheme: extra.scheme ?? 'healthcarehub',
    oidc: extra.oidc ?? {
      issuer: 'http://localhost:4010',
      clientId: 'crew-app',
      scopes: ['openid'],
    },
    devAuth: extra.devAuth ?? false,
    devUser: extra.devUser ?? 'crew',
    devPassword: extra.devPassword ?? 'Exora-dev-2026',
    // Synthetic default from the Ofcom drama range.
    controlPhone: extra.controlPhone ?? '01632960000',
    ...(extra.easProjectId ? { easProjectId: extra.easProjectId } : {}),
  };
}
