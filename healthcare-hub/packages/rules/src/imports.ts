/**
 * Import parsing rules (INT-01, MIG-01..03). Pure: the API stages, validates and replays rows
 * through the normal endpoints; nothing here touches a database.
 */

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, UTF-8 BOM. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      endRow();
      if (c === '\r' && s[i + 1] === '\n') i += 1;
    } else field += c;
    i += 1;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Header names compared without case, spaces or punctuation ("Staff No." = "staffno"). */
export const headerKey = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Workbook placeholders that must become "unresolved", never data (MIG-02). */
const PLACEHOLDERS: readonly RegExp[] = [/\[ENTER[^\]]*\]/gi, /\bENTER\b/g, /\bDefault Image\b/gi];
export function findPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const re of PLACEHOLDERS) for (const m of text.matchAll(re)) found.add(m[0]);
  return [...found];
}

/** Legacy CQC KLOE codes (S1–S6, E1–E7, C1–C3, R1–R3, W1–W8), kept only as references. */
export function legacyKloeCodes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(/\b([SECRW])(\d{1,2})(?:\.\d+)?\b/g)) out.add(m[0]);
  return [...out];
}

export interface WorkbookCells {
  code: string;
  text: string;
  status: string;
  kloe: string;
}
export interface StagedWorkbookRow {
  kind: 'HEADER' | 'PROMPT';
  promptCode: string | null;
  text: string;
  placeholders: string[];
  sourceStatus: string | null;
  legacyKloe: string[];
}

/**
 * One workbook row. A row with text but no prompt code is structure (a header); a row with a
 * code is a prompt. Empty rows return null. The source status is kept as text only.
 */
export function stageWorkbookRow(c: WorkbookCells): StagedWorkbookRow | null {
  const code = c.code.trim();
  const text = c.text.trim();
  if (!text && !code) return null;
  return {
    kind: code ? 'PROMPT' : 'HEADER',
    promptCode: code || null,
    text: (text || code).slice(0, 4000),
    placeholders: findPlaceholders(text),
    sourceStatus: c.status.trim() || null,
    legacyKloe: legacyKloeCodes(c.kloe),
  };
}
