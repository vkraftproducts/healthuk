import * as LocalAuthentication from 'expo-local-authentication';
import type { Biometrics } from '../core/ports';

/** A passcode is mandatory (MOBILE_APP "Device security"); biometrics unlock returning sessions. */
export const biometrics: Biometrics = {
  async available() {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level !== LocalAuthentication.SecurityLevel.NONE;
  },
  async authenticate(prompt) {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });
    return r.success;
  },
};
