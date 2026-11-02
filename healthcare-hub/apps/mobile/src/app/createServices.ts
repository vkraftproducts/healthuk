import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import { Linking, Platform } from 'react-native';
import type { MobileConfig } from '../config';
import { Api } from '../core/api';
import { CrewCache } from '../core/cache';
import { uuidv7 } from '../core/ids';
import { Outbox } from '../core/outbox';
import { KEYS, Session, wipeDevice } from '../core/session';
import { SyncEngine } from '../core/sync';
import { devAuth, entraAuth } from '../native/auth';
import { biometrics } from '../native/biometrics';
import { fileStore } from '../native/files';
import { takePhoto } from '../native/photos';
import { clearNotifications, registerForPush } from '../native/push';
import { secureKv } from '../native/secureKv';
import { useSecureScreen } from '../native/secureScreen';
import { sqliteStore } from '../native/sqliteStore';
import type { Services } from './services';

/** Wires the real device adapters into the core. Only App.tsx calls this. */
export function createServices(cfg: MobileConfig, isOnline: () => boolean): Services {
  const clock = () => new Date();
  const newId = () => uuidv7(Date.now(), (n) => Crypto.getRandomBytes(n));
  const store = sqliteStore(secureKv);
  const deviceId = async () => {
    let id = await secureKv.get(KEYS.deviceId);
    if (!id) {
      id = newId();
      await secureKv.set(KEYS.deviceId, id);
    }
    return id;
  };
  const session = new Session({
    kv: secureKv,
    auth: cfg.devAuth ? devAuth(cfg) : entraAuth(cfg),
    bio: biometrics,
    clock,
    wipe: () =>
      wipeDevice({
        kv: secureKv,
        clearStore: () => store.wipe(),
        clearFiles: () => fileStore.removeAll(),
        clearNotifications,
      }),
  });
  const api = new Api({
    baseUrl: cfg.apiUrl,
    fetch: (...a) => fetch(...a),
    getToken: () => session.token(),
    getOrgId: () => session.getOrgId(),
    getDeviceId: deviceId,
    // Revoked device or leaver: wipe on this contact (MOBILE_APP "Cache TTL").
    onRevoked: (code) => void session.wipe(code),
  });
  const outbox = new Outbox(store, newId, clock);
  return {
    api,
    outbox,
    sync: new SyncEngine({ api, outbox, files: fileStore, store, clock, isOnline }),
    cache: new CrewCache(store, clock),
    session,
    files: fileStore,
    clock,
    controlPhone: cfg.controlPhone,
    takePhoto,
    callControl: () => void Linking.openURL(`tel:${cfg.controlPhone}`),
    openMaps: (address) => {
      const q = encodeURIComponent(address);
      void Linking.openURL(Platform.OS === 'ios' ? `maps:?q=${q}` : `geo:0,0?q=${q}`);
    },
    useSecureScreen,
    deviceId,
    registerDevice: async () =>
      registerForPush(
        api,
        await deviceId(),
        Application.nativeApplicationVersion,
        cfg.easProjectId,
      ),
  };
}
