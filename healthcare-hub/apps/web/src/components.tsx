import { useState, type ReactNode } from 'react';
import { ApiError } from './api.js';
import { useInvalidate } from './pages/settings/hooks.js';
import { useApp } from './shell/AppContext.js';

/** Plain-English server errors (never echo payloads). */
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const byCode: Record<string, string> = {
      SELF_APPROVAL: 'You cannot approve or sign off your own work.',
      OVERRIDE_NOT_PERMITTED: 'This is a safety or statutory block and cannot be overridden.',
      ALLOCATION_BLOCKED: 'Allocation is blocked: see the failed checks.',
      TRANSITION_NOT_ALLOWED: 'That step is not allowed yet.',
      FOUR_EYES_REQUIRED: 'A second person must approve this.',
      STALE_VERSION: 'Someone else changed this record. Refresh and try again.',
      CONFLICT: 'That has already been done or clashes with an existing record.',
    };
    if (byCode[e.code]) return byCode[e.code]!;
    if (e.status === 403) return 'You do not have permission to do that.';
    if (e.status === 404) return 'Not found, or you do not have access.';
    if (e.status === 400) return e.detail ?? 'Check the details and try again.';
    return `The server rejected the request (${e.code}).`;
  }
  if (e instanceof Error && !(e instanceof TypeError)) return e.message;
  return 'Could not reach the server.';
}

/** Runs a mutation, reports the outcome in a live region and refreshes cached data. */
export function useRun() {
  const invalidate = useInvalidate();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await invalidate();
      return true;
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
      return false;
    }
  }
  const node = msg ? (
    <p
      role={msg.ok ? 'status' : 'alert'}
      className={`rounded border p-2 text-sm ${msg.ok ? 'border-green-700 bg-green-50 text-green-900' : 'border-red-700 bg-red-50 text-red-900'}`}
    >
      {msg.text}
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
