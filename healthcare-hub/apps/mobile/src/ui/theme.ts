/**
 * "Neon Forest" light theme, matching the web app (navy and teal from the wireframe). WCAG 2.2 AA: every text colour below is at least
 * 4.5:1 on its background; colour is always paired with an icon and words (non-negotiable 8).
 */
export const colors = {
  text: '#1f3a52',
  muted: '#52677a',
  border: '#d6e1ea',
  edge: '#64748b',
  bg: '#f2f6fa',
  card: '#ffffff',
  field: '#ffffff',
  primary: '#0f7c86',
  primaryText: '#ffffff',
  glow: '#0f7c86',
  green: '#166534',
  greenBg: '#dcf5e6',
  accentBg: '#e0f0f2',
  amber: '#92400e',
  amberBg: '#fef3c7',
  red: '#b91c1c',
  redBg: '#fee2e2',
  dangerSolid: '#b91c1c',
  onDanger: '#ffffff',
  grey: '#475569',
  greyBg: '#e8eef4',
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
