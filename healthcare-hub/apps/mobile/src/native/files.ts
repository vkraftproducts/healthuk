import { Directory, File, Paths } from 'expo-file-system';
import type { FileStore } from '../core/ports';

/** Photos waiting to upload, kept in app-private storage (excluded from backups) until sent. */
const dir = () => new Directory(Paths.document, 'pending-uploads');

export const fileStore: FileStore = {
  async keep(uri) {
    const d = dir();
    if (!d.exists) d.create({ intermediates: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const dest = new File(d, name);
    new File(uri).copy(dest);
    return { uri: dest.uri, sizeBytes: dest.size ?? 0 };
  },
  async read(uri) {
    return new File(uri);
  },
  async remove(uri) {
    const f = new File(uri);
    if (f.exists) f.delete();
  },
  async removeAll() {
    const d = dir();
    if (d.exists) d.delete();
  },
};
