import { Alert, Button, Flex, Input, Modal, Typography } from 'antd';
import {
  Children,
  cloneElement,
  isValidElement,
  useContext,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from './api.js';
import { useInvalidate } from './pages/settings/hooks.js';
import { useApp } from './shell/AppContext.js';
import { Ms, TabLevel, ViewSwitch, WfCard, useHeadSlots } from './v36/ui.js';

const FIELD_NAMES: Record<string, string> = {
  registration: 'Registration',
  callsign: 'Callsign',
  staffNo: 'Staff number',
  displayName: 'Name',
  reason: 'Reason',
  seats: 'Seats',
};
const fieldName = (path: string) =>
  FIELD_NAMES[path] ??
  path
    .split('.')
    .pop()!
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.errors.length > 0)
      return `Check these fields: ${e.errors.map((x) => `${fieldName(x.path)} (${x.message})`).join('; ')}.`;
    if (e.detail && e.status < 500) return e.detail;
    const byCode: Record<string, string> = {
      SELF_APPROVAL: 'You cannot approve or sign off your own work.',
      OVERRIDE_NOT_PERMITTED: 'This is a safety or statutory block and cannot be overridden.',
      ALLOCATION_BLOCKED: 'Allocation is blocked: see the failed checks.',
      TRANSITION_NOT_ALLOWED: 'That step is not allowed yet.',
      FOUR_EYES_REQUIRED: 'A second person must approve this.',
      STALE_VERSION: 'Someone else changed this record. Refresh and try again.',
      CONFLICT: 'This clashes with an existing record.',
      TEMPLATE_NOT_PUBLISHED:
        'That requirement has not been published yet. Publish it in Settings, Requirement library first.',
      MFA_REQUIRED: 'Your role needs multi-factor sign-in.',
    };
    if (byCode[e.code]) return byCode[e.code]!;
    if (e.status === 403) return 'You do not have permission to do that.';
    if (e.status === 404) return 'Not found, or you do not have access.';
    if (e.status === 400) return 'Check the details and try again.';
    return 'Something went wrong on the server. Try again, and tell your administrator if it keeps happening.';
  }
  if (e instanceof Error && !(e instanceof TypeError)) return e.message;
  return 'Could not reach the server.';
}

