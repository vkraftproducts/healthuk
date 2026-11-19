import { useId } from 'react';

const PRODUCT = 'Healthcare Hub UK';
const MAKER = 'Vkraft';

export const BRAND = {
  product: PRODUCT,
  maker: MAKER,
  /** Page title and accessible name. */
  name: PRODUCT,
};

/**
 * Logo marks. "pulse" (Pulse Cross: a medical cross with a heartbeat line) is the primary logo;
 * "rapid" (Rapid Response: an ambulance on the move) is the approved backup. Choose the backup for
 * a deployment with VITE_BRAND_LOGO=rapid. Standalone SVGs for these and the other options that
 * were considered are in public/brand/ (keep public/favicon.svg in step with the chosen mark).
 */
export type LogoVariant = 'pulse' | 'rapid';
const configured = import.meta.env.VITE_BRAND_LOGO === 'rapid' ? 'rapid' : 'pulse';

/** The maker's "by VKRAFT" badge (the supplied artwork has a white background). */
export function MadeBy({ compact = false }: { compact?: boolean }) {
  return (
    <img
      src="/brand/by-vkraft.png"
      alt={`by ${MAKER}`}
      width={97}
      height={35}
      className={`block w-auto rounded-md ${compact ? 'h-6' : 'h-8'}`}
    />
  );
}

export function BrandLogo({
  size = 40,
  variant = configured,
  animated = false,
}: {
  size?: number;
  variant?: LogoVariant;
  /** Draws the heartbeat line in a loop (large, decorative uses only). */
  animated?: boolean;
}) {
  const id = useId().replace(/:/g, '');
  const g = `url(#${id}g)`;
  const f = `url(#${id}f)`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}g`} x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9cc0e4" />
          <stop offset=".52" stopColor="#3d7ab8" />
          <stop offset="1" stopColor="#1667d9" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9cc0e4" stopOpacity=".28" />
          <stop offset="1" stopColor="#1667d9" stopOpacity=".10" />
        </linearGradient>
        <filter id={`${id}b`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      {variant === 'rapid' ? (
        <>
          <rect x="2" y="2" width="60" height="60" rx="14" fill="#0d2137" />
          <rect x="2" y="2" width="60" height="60" rx="14" fill={f} />
          <rect
            x="2.9"
            y="2.9"
            width="58.2"
            height="58.2"
            rx="13.2"
            fill="none"
            stroke={g}
            strokeOpacity=".6"
            strokeWidth="1.5"
          />
          <g stroke={g} strokeWidth="2.6" strokeLinecap="round">
            <line x1="6.5" y1="27" x2="11" y2="27" opacity=".6" />
            <line x1="8.5" y1="34" x2="13" y2="34" />
            <line x1="6.5" y1="41" x2="11" y2="41" opacity=".6" />
          </g>
          <rect x="23" y="16" width="10" height="4" rx="2" fill="#e8f1fa" />
          <path
            d="M16 23.5h22V45H16z M38 28h9l8.5 8.5V45H38z"
            fill={g}
            stroke={g}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <path d="M41 31.2h4.8l5 5.2H41z" fill="#0d2137" />
          <g fill="#e8f1fa">
            <rect x="24.3" y="27.5" width="4.4" height="12.5" rx="1" />
            <rect x="20.2" y="31.6" width="12.6" height="4.4" rx="1" />
          </g>
          <g fill="#0d2137" stroke="#e8f1fa" strokeWidth="2">
            <circle cx="23.5" cy="46" r="4.6" />
            <circle cx="46" cy="46" r="4.6" />
          </g>
        </>
      ) : (
        <>
          <circle cx="32" cy="32" r="29" fill="#0d2137" />
          <circle cx="32" cy="32" r="29" fill="none" stroke={g} strokeWidth="2.4" />
          <path
            d="M27 13h10v14h14v10H37v14H27V37H13V27h14z"
            fill={f}
            stroke={g}
            strokeWidth="1.6"
            strokeLinejoin="round"
            opacity=".9"
          />
          <path
            d="M7 33.5h15l4.5-13 6.5 27 4.5-14 2.5 0H57"
            fill="none"
            stroke="#e8f1fa"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="57" cy="33.5" r="2.6" fill="#9cc0e4" />
        </>
      )}
    </svg>
  );
}

/** v36 light-sider brand: primary tile + product name + org line (passed as children or subtitle). */
export function BrandMark({
  compact = false,
  subtitle,
}: {
  compact?: boolean;
  subtitle?: string;
}) {
  return (
    <div className={`flex items-center ${compact ? 'gap-2.5' : 'gap-3'}`} style={{ minWidth: 0 }}>
      <span
        className="grid place-items-center flex-none text-white"
        style={{
          width: compact ? 32 : 40,
          height: compact ? 32 : 40,
          background: '#1667d9',
          borderRadius: 8,
        }}
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 24 24"
          width={compact ? 20 : 24}
          height={compact ? 20 : 24}
          fill="currentColor"
          focusable="false"
        >
          <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3zm0 4v3H9v2h3v3h2v-3h3V9h-3V6h-2z" />
        </svg>
      </span>
      <div className="leading-tight" style={{ minWidth: 0 }}>
        <b
          className="block truncate"
          style={{
            fontSize: compact ? 15 : 18,
            fontWeight: 600,
            lineHeight: compact ? '20px' : '24px',
            color: 'var(--side-ink)',
          }}
        >
          {PRODUCT}
        </b>
        {subtitle ? (
          <small
            className="block truncate"
            style={{ fontSize: 12, lineHeight: '16px', color: 'var(--side-mut)' }}
          >
            {subtitle}
          </small>
        ) : (
          !compact && (
            <div className="mt-0.5">
              <MadeBy compact />
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** Soft brand panel for sign-in (v36 primary blue). */
export function HeroArt() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(700px_420px_at_15%_0%,rgb(22_103_217/0.35),transparent_70%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(160deg,#1667d9_0%,rgb(22_103_217/0.75)_55%,#1667d9_100%)]" />
    </div>
  );
}
