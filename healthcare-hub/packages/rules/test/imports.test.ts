import { describe, expect, it } from 'vitest';
import {
  findPlaceholders,
  headerKey,
  legacyKloeCodes,
  parseCsv,
  stageWorkbookRow,
} from '../src/imports.js';

describe('CSV parsing [INT-01]', () => {
  it('handles quotes, doubled quotes, commas and newlines inside quotes, CRLF and a BOM', () => {
    const text =
      '﻿staffNo,displayName\r\nST-1,"Morgan, Alex"\r\n\r\nST-2,"Say ""hi""\nthere"\nST-3,\n';
    expect(parseCsv(text)).toEqual([
      ['staffNo', 'displayName'],
      ['ST-1', 'Morgan, Alex'],
      ['ST-2', 'Say "hi"\nthere'],
      ['ST-3', ''],
    ]);
  });
  it('last line without a newline, and a lone CR', () => {
    expect(parseCsv('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('')).toEqual([]);
  });
  it('refuses an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/Unterminated/);
  });
  it('compares headers loosely', () => {
    expect(headerKey('Staff No.')).toBe('staffno');
  });
});

describe('workbook staging [MIG-02]', () => {
  it('headers are structure, prompts keep their code; placeholders and KLOE codes are references only', () => {
    expect(stageWorkbookRow({ code: '', text: 'Safe', status: '', kloe: '' })).toEqual({
      kind: 'HEADER',
      promptCode: null,
      text: 'Safe',
      placeholders: [],
      sourceStatus: null,
      legacyKloe: [],
    });
    expect(
      stageWorkbookRow({
        code: 'P-12',
        text: 'Fire risk assessment for [ENTER PRACTICE NAME] reviewed. Default Image',
        status: 'Compliant',
        kloe: 'S2, s4.1; W1',
      }),
    ).toEqual({
      kind: 'PROMPT',
      promptCode: 'P-12',
      text: 'Fire risk assessment for [ENTER PRACTICE NAME] reviewed. Default Image',
      placeholders: ['[ENTER PRACTICE NAME]', 'ENTER', 'Default Image'],
      sourceStatus: 'Compliant',
      legacyKloe: ['S2', 'S4.1', 'W1'],
    });
    expect(stageWorkbookRow({ code: 'P-13', text: '', status: '', kloe: '' })!.text).toBe('P-13');
    expect(stageWorkbookRow({ code: ' ', text: ' ', status: '', kloe: '' })).toBeNull();
    expect(findPlaceholders('ENTER here')).toEqual(['ENTER']);
    expect(legacyKloeCodes('X9 E7')).toEqual(['E7']);
  });
});
