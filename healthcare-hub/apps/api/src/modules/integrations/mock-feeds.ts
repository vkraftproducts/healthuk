import { createHash } from 'node:crypto';

/**
 * Deterministic synthetic feeds for the mock integrations. The same organisation, record and day
 * always give the same values, so a repeated sync is idempotent. Nothing here is real data.
 */

/** Small stable integer from any text (0..2^32-1). */
export function hash32(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/** A stable UUID-shaped id for an external record, used as the idempotency key. */
export function externalId(namespace: string, ref: string): string {
  const h = createHash('sha256').update(`${namespace}:${ref}`).digest('hex');
  // Version 5-style nibbles so it is a valid UUID string.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Telematics: kilometres-as-miles added since the last reading, 30..79. */
export const telematicsDelta = (callsign: string, day: string): number =>
  30 + (hash32(`telematics:${callsign}:${day}`) % 50);

export interface FuelFeedItem {
  ref: string;
  amountPence: number;
  litres: number;
  supplier: string;
}
/** FleetX fuel-card transaction for a vehicle on a day (£45.00..£69.99, 38..52 litres). */
export function fuelTransaction(callsign: string, day: string, suffix = ''): FuelFeedItem {
  const h = hash32(`fleetx:${callsign}:${day}`);
  return {
    ref: `FX-${callsign}-${day}${suffix}`,
    amountPence: 4500 + (h % 2500),
    litres: 38 + (h % 15),
    supplier: 'Mock fuel card (synthetic)',
  };
}

export interface TrainingFeedItem {
  staffNo: string;
  courseCode: string;
  title: string;
  completedOn: string;
  expiresOn: string;
}
const COURSES = [
  { courseCode: 'MH-REFRESH', title: 'Moving and handling refresher', years: 1 },
  { courseCode: 'SAFEG-L2', title: 'Safeguarding adults and children (level 2)', years: 3 },
  { courseCode: 'IPC-REFRESH', title: 'Infection prevention and control refresher', years: 1 },
];
const addYears = (day: string, years: number): string =>
  `${Number(day.slice(0, 4)) + years}${day.slice(4)}`;
/** One completion per staff number, courses rotating; completed the day before `day`. */
export function trainingCompletions(
  staffNos: readonly string[],
  completedOn: string,
): TrainingFeedItem[] {
  return staffNos.map((staffNo, i) => {
    const c = COURSES[i % COURSES.length]!;
    return {
      staffNo,
      courseCode: c.courseCode,
      title: c.title,
      completedOn,
      expiresOn: addYears(completedOn, c.years),
    };
  });
}

/** iCalendar text escaping (RFC 5545 section 3.3.11). */
export const icsText = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
/** UTC timestamp in iCalendar form: 20261104T090000Z. */
export const icsStamp = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
