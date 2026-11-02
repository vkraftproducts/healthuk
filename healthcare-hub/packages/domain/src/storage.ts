import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

export interface BlobStore {
  /** Writes bytes to quarantine. Keys are generated server-side, never from user input. */
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/**
 * Filesystem implementation for local development and tests. Production uses Azure Blob Storage
 * (private container, SAS, Defender for Storage scanning) behind this same interface.
 */
export class LocalBlobStore implements BlobStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    // Keys are `<orgId>/<itemId>/<versionNo>`-shaped; refuse anything that could escape the root.
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/.test(key) || key.includes('..'))
      throw new Error('Invalid blob key');
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid blob key');
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes, { mode: 0o600 });
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.path(key))).isFile();
    } catch {
      return false;
    }
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
