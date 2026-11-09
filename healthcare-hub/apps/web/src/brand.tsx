import { useId } from 'react';

/** Product branding, set per deployment at build time (VITE_BRAND_NAME, VITE_BRAND_LEGAL_NAME). */
const PRODUCT = 'Healthcare Hub';
const company = import.meta.env.VITE_BRAND_NAME || '';

export const BRAND = {
  product: PRODUCT,
  company,
  legalName: import.meta.env.VITE_BRAND_LEGAL_NAME || '',
  /** Page title and accessible name: "Exora Medical Healthcare Hub", or just the product. */
  name: company ? `${company} ${PRODUCT}` : PRODUCT,
};

/**
 * Logo marks. "pulse" (Pulse Cross: a medical cross with a heartbeat line) is the primary logo;
 * "rapid" (Rapid Response: an ambulance on the move) is the approved backup. Choose the backup for
 * a deployment with VITE_BRAND_LOGO=rapid. Standalone SVGs for these and the other options that
 * were considered are in public/brand/ (keep public/favicon.svg in step with the chosen mark).
 */
export type LogoVariant = 'pulse' | 'rapid';
const configured = import.meta.env.VITE_BRAND_LOGO === 'rapid' ? 'rapid' : 'pulse';

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
          <stop offset="0" stopColor="#b4f24d" />
          <stop offset=".52" stopColor="#22e58a" />
          <stop offset="1" stopColor="#0fb5a0" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b4f24d" stopOpacity=".28" />
          <stop offset="1" stopColor="#0fb5a0" stopOpacity=".10" />
        </linearGradient>
        <filter id={`${id}b`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      {variant === 'rapid' ? (
        <>
          <rect x="2" y="2" width="60" height="60" rx="16" fill="#05110b" />
          <rect x="2" y="2" width="60" height="60" rx="16" fill={f} />
          <rect
            x="2.9"
            y="2.9"
            width="58.2"
            height="58.2"
            rx="15.2"
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
          <g filter={`url(#${id}b)`} opacity=".7">
            <rect x="23" y="16" width="10" height="4" rx="2" fill="#b4f24d" />
          </g>
          <rect x="23" y="16" width="10" height="4" rx="2" fill="#effff6" />
          <path
            d="M16 23.5h22V45H16z M38 28h9l8.5 8.5V45H38z"
            fill={g}
            stroke={g}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <path d="M41 31.2h4.8l5 5.2H41z" fill="#05110b" />
          <g fill="#effff6">
            <rect x="24.3" y="27.5" width="4.4" height="12.5" rx="1" />
            <rect x="20.2" y="31.6" width="12.6" height="4.4" rx="1" />
          </g>
          <g fill="#05110b" stroke="#effff6" strokeWidth="2">
            <circle cx="23.5" cy="46" r="4.6" />
            <circle cx="46" cy="46" r="4.6" />
          </g>
        </>
      ) : (
        <>
          <circle cx="32" cy="32" r="29" fill="#05110b" />
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
            stroke="#effff6"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={100}
            {...(animated ? { strokeDasharray: 100, className: 'animate-draw' } : {})}
          />
          <circle cx="57" cy="33.5" r="2.6" fill="#b4f24d" />
        </>
      )}
    </svg>
  );
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-center gap-2.5">
        <BrandLogo size={36} />
        <div className="leading-tight">
          <div className="font-display text-[16px] font-semibold tracking-tight text-hub-ink">
            {company || (
              <>
                Healthcare <span className="text-hub-teal">Hub</span>
              </>
            )}
          </div>
          {company && <div className="text-xs text-hub-muted">{PRODUCT}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3.5">
      <BrandLogo size={52} animated />
      <div className="leading-tight">
        <div className="flex flex-wrap items-baseline gap-x-2 font-display text-xl tracking-tight">
          <span className="font-semibold text-hub-ink">
            {company || (
              <>
                Healthcare <span className="text-hub-teal">Hub</span>
              </>
            )}
          </span>
          {company && (
            <>
              <span aria-hidden="true" className="text-hub-muted">
                |
              </span>
              <span className="font-normal text-hub-teal-dark">{PRODUCT}</span>
            </>
          )}
        </div>
        {BRAND.legalName && <div className="text-sm text-hub-muted">{BRAND.legalName}</div>}
      </div>
    </div>
  );
}

/** Decorative, non-interactive hero art for the sign-in screens: a radar sweep and a heartbeat line. */
export function HeroArt() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(600px_380px_at_20%_0%,rgb(25_230_140/0.16),transparent_70%)]" />
      <svg
        className="absolute -bottom-44 -right-44 h-[540px] w-[540px] text-hub-teal"
        viewBox="0 0 400 400"
        fill="none"
        stroke="currentColor"
        focusable="false"
      >
        <defs>
          <linearGradient
            id="hero-sweep"
            x1="200"
            y1="200"
            x2="335"
            y2="40"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#22e58a" stopOpacity="0.4" />
            <stop offset="1" stopColor="#22e58a" stopOpacity="0" />
          </linearGradient>
        </defs>
        <circle cx="200" cy="200" r="190" strokeOpacity=".22" />
        <circle cx="200" cy="200" r="140" strokeOpacity=".28" />
        <circle cx="200" cy="200" r="90" strokeOpacity=".34" strokeDasharray="2 7" />
        <circle cx="200" cy="200" r="40" strokeOpacity=".5" />
        <path d="M200 10V390M10 200H390" strokeOpacity=".14" />
        <g
          className="animate-[spin_14s_linear_infinite]"
          style={{ transformOrigin: '200px 200px' }}
        >
          <path d="M200 200V10A190 190 0 0 1 335 65Z" fill="url(#hero-sweep)" stroke="none" />
        </g>
        <circle cx="270" cy="118" r="4" fill="#b4f24d" stroke="none" />
        <circle
          cx="270"
          cy="118"
          r="4"
          fill="#b4f24d"
          stroke="none"
          className="origin-center animate-beacon"
          style={{ transformOrigin: '270px 118px' }}
        />
      </svg>
      <svg
        className="absolute bottom-24 left-0 h-16 w-full text-hub-teal md:bottom-32"
        viewBox="0 0 600 64"
        fill="none"
        preserveAspectRatio="none"
        focusable="false"
      >
        <path
          d="M0 32H190l12-22 16 46 14-32 8 8H600"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeOpacity=".5"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
