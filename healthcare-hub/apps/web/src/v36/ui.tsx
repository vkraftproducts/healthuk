// v36 building blocks: Material Symbols icons and the page-head slots the shell provides, so a
// page's title and tabs render in the white head band exactly as in the v36 HTML.
import { createContext, useContext, useId, type ReactNode } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { Button, Dropdown } from 'antd';
import { ICONS } from './icons.js';

/** A Material Symbols icon drawn as inline SVG (v36 `.ms.msv`). Decorative unless `label`. */
export function Ms({ i, className, label }: { i: string; className?: string; label?: string }) {
  const d = ICONS[i] ?? ICONS['circle'] ?? '';
  return (
    <span
      className={`ms msv${className ? ` ${className}` : ''}`}
      data-i={i}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <svg viewBox="0 0 960 960" aria-hidden="true" focusable="false">
        <path d={d} />
      </svg>
    </span>
  );
}

/** DOM nodes in the shell's head band that a page's header and tabs render into. */
export interface HeadSlots {
  top: HTMLElement | null;
  tabs: HTMLElement | null;
}
export const HeadSlotsCtx = createContext<HeadSlots>({ top: null, tabs: null });
export const useHeadSlots = () => useContext(HeadSlotsCtx);

export function Children({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

// ---- v36 page pieces --------------------------------------------------------------------------
export type KTone = 'blue' | 'red' | 'amber' | 'green' | 'purple' | 'grey';

export interface KpiItem {
  title: string;
  value: ReactNode;
  foot?: ReactNode;
  tone?: KTone;
  icon?: string;
  onClick?: () => void;
  active?: boolean;
}

/** The v36 KPI row (`.pc-kpis` of `.kpi` cards). */
export function KpiCards({ items }: { items: KpiItem[] }) {
  return (
    <div className="wf-k pc-kpis">
      {items.map((k) => {
        const click = k.onClick;
        return (
          <div
            key={k.title}
            className={`ant-card ant-card-bordered kpi ${k.tone ?? 'blue'}${k.active ? ' on' : ''}`}
            {...(click
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'data-act': 'go',
                  ...(k.active !== undefined ? { 'aria-pressed': k.active } : {}),
                  onClick: click,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      click();
                    }
                  },
                }
              : {})}
            aria-label={`${k.title}: ${typeof k.value === 'string' || typeof k.value === 'number' ? k.value : ''}${typeof k.foot === 'string' ? `. ${k.foot}` : ''}`}
          >
            <div className="ant-card-body">
              <div className="ant-statistic">
                <div className="ant-statistic-header">
                  <small className="ant-statistic-title">{k.title}</small>
                  {k.icon && (
                    <span className="kpi-ic">
                      <Ms i={k.icon} />
                    </span>
                  )}
                </div>
                <div className="ant-statistic-content">
                  <b className="ant-statistic-content-value">{k.value}</b>
                </div>
                {k.foot !== undefined && (
                  <span className="kpi-f">
                    {k.foot}
                    {click && (
                      <span className="kpi-go">
                        <Ms i="chevron_right" />
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A v36 card (`section.wf-card`) with an H2 title, optional count and right-hand actions. */
export function WfCard({
  title,
  count,
  extra,
  children,
  className,
  table,
}: {
  title?: ReactNode;
  count?: number;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  /** The body holds a table that runs edge to edge (v36 `.has-tbl`). */
  table?: boolean;
}) {
  const hid = useId();
  return (
    <section
      className={`wf-card ant-card ant-card-bordered${className ? ` ${className}` : ''}`}
      {...(title !== undefined ? { 'aria-labelledby': hid } : {})}
    >
      {title !== undefined && (
        <div className="wf-ch ant-card-head">
          <div className="ant-card-head-wrapper">
            <div className="ant-card-head-title">
              <h2 id={hid}>
                {title}
                {count !== undefined && <span className="wf-mut"> ({count})</span>}
              </h2>
            </div>
            {extra && <div className="ant-card-extra">{extra}</div>}
          </div>
        </div>
      )}
      <div className={`ant-card-body${table ? ' has-tbl' : ''}`}>{children}</div>
    </section>
  );
}

/** A v36 status pill (`.wf-st`), with an optional icon. */
/** Plain text of string / number children (elements count as no text). */
function textOf(n: ReactNode): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  return '';
}

export function WfTag({
  tone,
  icon,
  children,
}: {
  tone: KTone;
  icon?: string;
  children: ReactNode;
}) {
  const ant = tone === 'amber' ? 'gold' : tone === 'grey' ? 'default' : tone;
  // v36 (polish33): a tag stays on one line only when its text, icon name included, is 26
  // characters or fewer; longer tags wrap inside narrow columns.
  const nw = `${icon ?? ''}${textOf(children)}`.replace(/\s+/g, ' ').length <= 26;
  return (
    <span className={`wf-st k-${tone} ant-tag ant-tag-outlined ant-tag-${ant}${nw ? ' tg-nw' : ''}`}>
      {icon && <Ms i={icon} />}
      {children}
    </span>
  );
}

/** A v36 task row (`.wf-task`): icon tile, title and detail, status pill. */
export function WfTask({
  icon,
  title,
  detail,
  tag,
  onOpen,
}: {
  icon: string;
  title: ReactNode;
  detail?: ReactNode;
  tag?: ReactNode;
  onOpen?: () => void;
}) {
  return (
    <div
      className={`wf-task${onOpen ? ' row-click' : ''}`}
      {...(onOpen
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: onOpen,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen();
              }
            },
            'aria-label': `${typeof title === 'string' ? title : 'Task'} – open`,
          }
        : {})}
    >
      <span className="ic">
        <Ms i={icon} />
      </span>
      <div className="tx">
        <b>{title}</b>
        {detail && <span>{detail}</span>}
      </div>
      {tag}
    </div>
  );
}

// ---- tab levels -------------------------------------------------------------------------------
/**
 * Where a tab or view switcher sits: level 0 is the module tabs in the head band, level 1 is the
 * blue switch at the right of that band (`sub` is its slot), level 2+ renders inline as v36 pills.
 */
export const TabLevel = createContext<{ depth: number; sub: HTMLElement | null }>({
  depth: 0,
  sub: null,
});

export interface SwitchOption {
  id: string;
  label: ReactNode;
}

/** v36 view switcher: the blue segmented switch (level 1) or the teal pills (deeper). */
export function ViewSwitch({
  label,
  options,
  current,
  onChange,
  role = 'tab',
}: {
  label: string;
  options: SwitchOption[];
  current: string;
  onChange: (id: string) => void;
  /** 'radio' for a plain view choice, 'tab' when it controls a tab panel. */
  role?: 'tab' | 'radio';
}) {
  const { depth, sub } = useContext(TabLevel);
  const seg = depth === 1 && !!sub;
  const btn = (o: SwitchOption, i: number) => {
    const on = o.id === current;
    return (
      <button
        key={o.id}
        type="button"
        role={role}
        {...(role === 'tab'
          ? { 'aria-selected': on, id: `tab-${o.id}`, 'aria-controls': 'tab-panel' }
          : { 'aria-checked': on })}
        tabIndex={on ? 0 : -1}
        className={
          seg ? `ant-segmented-item${on ? ' ant-segmented-item-selected on' : ''}` : on ? 'on' : ''
        }
        onClick={() => onChange(o.id)}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (d) onChange(options[(i + d + options.length) % options.length]!.id);
        }}
      >
        {seg ? <span className="ant-segmented-item-label">{o.label}</span> : o.label}
      </button>
    );
  };
  const groupRole = role === 'tab' ? 'tablist' : 'radiogroup';
  if (seg)
    return createPortal(
      <div className="ant-segmented sub-sw" role={groupRole} aria-label={label}>
        <div className="ant-segmented-group">{options.map(btn)}</div>
      </div>,
      sub!,
    );
  return (
    <div className="wf-tabs ant-tb" role={groupRole} aria-label={label}>
      {options.map(btn)}
    </div>
  );
}

/** Marks what is inside as one level deeper, so its view switcher renders as v36 pills. */
export function Deeper({ children }: { children: ReactNode }) {
  const { depth } = useContext(TabLevel);
  return <TabLevel.Provider value={{ depth: depth + 1, sub: null }}>{children}</TabLevel.Provider>;
}

// ---- v36 filter bar, search box, native select, bar --------------------------------------------
/** v36 filter row (`.wf-filters.rec-f.std-f`): search box and unlabeled selects side by side. */
export function WfFilters({ children }: { children: ReactNode }) {
  return <div className="wf-filters rec-f std-f">{children}</div>;
}

/** v36 search box: magnifier inside the field, the placeholder is the visible prompt. */
export function WfSearch({
  value,
  onChange,
  placeholder = 'Name, reference or text…',
  label = 'Search',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <label className="rec-l tf-ql nl34">
      <span className=" sr-only">{label}</span>
      <span className="ant-input-affix-wrapper tf-q">
        <Ms i="search" />
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="ant-input ant-input-outlined"
          aria-label={label}
        />
      </span>
    </label>
  );
}

/** v36 native select (`select.ant-sel`); the first option is the "all" choice. */
export function WfSelect<V extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: V;
  onChange: (v: V) => void;
  options: readonly { value: V; label: string }[];
}) {
  return (
    <label className="rec-l nl34">
      <span className=" sr-only">{label}</span>
      <select
        className="ant-sel"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** v36 thin progress bar (`.wf-bar.sm`) with the count written under it. */
export function WfBar({ done, total, tone }: { done: number; total: number; tone?: string }) {
  if (!total) return <>—</>;
  const pct = Math.round((100 * done) / total);
  return (
    <>
      <div className="wf-bar sm" aria-hidden="true">
        <i style={{ width: `${pct}%`, ...(tone ? { background: tone } : {}) }} />
      </div>
      <span className="sub">
        {done} of {total}
      </span>
    </>
  );
}

/** v36 row actions: one small primary button, then a "More actions" menu for the rest. */
export interface RowAction {
  label: string;
  icon?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}
export function RowActions({
  primary,
  more = [],
  name,
  ghost,
}: {
  primary?: RowAction | null;
  more?: RowAction[];
  /** What the row is, for the menu's accessible name. */
  name?: string;
  /** The main action as an outlined button (v36 "View", "Record reading"). */
  ghost?: boolean;
}) {
  return (
    <span className="hh-acts">
      {primary && (
        <Button
          size="small"
          type={ghost ? 'default' : 'primary'}
          danger={primary.danger}
          disabled={primary.disabled}
          icon={primary.icon ? <Ms i={primary.icon} /> : undefined}
          onClick={primary.onClick}
          aria-label={name ? `${primary.label} – ${name}` : undefined}
        >
          {primary.label}
        </Button>
      )}
      {more.length > 0 && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: more.map((m, i) => ({
              key: String(i),
              label: m.label,
              danger: m.danger,
              disabled: m.disabled,
              icon: m.icon ? <Ms i={m.icon} /> : undefined,
              onClick: m.onClick,
            })),
          }}
        >
          <Button
            size="small"
            type="text"
            className="kebab"
            icon={<Ms i="more_horiz" />}
            aria-label={name ? `More actions – ${name}` : 'More actions'}
            title="More actions"
          />
        </Dropdown>
      )}
    </span>
  );
}

/** v36 second-level switch with counts (`.wf-seg2`): "Bookings 16 · 2 to action". */
export function SegTabs<V extends string>({
  label,
  current,
  onChange,
  options,
}: {
  label: string;
  current: V;
  onChange: (v: V) => void;
  options: {
    id: V;
    label: string;
    icon?: string;
    count?: number;
    flag?: { text: string; tone: 'am' | 'rd' };
  }[];
}) {
  return (
    <div className="wf-seg2" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === current}
          className={o.id === current ? 'on' : ''}
          onClick={() => onChange(o.id)}
        >
          {o.icon && <Ms i={o.icon} />}
          {o.label}
          {o.count !== undefined && <span className="c">{o.count}</span>}
          {o.flag && <span className={`c ${o.flag.tone}`}>{o.flag.text}</span>}
        </button>
      ))}
    </div>
  );
}

/** v36 red alert strip (`.wf-warn`): one line that needs someone's attention. */
export function WfWarn({
  children,
  icon = 'notification_important',
}: {
  children: ReactNode;
  icon?: string;
}) {
  return (
    <div className="wf-warn" role="status">
      <Ms i={icon} />
      <span>{children}</span>
    </div>
  );
}
