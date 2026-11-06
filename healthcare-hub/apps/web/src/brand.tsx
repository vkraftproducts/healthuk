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

/** Teal tile with a medical cross and motion lines (an ambulance service on the move). */
export function BrandLogo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
      <rect width="40" height="40" rx="10" fill="#0f7c86" />
      <rect x="20" y="9" width="7" height="22" rx="1.5" fill="#fff" />
      <rect x="12.5" y="16.5" width="22" height="7" rx="1.5" fill="#fff" />
      <g stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.85">
        <line x1="6" y1="14" x2="10" y2="14" />
        <line x1="4" y1="20" x2="10" y2="20" />
        <line x1="6" y1="26" x2="10" y2="26" />
      </g>
    </svg>
  );
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <div className="flex items-center gap-2.5">
        <BrandLogo size={32} />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold">{company || PRODUCT}</div>
          {company && <div className="text-xs text-slate-300">{PRODUCT}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      <BrandLogo size={44} />
      <div className="leading-tight">
        <div className="flex flex-wrap items-baseline gap-x-2 text-lg">
          <span className="font-semibold">{company || PRODUCT}</span>
          {company && (
            <>
              <span aria-hidden="true" className="text-slate-400">
                |
              </span>
              <span className="font-normal text-slate-200">{PRODUCT}</span>
            </>
          )}
        </div>
        {BRAND.legalName && <div className="text-sm text-slate-300">{BRAND.legalName}</div>}
      </div>
    </div>
  );
}
