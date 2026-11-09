/**
 * "Neon Forest" light theme, matching the web app. WCAG 2.2 AA: every text colour below is at least
 * 4.5:1 on its background; colour is always paired with an icon and words (non-negotiable 8).
 */
export const colors = {
  text: '#0b2a1c',
  muted: '#4a6a5a',
  border: '#cde5d7',
  edge: '#6f9a84',
  bg: '#eef7f2',
  card: '#ffffff',
  field: '#ffffff',
  primary: '#047857',
  primaryText: '#ffffff',
  glow: '#10b981',
  green: '#166534',
  greenBg: '#dcf5e6',
  amber: '#92400e',
  amberBg: '#fef3c7',
  red: '#b91c1c',
  redBg: '#fee2e2',
  dangerSolid: '#b91c1c',
  onDanger: '#ffffff',
  grey: '#3f5a4c',
  greyBg: '#e4efe9',
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