export function errReasons(e: unknown): string[] {
  if (!(e instanceof ApiError)) return [];
  return e.checks
    .map((c) => [c.title ?? c.code, c.reasonText].filter(Boolean).join(': '))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

export function useRun() {
  const invalidate = useInvalidate();
  const [msg, setMsg] = useState<{ ok: boolean; text: string; reasons?: string[] } | null>(null);
  async function run(fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await invalidate();
      return true;
    } catch (e) {
      setMsg({ ok: false, text: errText(e), reasons: errReasons(e) });
      return false;
    }
  }
  const node = msg ? (
    <Alert
      type={msg.ok ? 'success' : 'error'}
      showIcon
      role={msg.ok ? 'status' : 'alert'}
      message={msg.text}
      description={
        msg.reasons && msg.reasons.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {msg.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : undefined
      }
    />
  ) : null;
  return { run, msg: node };
}

export function useCan() {
  const { me } = useApp();
  return (p: string) => me.permissions.includes(p);
}

export interface Tab {
  id: string;
  label: string;
  show?: boolean;
}

/** Ant-themed tab strip with stable role=tab names for tests and AT. */
/**
 * v36 module tabs. The page's top-level tabs render in the shell's white head band (as in the v36
 * HTML); a tab set inside one of those panels becomes the blue switch at the right of the band, and
 * deeper ones render in place as v36 view pills.
 */
export function Tabs({
  label,
  tabs,
  current,
  onChange,
  children,
}: {
  label: string;
  tabs: Tab[];
  current: string;
  onChange: (id: string) => void;
  children: ReactNode;
}) {
  const level = useContext(TabLevel);
  const slots = useHeadSlots();
  const [sub, setSub] = useState<HTMLElement | null>(null);
  const visible = tabs.filter((t) => t.show !== false);
  const top = level.depth === 0 && !!slots.tabs;
  if (!top)
    return (
      <>
        <ViewSwitch
          label={label}
          options={visible.map((t) => ({ id: t.id, label: t.label }))}
          current={current}
          onChange={onChange}
        />
        <div
          role="tabpanel"
          id="tab-panel"
          aria-labelledby={`tab-${current}`}
          className="hh-tabpanel"
        >
          <TabLevel.Provider value={{ depth: level.depth + 1, sub: null }}>
            {children}
          </TabLevel.Provider>
        </div>
      </>
    );
  const nav = (
    <div className="ant-tabs ant-tabs-top pc-tabs">
      <nav className="ant-tabs-nav mod-tabs" aria-label={label}>
        <div className="ant-tabs-nav-wrap">
          <div className="ant-tabs-nav-list" role="tablist" aria-label={label}>
            {visible.map((t, i) => {
              const on = current === t.id;
              return (
                <div key={t.id} className={`ant-tabs-tab${on ? ' ant-tabs-tab-active' : ''}`}>
                  <button
                    type="button"
                    role="tab"
                    id={`tab-${t.id}`}
                    aria-selected={on}
                    aria-controls="tab-panel"
                    tabIndex={on ? 0 : -1}
                    className={`ant-tabs-tab-btn${on ? ' on' : ''}`}
                    onKeyDown={(e) => {
                      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                      if (d) onChange(visible[(i + d + visible.length) % visible.length]!.id);
                    }}
                    onClick={() => onChange(t.id)}
                  >
                    {t.label}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="ant-tabs-extra-content" ref={setSub} />
      </nav>
    </div>
  );
  return (
    <>
      {createPortal(nav, slots.tabs!)}
      <div
        role="tabpanel"
        id="tab-panel"
        aria-labelledby={`tab-${current}`}
        className="hh-tabpanel"
      >
        <TabLevel.Provider value={{ depth: 1, sub }}>{children}</TabLevel.Provider>
      </div>
    </>
  );
}

export const input = 'field';
export const button = 'btn-primary';
export const smallButton = 'btn-ghost';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  // Strip colons from useId so htmlFor/getElementById work under jsdom.
  const autoId = `f-${useId().replace(/:/g, '')}`;
  // Label the first form control, even when a hint or status line sits beside it.
  const items = Children.toArray(children);
  const isControl = (c: unknown) =>
    isValidElement(c) &&
    (typeof c.type !== 'string' || ['input', 'select', 'textarea'].includes(c.type));
  const at = items.length === 1 && isValidElement(items[0]) ? 0 : items.findIndex(isControl);
  const child = at >= 0 && isValidElement(items[at]) ? items[at] : null;
  const controlId = (child?.props as { id?: string } | undefined)?.id ?? autoId;
  const control = child
    ? items.map((c, i) =>
        i === at
          ? cloneElement(child as ReactElement<{ id?: string }>, {
              id: (child.props as { id?: string }).id ?? controlId,
            })
          : c,
      )
    : children;
  return (
    <label
      htmlFor={controlId}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}
    >
      <span>{label}</span>
      {control}
    </label>
  );
}

/** v36 page title block (Typography.Title + optional supporting line). */
/**
 * The page title as in v36: in the white head band, with a help button that shows what the page
 * is for, and the page's main buttons on the right. Level 2+ headings render in place.
 */
export function PageHeader({
  title,
  description,
  extra,
  headingLevel = 1,
}: {
  title: string;
  description?: ReactNode;
  extra?: ReactNode;
  /** Use 2 for a tab panel section under a module H1. */
  headingLevel?: 1 | 2 | 3 | 4 | 5;
}) {
  const slots = useHeadSlots();
  const [about, setAbout] = useState(false);
  if (headingLevel !== 1 || !slots.top)
    return (
      <Flex wrap="wrap" align="flex-start" justify="space-between" gap={12}>
        <div className="min-w-0">
          <Typography.Title
            level={headingLevel}
            className="!mb-1 !text-xl !font-semibold !leading-8"
          >
            {title}
          </Typography.Title>
          {description ? (
            <div className="max-w-3xl text-sm text-slate-700">{description}</div>
          ) : null}
        </div>
        {extra ? <div className="shrink-0">{extra}</div> : null}
      </Flex>
    );
  return (
    <>
      {createPortal(
        <>
          <div className="pc-tr">
            <div className="pc-tl wf-ht">
              <h1>{title}</h1>
              {description ? (
                <button
                  type="button"
                  className="pc-help ant-btn ant-btn-text ant-btn-sm ant-btn-icon-only"
                  aria-expanded={about}
                  aria-label="How this page works"
                  title="How this page works"
                  onClick={() => setAbout((a) => !a)}
                >
                  <Ms i="help" />
                </button>
              ) : null}
            </div>
            {extra ? <div className="pc-ex wf-a">{extra}</div> : null}
          </div>
          {description ? (
            <div className="pc-desc">
              <span className="pc-dt">{description}</span>
            </div>
          ) : null}
          {about && description ? <div className="hh-about">{description}</div> : null}
        </>,
        slots.top,
      )}
    </>
  );
}

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <WfCard title={title} extra={actions} className="hh-section">
      {children}
    </WfCard>
  );
}

export const pounds = (pence: number) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
export const words = (code: string | null | undefined) =>
  code
    ? code
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/^./, (c) => c.toUpperCase())
    : '';

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface ActionDialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  reasonLabel?: string;
  reasonRequired?: boolean;
  fields?: ReactNode;
  confirmDisabled?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<unknown>;
  successText?: string;
}

