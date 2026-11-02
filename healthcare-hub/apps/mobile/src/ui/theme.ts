/** WCAG 2.2 AA contrast on white; colour always paired with an icon and words (non-negotiable 8). */
export const colors = {
  text: '#0f172a',
  muted: '#334155',
  border: '#cbd5e1',
  bg: '#f8fafc',
  card: '#ffffff',
  primary: '#0b4f8a',
  primaryText: '#ffffff',
  green: '#166534',
  greenBg: '#dcfce7',
  amber: '#854d0e',
  amberBg: '#fef3c7',
  red: '#991b1b',
  redBg: '#fee2e2',
  grey: '#374151',
  greyBg: '#e5e7eb',
};

/** Large touch targets for gloved hands and use at a glance. */
export const TOUCH = 56;

export const LONDON = 'Europe/London';
export const time = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: LONDON,
    hour: '2-digit',
    minute: '2-digit',
  });
export const day = (iso: string | Date) =>
  new Date(iso).toLocaleDateString('en-GB', {
    timeZone: LONDON,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
