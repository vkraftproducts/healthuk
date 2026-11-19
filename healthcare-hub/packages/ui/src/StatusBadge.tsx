import { Tag } from 'antd';
import type { ReactElement } from 'react';

/** Mirrors RagStatus in @hub/contracts. Colour is never the only signal (CLAUDE.md #8, WCAG 2.2 AA). */
export type StatusKind = 'RED' | 'AMBER' | 'GREEN' | 'GREY' | 'NOT_APPLICABLE';

interface Style {
  word: string;
  color: string;
  icon: ReactElement;
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const STYLES: Record<StatusKind, Style> = {
  RED: {
    word: 'Red',
    color: 'error',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
        {...stroke}
      >
        <path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" />
        <path d="M12 7v6M12 17h.01" />
      </svg>
    ),
  },
  AMBER: {
    word: 'Amber',
    color: 'warning',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
        {...stroke}
      >
        <path d="M12 3 2 21h20z" />
        <path d="M12 10v5M12 18h.01" />
      </svg>
    ),
  },
  GREEN: {
    word: 'Green',
    color: 'success',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
        {...stroke}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="m8 12 3 3 5-6" />
      </svg>
    ),
  },
  GREY: {
    word: 'Grey',
    color: 'default',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
        {...stroke}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01" />
      </svg>
    ),
  },
  NOT_APPLICABLE: {
    word: 'N/A',
    color: 'default',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
        focusable="false"
        {...stroke}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12h8" />
      </svg>
    ),
  },
};

export interface StatusBadgeProps {
  status: StatusKind;
  /** Short reason shown after the status word, e.g. "blocked", "overdue", "due soon". */
  reason?: string;
}

/** `RED – blocked`, `AMBER – due soon`: icon + word + (optional) reason + colour. */
export function StatusBadge({ status, reason }: StatusBadgeProps) {
  const s = STYLES[status];
  return (
    <Tag
      data-status={status}
      color={s.color}
      icon={s.icon}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginInlineEnd: 0,
        borderStyle: status === 'NOT_APPLICABLE' ? 'dashed' : undefined,
      }}
    >
      {s.word}
      {reason ? ` – ${reason}` : ''}
    </Tag>
  );
}
