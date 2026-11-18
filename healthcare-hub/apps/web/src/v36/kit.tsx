// v36 page kit on Ant Design: the same pieces every v36 screen is made of (views, KPI cards,
// status tags with icon + word, people, check strips). Hiding here is cosmetic; the API decides.
import { CloseCircleOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Avatar, Progress, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { KpiCards, Ms, ViewSwitch } from './ui.js';

export type Tone = 'green' | 'amber' | 'red' | 'grey' | 'blue' | 'purple';

const TONE_COLOR: Record<Tone, string> = {
  green: 'success',
  amber: 'warning',
  red: 'error',
  grey: 'default',
  blue: 'processing',
  purple: 'purple',
};

/** RAG status from the API → v36 tone. */
export const toneOf = (status: string | null | undefined): Tone =>
  status === 'RED'
    ? 'red'
    : status === 'AMBER'
      ? 'amber'
      : status === 'GREEN'
        ? 'green'
        : status === 'BLUE' || status === 'PENDING'
          ? 'blue'
          : 'grey';

/** Status as icon + word + colour (never colour alone, WCAG 2.2), in the v36 pill markup. */
const TONE_MS: Record<Tone, string> = {
  green: 'check_circle',
  amber: 'schedule',
  red: 'error',
  grey: 'radio_button_unchecked',
  blue: 'hourglass_top',
  purple: 'verified_user',
};
export function StatusTag({
  tone,
  icon,
  children,
}: {
  tone: Tone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const ant = TONE_COLOR[tone] === 'warning' ? 'warning' : TONE_COLOR[tone];
  return (
    <span className={`wf-st k-${tone} ant-tag ant-tag-outlined ant-tag-${ant}`} data-tone={tone}>
      {icon ?? <Ms i={TONE_MS[tone]} />}
      {children}
    </span>
  );
}
export const RejectIcon = CloseCircleOutlined;

/** v36 "view" switcher under a module tab (Pipeline | Evidence review). */
export function Views<V extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: ReactNode }[];
}) {
  return (
    <ViewSwitch
      role="radio"
      label={label}
      current={value}
      onChange={(v) => onChange(v as V)}
      options={options.map((o) => ({ id: o.value, label: o.label }))}
    />
  );
}

export interface Kpi {
  title: string;
  value: ReactNode;
  foot: string;
  tone: Tone;
  onClick?: () => void;
  pressed?: boolean;
}
/** v36 KPI cards: a title, a big number and a line saying what it counts. */
const KPI_ICON: Record<Tone, string> = {
  green: 'check_circle',
  amber: 'schedule',
  red: 'error',
  grey: 'radio_button_unchecked',
  blue: 'info',
  purple: 'how_to_reg',
};
export function Kpis({ items }: { items: Kpi[] }) {
  return (
    <KpiCards
      items={items.map((k) => ({
        title: k.title,
        value: k.value,
        foot: k.foot,
        tone: k.tone,
        icon: KPI_ICON[k.tone],
        ...(k.pressed !== undefined ? { active: k.pressed } : {}),
        ...(k.onClick ? { onClick: k.onClick } : {}),
      }))}
    />
  );
}

const hue = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
};
export const initials = (name: string) =>
  name
    .replace(/^(Dr|Mr|Mrs|Ms|Miss)\.?\s+/i, '')
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** Avatar with initials (decorative; the name is always written next to it). */
export function PersonAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <Avatar
      size={size}
      aria-hidden="true"
      style={{ background: `hsl(${hue(name)} 50% 32%)`, flex: 'none', fontSize: size * 0.4 }}
    >
      {initials(name)}
    </Avatar>
  );
}
export function Who({ name, sub }: { name: string; sub?: ReactNode }) {
  // v36: a coloured initials avatar (hue from the name) beside the name and a second line.
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const initials = name
    .replace(/^(Dr|Mr|Mrs|Ms|Miss)\.?\s+/i, '')
    .split(/[\s.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .slice(0, 2);
  return (
    <div className="wf-who">
      <span className="wf-av" style={{ background: `hsl(${h} 50% 32%)` }} aria-hidden="true">
        {initials}
      </span>
      <div>
        <b>{name}</b>
        {sub !== undefined && <span className="sub">{sub}</span>}
      </div>
    </div>
  );
}

/** Progress bar with the count written underneath ("3 of 14"). */
export function CountBar({ done, total }: { done: number; total: number }) {
  if (total === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const pct = Math.round((100 * done) / total);
  return (
    <div style={{ minWidth: 110 }}>
      <Progress
        percent={pct}
        showInfo={false}
        size="small"
        strokeColor={pct === 100 ? '#237804' : '#1667d9'}
        aria-label={`${done} of ${total}`}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {done} of {total}
      </Typography.Text>
    </div>
  );
}

const STRIP: Record<'green' | 'amber' | 'red' | 'grey' | 'blue', string> = {
  green: '#237804',
  amber: '#d48806',
  red: '#cf1322',
  blue: '#1667d9',
  grey: '#d9d9d9',
};
/** v36 check strip: one segment per check (decorative; the counts are written beside it). */
export function CheckStrip({ tones }: { tones: (keyof typeof STRIP)[] }) {
  return (
    <span aria-hidden="true" style={{ display: 'flex', gap: 2, margin: '6px 0' }}>
      {tones.map((t, i) => (
        <i
          key={i}
          style={{ flex: 1, height: 6, borderRadius: 2, background: STRIP[t], display: 'block' }}
        />
      ))}
    </span>
  );
}

/** Muted helper text. */
export function Mut({ children }: { children: ReactNode }) {
  return <Typography.Text type="secondary">{children}</Typography.Text>;
}

/** A note stating a rule the server enforces (v36 "rule" line). */
export function RuleNote({ children }: { children: ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        fontSize: 13,
        color: token.colorTextSecondary,
      }}
    >
      <SafetyCertificateOutlined style={{ marginTop: 3 }} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

export const day = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Europe/London',
      }).format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso))
    : '—';