export function ActionDialog(p: ActionDialogProps) {
  const invalidate = useInvalidate();
  const titleId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; reasons: string[] } | null>(null);
  const needReason = p.reasonLabel !== undefined && (p.reasonRequired ?? true);
  const tooShort = needReason && reason.trim().length < 3;
  const close = () => {
    setReason('');
    setError(null);
    p.onCancel();
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await p.onConfirm(reason.trim());
      await invalidate();
      setReason('');
      p.onCancel();
    } catch (e) {
      setError({ text: errText(e), reasons: errReasons(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={p.open}
      title={<span id={titleId}>{p.title}</span>}
      aria-labelledby={titleId}
      onCancel={close}
      destroyOnHidden
      transitionName=""
      maskTransitionName=""
      footer={[
        <Button key="cancel" onClick={close} disabled={busy}>
          Cancel
        </Button>,
        <Button
          key="ok"
          type="primary"
          danger={p.danger}
          loading={busy}
          disabled={tooShort || p.confirmDisabled}
          onClick={() => void confirm()}
        >
          {p.confirmLabel}
        </Button>,
      ]}
    >
      {p.children && <div style={{ marginBottom: 12 }}>{p.children}</div>}
      {p.fields && <div style={{ marginBottom: 12 }}>{p.fields}</div>}
      {p.reasonLabel !== undefined && (
        <label style={{ display: 'block', marginBottom: 12, fontSize: 14 }}>
          <span style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>
            {p.reasonLabel}
            {needReason ? ' (required)' : ' (optional)'}
          </span>
          <Input.TextArea
            autoFocus
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          role="alert"
          message={error.text}
          description={
            error.reasons.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {error.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : undefined
          }
        />
      )}
    </Modal>
  );
}

const sameMonths = (s: string) => s.replace('Sept', 'Sep');

export const fmtDate = (d: string | null | undefined) =>
  d
    ? sameMonths(
        new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'Europe/London',
        }),
      )
    : '';

export const fmtDateTime = (d: string | null | undefined) =>
  d
    ? sameMonths(
        new Date(d).toLocaleString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Europe/London',
        }),
      )
    : '';

export function PersonSelect({
  label,
  value,
  onChange,
  people,
  meId,
  optional,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  people: { id: string; displayName: string; roleNames: string[] }[];
  meId: string;
  optional?: boolean;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
      <span>{label}</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {optional && <option value="">Nobody yet</option>}
        {people.length === 0 && <option value={meId}>Me</option>}
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === meId ? `Me (${p.displayName})` : p.displayName}
            {p.roleNames.length ? ` – ${p.roleNames.join(', ')}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
