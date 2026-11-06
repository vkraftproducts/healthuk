import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Crew app (APP-01, APP-02). Environment comes from EAS build profiles (eas.json): local dev talks
 * to the mock OIDC; pilot and production use Entra External ID with PKCE.
 */
const env = process.env;
const profile = env.APP_ENV ?? 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: profile === 'production' ? 'Healthcare Hub Crew' : `Hub Crew (${profile})`,
  slug: 'healthcare-hub-crew',
  scheme: 'healthcarehub',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: 'uk.example.healthcarehub.crew',
    supportsTablet: false,
    infoPlist: {
      NSFaceIDUsageDescription: 'Unlock Healthcare Hub without typing your passcode.',
      NSCameraUsageDescription: 'Photograph defects, inspection faults and fuel receipts.',
      ITSAppUsesNonExemptEncryption: false,
    },
    config: { usesNonExemptEncryption: false },
  },
  android: {
    package: 'uk.example.healthcarehub.crew',
    // No Android auto-backup of app data (tokens and the database stay on the device).
    allowBackup: false,
    permissions: ['CAMERA', 'USE_BIOMETRIC', 'USE_FINGERPRINT', 'POST_NOTIFICATIONS'],
    blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_MEDIA_IMAGES'],
  },
  plugins: [
    ['expo-sqlite', { useSQLCipher: true }],
    'expo-secure-store',
    [
      'expo-local-authentication',
      { faceIDPermission: 'Unlock Healthcare Hub without typing your passcode.' },
    ],
    [
      'expo-image-picker',
      {
        cameraPermission: 'Photograph defects, inspection faults and fuel receipts.',
        photosPermission: false,
        microphonePermission: false,
      },
    ],
    ['expo-notifications', { enableBackgroundRemoteNotifications: false }],
    'expo-screen-capture',
  ],
  extra: {
    apiUrl: env.HUB_API_URL ?? 'http://localhost:3000',
    scheme: 'healthcarehub',
    oidc: {
      issuer: env.HUB_OIDC_ISSUER ?? 'http://localhost:4010',
      clientId: env.HUB_OIDC_CLIENT_ID ?? 'crew-app',
      scopes: ['openid', 'offline_access', env.HUB_OIDC_API_SCOPE ?? 'api://healthcare-hub/crew'],
    },
    devAuth: profile === 'development' && env.HUB_DEV_AUTH !== '0',
    devUser: env.HUB_DEV_USER ?? 'crew',
    devPassword: env.HUB_DEV_PASSWORD ?? 'Exora-dev-2026',
    // Synthetic default (Ofcom drama range); real number set per customer in the build profile.
    controlPhone: env.HUB_CONTROL_PHONE ?? '01632960000',
    easProjectId: env.EAS_PROJECT_ID,
    eas: env.EAS_PROJECT_ID ? { projectId: env.EAS_PROJECT_ID } : undefined,
  },
});
