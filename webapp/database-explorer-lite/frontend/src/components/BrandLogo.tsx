import React from 'react'

// Inline theme-aware brand mark: a molecule mid-assembly — three bonded atoms,
// with a fourth still condensing out of diffusion noise (dashed bond + scatter
// dots). Every hue derives from --color-accent via color-mix, so the logo
// re-tints itself per theme. Colors live in style={} (not attributes) because
// var()/color-mix only resolve in CSS contexts.
export default function BrandLogo({ className }: { className?: string }) {
  const accent = (pct: number, base: string) =>
    `color-mix(in srgb, var(--color-accent) ${pct}%, ${base})`

  return (
    <svg
      viewBox="0 0 64 64"
      width={28}
      height={28}
      className={className}
      role="img"
      aria-label="AutomaticMolCraft"
    >
      <defs>
        <linearGradient id="amc-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style={{ stopColor: accent(20, '#04060c') }} />
          <stop offset="52%" style={{ stopColor: accent(48, '#0a0f1a') }} />
          <stop offset="100%" style={{ stopColor: accent(78, '#101826') }} />
        </linearGradient>
        <radialGradient id="amc-logo-highlight" cx="28%" cy="22%" r="60%">
          <stop offset="0%" style={{ stopColor: accent(55, '#ffffff') }} stopOpacity="0.4" />
          <stop offset="100%" style={{ stopColor: '#000000' }} stopOpacity="0" />
        </radialGradient>
        {/* Atom spheres: lit top-left for depth */}
        <radialGradient id="amc-logo-atom" cx="35%" cy="30%" r="75%">
          <stop offset="0%" style={{ stopColor: accent(20, '#ffffff') }} />
          <stop offset="55%" style={{ stopColor: accent(60, '#ffffff') }} />
          <stop offset="100%" style={{ stopColor: accent(90, '#1a2233') }} />
        </radialGradient>
        <radialGradient id="amc-logo-atom-core" cx="35%" cy="30%" r="75%">
          <stop offset="0%" style={{ stopColor: '#ffffff' }} />
          <stop offset="50%" style={{ stopColor: accent(35, '#ffffff') }} />
          <stop offset="100%" style={{ stopColor: accent(80, '#ffffff') }} />
        </radialGradient>
      </defs>

      {/* Background tile */}
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#amc-logo-bg)" />
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#amc-logo-highlight)" />
      <rect
        x="2.75" y="2.75" width="58.5" height="58.5" rx="13.3" fill="none"
        stroke="rgba(255,255,255,0.13)" strokeWidth="1.5"
      />

      {/* Bonds (under atoms) */}
      <g strokeLinecap="round" fill="none">
        <path d="M30 35 L15.5 20.5" stroke="rgba(235,242,250,0.85)" strokeWidth="3.4" />
        <path d="M30 35 L21.5 50.5" stroke="rgba(235,242,250,0.85)" strokeWidth="3.4" />
        {/* Double bond hint on the lower edge */}
        <path d="M33.5 37.5 L26.9 49.4" stroke="rgba(235,242,250,0.4)" strokeWidth="2" />
        {/* Forming bond: dashed, fading toward the condensing atom */}
        <path
          d="M30 35 L46.5 21.5"
          style={{ stroke: accent(35, '#ffffff') }}
          strokeWidth="2.6" strokeDasharray="4 3.2" opacity="0.85"
        />
      </g>

      {/* Settled atoms */}
      <circle cx="15.5" cy="20.5" r="6" fill="url(#amc-logo-atom)" />
      <circle cx="21.5" cy="50.5" r="6.6" fill="url(#amc-logo-atom)" />
      {/* Central atom: brightest, slightly larger */}
      <circle cx="30" cy="35" r="8" fill="url(#amc-logo-atom-core)" />
      <circle cx="27.2" cy="32.2" r="2" fill="rgba(255,255,255,0.55)" />

      {/* Condensing atom: hollow dashed shell + bright nucleus, still forming */}
      <circle
        cx="46.5" cy="21.5" r="5.2" fill="none"
        style={{ stroke: accent(35, '#ffffff') }}
        strokeWidth="1.6" strokeDasharray="2.8 2.4"
      />
      <circle cx="46.5" cy="21.5" r="2" style={{ fill: accent(30, '#ffffff') }} />
      <g style={{ fill: accent(45, '#ffffff') }}>
        <circle cx="54.5" cy="14.5" r="1.9" opacity="0.75" />
        <circle cx="56.5" cy="24" r="1.4" opacity="0.55" />
        <circle cx="50" cy="10.5" r="1.2" opacity="0.5" />
        <circle cx="53.5" cy="31" r="1" opacity="0.4" />
        <circle cx="44" cy="11" r="0.9" opacity="0.35" />
        <circle cx="58" cy="18.5" r="0.8" opacity="0.3" />
      </g>

      {/* Faint orbit arc grounding the composition */}
      <path
        d="M10 47 A 26 14 0 0 0 55 40"
        fill="none"
        style={{ stroke: accent(30, 'transparent') }}
        strokeWidth="1"
        strokeDasharray="3 3"
      />
    </svg>
  )
}
