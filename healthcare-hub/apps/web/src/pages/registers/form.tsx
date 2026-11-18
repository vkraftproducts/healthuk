// Small form pieces for the v36 register screens (17 Nov 2026). Every field has a visible label;
// dialogs use ActionDialog so errors from the API are shown in plain words.
import { Checkbox, DatePicker, Input, InputNumber, Select } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { Field } from '../../components.js';

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type FormState = Record<string, string | number | boolean | undefined>;

export const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

/** Form state with a typed setter per field. */
type Widen<X> = X extends boolean
  ? boolean
  : X extends string
    ? string
    : X extends number
      ? number
      : X;
type Widened<T> = { [K in keyof T]: Widen<T[K]> };
export function useForm<T extends FormState>(initial: T) {
  const [v, setV] = useState<Widened<T>>(initial as Widened<T>);
  const set =
    <K extends keyof T>(k: K) =>
    (x: Widen<T[K]>) =>
      setV((s) => ({ ...s, [k]: x }));
  return { v, set, reset: () => setV(initial as Widened<T>) };
}

export function TextF(p: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={p.label}>
      <Input value={p.value} onChange={(e) => p.onChange(e.target.value)} />
    </Field>
  );
}

export function AreaF(p: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={p.label}>
      <Input.TextArea rows={3} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
    </Field>
  );
}

export function NumF(p: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <Field label={p.label}>
      <InputNumber
        style={{ width: '100%' }}
        min={p.min ?? 0}
        max={p.max}
        value={p.value}
        onChange={(n) => p.onChange(typeof n === 'number' ? n : 0)}
      />
    </Field>
  );
}

export function SelectF(p: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <Field label={p.label}>
      <Select
        value={p.value || undefined}
        options={p.options}
        onChange={(x) => p.onChange(x)}
        style={{ width: '100%' }}
        showSearch
        optionFilterProp="label"
      />
    </Field>
  );
}

export function DateF(p: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  noFuture?: boolean;
  noPast?: boolean;
}) {
  return (
    <Field label={p.label}>
      <DatePicker
        value={p.value ? dayjs(p.value) : null}
        onChange={(d) => p.onChange(d ? d.format('YYYY-MM-DD') : '')}
        disabledDate={(d) =>
          (!!p.noFuture && d.isAfter(dayjs(), 'day')) || (!!p.noPast && d.isBefore(dayjs(), 'day'))
        }
        format="YYYY-MM-DD"
        style={{ width: '100%' }}
      />
    </Field>
  );
}

export function DateTimeF(p: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={p.label}>
      <DatePicker
        showTime={{ format: 'HH:mm' }}
        value={p.value ? dayjs(p.value) : null}
        onChange={(d) => p.onChange(d ? d.toISOString() : '')}
        disabledDate={(d) => d.isAfter(dayjs(), 'day')}
        format="YYYY-MM-DD HH:mm"
        style={{ width: '100%' }}
      />
    </Field>
  );
}

export function CheckF(p: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ margin: '8px 0' }}>
      <Checkbox checked={p.checked} onChange={(e) => p.onChange(e.target.checked)}>
        {p.label}
      </Checkbox>
    </div>
  );
}

export const opts = (m: Record<string, string>) =>
  Object.entries(m).map(([value, label]) => ({ value, label }));
