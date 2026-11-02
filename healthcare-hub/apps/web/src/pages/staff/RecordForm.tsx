import { RecordPayloads, type RecordKind } from '@hub/contracts';
import { useState, type FormEvent } from 'react';
import type { z } from 'zod';

/**
 * Builds a form from the same zod schema the API validates with, so the UI can never drift from
 * the contract. Only simple field types are rendered; nested objects are entered as text.
 */
type Field =
  | { name: string; kind: 'text' | 'date' | 'number' | 'list' | 'bool'; required: boolean }
  | { name: string; kind: 'enum'; options: string[]; required: boolean };

interface Def {
  type: string;
  innerType?: { _zod: { def: Def } };
  entries?: Record<string, string>;
  element?: { _zod: { def: Def } };
}
const defOf = (s: unknown): Def => (s as { _zod: { def: Def } })._zod.def;

export function fieldsOf(kind: RecordKind): Field[] {
  const shape = (RecordPayloads[kind] as unknown as z.ZodObject).shape as Record<string, unknown>;
  return Object.entries(shape).flatMap(([name, schema]): Field[] => {
    let d = defOf(schema);
    let required = true;
    while ((d.type === 'optional' || d.type === 'default') && d.innerType) {
      required = false;
      d = d.innerType._zod.def;
    }
    if (d.type === 'enum')
      return [{ name, kind: 'enum', options: Object.values(d.entries ?? {}), required }];
    if (d.type === 'boolean') return [{ name, kind: 'bool', required: false }];
    if (d.type === 'number') return [{ name, kind: 'number', required }];
    if (d.type === 'array') return [{ name, kind: 'list', required }];
    if (d.type === 'object') return []; // nested (e.g. next of kin): edited elsewhere
    const dateLike = /(On|Date|Expiry|^from$|^to$)$/.test(name);
    return [{ name, kind: dateLike ? 'date' : 'text', required }];
  });
}

const label = (n: string) =>
  n
    .replace(/UserId$/, ' (user id)')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase());

export function RecordForm({
  kind,
  onSubmit,
}: {
  kind: RecordKind;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
}) {
  const fields = fieldsOf(kind);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const data: Record<string, unknown> = {};
    for (const fd of fields) {
      const raw = f.get(fd.name);
      if (fd.kind === 'bool') {
        data[fd.name] = raw === 'on';
        continue;
      }
      const v = typeof raw === 'string' ? raw.trim() : '';
      if (!v) continue;
      if (fd.kind === 'number') data[fd.name] = Number(v);
      else if (fd.kind === 'list')
        data[fd.name] = v
          .split(',')
          .map((x) => x.trim().toUpperCase())
          .filter(Boolean);
      else data[fd.name] = v;
    }
    setBusy(true);
    try {
      await onSubmit(data);
      form.reset();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={submit}
      className="grid gap-3 sm:grid-cols-2"
      aria-label={`Add ${kind.toLowerCase().replace(/_/g, ' ')} record`}
    >
      {fields.map((fd) => (
        <label
          key={fd.name}
          className={
            fd.kind === 'bool' ? 'flex items-center gap-2 text-sm' : 'flex flex-col text-sm'
          }
        >
          {fd.kind === 'bool' ? <input type="checkbox" name={fd.name} /> : null}
          <span>
            {label(fd.name)}
            {fd.required && fd.kind !== 'bool' ? ' (required)' : ''}
            {fd.kind === 'list' ? ' (comma separated)' : ''}
          </span>
          {fd.kind === 'enum' ? (
            <select
              name={fd.name}
              required={fd.required}
              className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
            >
              {!fd.required && <option value="">Not set</option>}
              {fd.options.map((o) => (
                <option key={o} value={o}>
                  {o.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          ) : fd.kind === 'bool' ? null : (
            <input
              name={fd.name}
              required={fd.required}
              type={fd.kind === 'date' ? 'date' : fd.kind === 'number' ? 'number' : 'text'}
              className="rounded-md border border-slate-500 bg-white px-2.5 py-1.5"
            />
          )}
        </label>
      ))}
      <div className="sm:col-span-2">
        <button
          disabled={busy}
          className="rounded-md bg-hub-teal px-4 py-2 text-sm font-semibold text-white hover:bg-hub-teal-dark disabled:opacity-50"
        >
          Save record
        </button>
      </div>
    </form>
  );
}
