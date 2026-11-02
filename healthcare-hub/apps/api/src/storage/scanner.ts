export const SCANNER = Symbol('SCANNER');

export interface ScanResult {
  status: 'CLEAN' | 'MALICIOUS' | 'FAILED';
  /** The type detected from the content (not the one the client declared). */
  detectedMime: string | null;
  reason: string | null;
}

export interface Scanner {
  scan(bytes: Buffer, declaredMime: string): Promise<ScanResult>;
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const sig = (b: Buffer, ...bytes: number[]) => bytes.every((x, i) => b[i] === x);

function detect(b: Buffer): string | null {
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (sig(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (sig(b, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  if (sig(b, 0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
  return null;
}

const OFFICE_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * Development / test scanner: content-type sniffing, executable signatures, the EICAR test string,
 * macro containers and active PDF content. It is NOT an antivirus. Production relies on Microsoft
 * Defender for Storage; unscanned or malicious files are never downloadable either way.
 */
export class BasicScanner implements Scanner {
  async scan(bytes: Buffer, declaredMime: string): Promise<ScanResult> {
    const text = bytes.toString('latin1');
    if (text.includes(EICAR))
      return { status: 'MALICIOUS', detectedMime: null, reason: 'EICAR test signature' };
    if (sig(bytes, 0x4d, 0x5a) || sig(bytes, 0x7f, 0x45, 0x4c, 0x46) || text.startsWith('#!')) {
      return { status: 'MALICIOUS', detectedMime: null, reason: 'Executable content' };
    }
    const detected = detect(bytes);
    if (declaredMime === 'text/plain' || declaredMime === 'text/csv') {
      if (bytes.includes(0))
        return {
          status: 'MALICIOUS',
          detectedMime: detected,
          reason: 'Binary content in a text file',
        };
      return { status: 'CLEAN', detectedMime: declaredMime, reason: null };
    }
    const expected = OFFICE_MIMES.has(declaredMime) ? 'application/zip' : declaredMime;
    if (detected !== expected)
      return {
        status: 'MALICIOUS',
        detectedMime: detected,
        reason: 'Content does not match the declared type',
      };
    if (OFFICE_MIMES.has(declaredMime) && text.includes('vbaProject'))
      return { status: 'MALICIOUS', detectedMime: detected, reason: 'Macro-enabled document' };
    if (
      declaredMime === 'application/pdf' &&
      /\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(text)
    ) {
      return { status: 'MALICIOUS', detectedMime: detected, reason: 'Active content in PDF' };
    }
    return { status: 'CLEAN', detectedMime: declaredMime, reason: null };
  }
}
