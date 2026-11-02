/**
 * Device capabilities the core logic needs. Native adapters (src/native) implement them with Expo
 * modules; tests use in-memory fakes. Keeping the core free of native imports is what lets the
 * offline and security rules be unit-tested.
 */
import type { OutboxItem } from './outbox';

/** Hardware-backed key store (iOS Keychain / Android Keystore). */
export interface SecureKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The encrypted local database (SQLCipher). */
export interface LocalStore {
  putOutbox(item: OutboxItem): Promise<void>;
  listOutbox(): Promise<OutboxItem[]>;
  deleteOutbox(clientSubmissionId: string): Promise<void>;
  getCache(key: string): Promise<{ value: string; until: string } | null>;
  setCache(key: string, value: string, until: string): Promise<void>;
  deleteCache(key: string): Promise<void>;
  /** Removes every row and resets the database (sign-out, revocation, failed unlocks). */
  wipe(): Promise<void>;
}

/** Local copies of photos waiting to be uploaded. */
export interface FileStore {
  /** Copies a captured photo into app-private storage; returns the new uri and its size. */
  keep(uri: string): Promise<{ uri: string; sizeBytes: number }>;
  read(uri: string): Promise<Blob>;
  remove(uri: string): Promise<void>;
  removeAll(): Promise<void>;
}

export interface Biometrics {
  /** True when the device has a passcode and enrolled biometrics (or passcode fallback). */
  available(): Promise<boolean>;
  authenticate(prompt: string): Promise<boolean>;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface AuthProvider {
  signIn(): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens | null>;
}

export type Clock = () => Date;
