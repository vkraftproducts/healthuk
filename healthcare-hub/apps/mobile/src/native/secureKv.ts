import * as SecureStore from 'expo-secure-store';
import type { SecureKv } from '../core/ports';

/** Keychain / Keystore, readable only while the device is unlocked, never backed up or migrated. */
const OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const secureKv: SecureKv = {
  get: (k) => SecureStore.getItemAsync(k, OPTS),
  set: (k, v) => SecureStore.setItemAsync(k, v, OPTS),
  delete: (k) => SecureStore.deleteItemAsync(k, OPTS),
};
