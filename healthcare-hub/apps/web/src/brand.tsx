import { useId } from 'react';

const PRODUCT = 'Healthcare Hub';
const MAKER = 'Vkraft';

export const BRAND = {
  product: PRODUCT,
  maker: MAKER,
  /** Page title and accessible name. */
  name: `${PRODUCT} by ${MAKER}`,
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
          <stop offset="0" stopColor="#8fd8e0" />
          <stop offset=".52" stopColor="#2aa7b5" />
          <stop offset="1" stopColor="#0f7c86" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8fd8e0" stopOpacity=".28" />
          <stop offset="1" stopColor="#0f7c86" stopOpacity=".10" />
        </linearGradient>
        <filter id={`${id}b`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      {variant === 'rapid' ? (
        <>
          <rect x="2" y="2" width="60" height="60" rx="16" fill="#10283a" />
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
            <rect x="23" y="16" width="10" height="4" rx="2" fill="#8fd8e0" />
          </g>
          <rect x="23" y="16" width="10" height="4" rx="2" fill="#eef8fb" />
          <path
            d="M16 23.5h22V45H16z M38 28h9l8.5 8.5V45H38z"
            fill={g}
            stroke={g}
            strokeWidth="2.4"
            strokeLinejoin="round"
          />
          <path d="M41 31.2h4.8l5 5.2H41z" fill="#10283a" />
          <g fill="#eef8fb">
            <rect x="24.3" y="27.5" width="4.4" height="12.5" rx="1" />
            <rect x="20.2" y="31.6" width="12.6" height="4.4" rx="1" />
          </g>
          <g fill="#10283a" stroke="#eef8fb" strokeWidth="2">
            <circle cx="23.5" cy="46" r="4.6" />
            <circle cx="46" cy="46" r="4.6" />
          </g>
        </>
      ) : (
        <>
          <circle cx="32" cy="32" r="29" fill="#10283a" />
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
            stroke="#eef8fb"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={100}
            {...(animated ? { strokeDasharray: 100, className: 'animate-draw' } : {})}
          />
          <circle cx="57" cy="33.5" r="2.6" fill="#8fd8e0" />
        </>
      )}
    </svg>
  );
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center ${compact ? 'gap-2.5' : 'gap-3.5'}`}>
      <BrandLogo size={compact ? 44 : 68} animated={!compact} />
      <div className="leading-tight">
        <div
          className={`font-display font-semibold tracking-tight text-hub-ink ${
            compact ? 'text-[16px]' : 'text-xl'
          }`}
        >
          Healthcare <span className="text-hub-teal">Hub</span>
        </div>
        <div className="mt-0.5">
          <MadeBy compact={compact} />
        </div>
      </div>
    </div>
  );
}

/** Decorative, non-interactive hero art for the sign-in screens: a radar sweep and a heartbeat line. */
export function HeroArt() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(600px_380px_at_20%_0%,rgb(15_124_134/0.22),transparent_70%)]" />
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
            <stop offset="0" stopColor="#2aa7b5" stopOpacity="0.4" />
            <stop offset="1" stopColor="#2aa7b5" stopOpacity="0" />
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
        <circle cx="270" cy="118" r="4" fill="#8fd8e0" stroke="none" />
        <circle
          cx="270"
          cy="118"
          r="4"
          fill="#8fd8e0"
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
