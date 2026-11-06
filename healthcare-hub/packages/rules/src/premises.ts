import { addDays, addMonths, formatDate, type ISODate } from './dates.js';

/**
 * J1: status of a premises item that has an interval (and its source) but no linked requirement.
 * Next due is the assessment date plus the interval. Without verified evidence it never shows
 * green: overdue is red, due within 30 days amber, otherwise grey with the date.
 */
export function premisesIntervalStatus(
  p: { intervalMonths: number | null; assessedOn: Date | ISODate | null },
  today: ISODate,
): { status: 'RED' | 'AMBER' | 'GREY'; reasonText: string; nextDue: ISODate | null } | null {
  if (!p.intervalMonths) return null;
  if (!p.assessedOn)
    return {
      status: 'GREY',
      reasonText: 'Record the last assessment date to work out when it is next due',
      nextDue: null,
    };
  const last =
    typeof p.assessedOn === 'string' ? p.assessedOn : p.assessedOn.toISOString().slice(0, 10);
  const nextDue = addMonths(last, p.intervalMonths);
  if (nextDue < today)
    return { status: 'RED', reasonText: `Overdue since ${formatDate(nextDue)}`, nextDue };
  if (nextDue <= addDays(today, 30))
    return { status: 'AMBER', reasonText: `Due ${formatDate(nextDue)}`, nextDue };
  return {
    status: 'GREY',
    reasonText: `Next due ${formatDate(nextDue)}; link a requirement to record verified evidence`,
    nextDue,
  };
}
