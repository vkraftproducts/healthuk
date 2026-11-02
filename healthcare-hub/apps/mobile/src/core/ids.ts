/**
 * RFC 9562 UUIDv7 for client submission ids: time-ordered, so the outbox replays in the order
 * things were captured, and unique per device without asking the server.
 */
export function uuidv7(nowMs: number, random: (n: number) => Uint8Array): string {
  const b = random(16);
  if (b.length !== 16) throw new Error('random() must return 16 bytes');
  let ms = Math.max(0, Math.floor(nowMs));
  for (let i = 5; i >= 0; i -= 1) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
