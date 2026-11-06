import { useState, type ReactNode } from 'react';
import { ApiError } from './api.js';
import { useInvalidate } from './pages/settings/hooks.js';
import { useApp } from './shell/AppContext.js';

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

/**
 * Plain-English server errors (never echo payloads). The server's own explanation wins; codes are
 * only a fallback, so people see what to do next rather than a generic refusal.
 */
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

/** Reasons the server gave (for example the checks still missing), as plain lines. */
export function errReasons(e: unknown): string[] {
  if (!(e instanceof ApiError)) return [];
  return e.checks
    .map((c) => [c.title ?? c.code, c.reasonText].filter(Boolean).join(': '))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/** Runs a mutation, reports the outcome in a live region and refreshes cached data. */
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
    <p
      role={msg.ok ? 'status' : 'alert'}
      className={`rounded border p-2 text-sm ${msg.ok ? 'border-green-700 bg-green-50 text-green-900' : 'border-red-700 bg-red-50 text-red-900'}`}
    >
      {msg.text}
      {msg.reasons && msg.reasons.length > 0 && (
        <span className="mt-1 block">
          <ul className="list-disc pl-5">
            {msg.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </span>
      )}
    </p>
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

/** Accessible tab strip (arrow keys move between tabs). */
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
  const visible = tabs.filter((t) => t.show !== false);
  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        className="flex flex-wrap gap-1 rounded-lg border border-hub-line bg-white p-1.5"
      >
        {visible.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={current === t.id}
            aria-controls="tab-panel"
            tabIndex={current === t.id ? 0 : -1}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (d) onChange(visible[(i + d + visible.length) % visible.length]!.id);
            }}
            onClick={() => onChange(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${current === t.id ? 'bg-hub-teal text-white' : 'text-hub-navy hover:bg-hub-row'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="tab-panel"
        aria-labelledby={`tab-${current}`}
        className="space-y-4 pt-4"
      >
        {children}
      </div>
    </>
  );
}

export const input = 'rounded-md border border-slate-500 bg-white px-2.5 py-1.5';
export const button =
  'rounded-md bg-hub-teal px-4 py-2 text-sm font-semibold text-white hover:bg-hub-teal-dark disabled:opacity-50';
export const smallButton =
  'rounded-md border border-slate-500 bg-white px-2.5 py-1 text-sm font-medium text-hub-navy hover:bg-hub-row';

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col text-sm">
      {label}
      {children}
    </label>
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
  const id = `sec-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section aria-labelledby={id} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id={id} className="text-lg font-bold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
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

/** Saves a Blob as a file in the browser. */
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
  /** What will happen, in plain words. */
  children?: ReactNode;
  confirmLabel: string;
  /** Label for the reason box; omit for no reason box. */
  reasonLabel?: string;
  reasonRequired?: boolean;
  /** Extra fields rendered above the reason (controlled by the caller). */
  fields?: ReactNode;
  /** Disable confirm (for example while extra fields are incomplete). */
  confirmDisabled?: boolean;
  danger?: boolean;
  onCancel: () => void;
  /** Runs the change; resolve to close, throw to show the error inside the dialog. */
  onConfirm: (reason: string) => Promise<unknown>;
  successText?: string;
}

/**
 * In-app confirm dialog with an optional reason (UI_SPEC interaction rules: destructive and
 * approval actions need a confirm with reason). Replaces browser pop-ups, which cannot be styled,
 * are not accessible and block automation.
 */
export function ActionDialog(p: ActionDialogProps) {
  const invalidate = useInvalidate();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; reasons: string[] } | null>(null);
  if (!p.open) return null;
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-dialog-title"
        className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl"
      >
        <h2 id="action-dialog-title" className="text-lg font-semibold">
          {p.title}
        </h2>
        {p.children && <div className="mt-2 space-y-2 text-sm">{p.children}</div>}
        {p.fields && <div className="mt-3 space-y-3">{p.fields}</div>}
        {p.reasonLabel !== undefined && (
          <label className="mt-3 block text-sm">
            <span className="mb-1 block font-medium">
              {p.reasonLabel}
              {needReason ? ' (required)' : ' (optional)'}
            </span>
            <textarea
              autoFocus
              className="w-full rounded border border-slate-400 p-2"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        {error && (
          <div
            role="alert"
            className="mt-3 rounded border border-red-700 bg-red-50 p-2 text-sm text-red-900"
          >
            {error.text}
            {error.reasons.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {error.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={smallButton} onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 ${p.danger ? 'bg-red-700' : 'bg-hub-teal'}`}
            disabled={busy || tooShort || p.confirmDisabled}
            onClick={() => void confirm()}
          >
            {busy ? 'Working…' : p.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ICU versions differ on "Sep" vs "Sept"; screens use the same three-letter months everywhere.
const sameMonths = (s: string) => s.replace('Sept', 'Sep');

/** UK date for a date-only value ("4 Nov 2026"); empty when missing. */
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

/** UK date and time in London time ("4 Nov 2026, 14:05"); empty when missing. */
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

/** Owner picker: active members by name, with their role so the right person is chosen. */
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
    <label className="flex flex-col text-sm">
      {label}
      <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
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
