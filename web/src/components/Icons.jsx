const base = {
  className: 'nc-icon',
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export const Search = (p) => (
  <svg {...base} {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </svg>
)

export const Close = (p) => (
  <svg {...base} {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
)

export const Pin = ({ filled, ...p }) => (
  <svg {...base} {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M6 1.8h4l-.6 3.4 2.2 2.1H4.4l2.2-2.1z" />
    <path d="M8 7.3V14" />
  </svg>
)

export const Image = (p) => (
  <svg {...base} {...p}>
    <rect x="1.8" y="3" width="12.4" height="10" rx="2" />
    <circle cx="5.6" cy="6.4" r="1.1" />
    <path d="M2.4 11.4 6 8.4l2.6 2.2L10.8 9l2.9 2.6" />
  </svg>
)

export const Text = (p) => (
  <svg {...base} {...p}>
    <path d="M3 3.5h10M3 8h10M3 12.5h6" />
  </svg>
)

export const Link = (p) => (
  <svg {...base} {...p}>
    <path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
    <path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
  </svg>
)

export const Braces = (p) => (
  <svg {...base} {...p}>
    <path d="M6.2 2.5c-1.6 0-1.8.9-1.8 2.2 0 1.1-.3 2-1.4 2.2v.2c1.1.2 1.4 1.1 1.4 2.2 0 1.3.2 2.2 1.8 2.2" />
    <path d="M9.8 2.5c1.6 0 1.8.9 1.8 2.2 0 1.1.3 2 1.4 2.2v.2c-1.1.2-1.4 1.1-1.4 2.2 0 1.3-.2 2.2-1.8 2.2" />
  </svg>
)

export const Download = (p) => (
  <svg {...base} {...p}>
    <path d="M8 2v8" />
    <path d="M4.8 7 8 10.2 11.2 7" />
    <path d="M2.8 13.2h10.4" />
  </svg>
)

export const Copy = (p) => (
  <svg {...base} {...p}>
    <rect x="5.2" y="5.2" width="8" height="8" rx="1.8" />
    <path d="M10.6 5.2V4a1.8 1.8 0 0 0-1.8-1.8H4.4A1.8 1.8 0 0 0 2.6 4v4.4A1.8 1.8 0 0 0 4.4 10.2h1.2" />
  </svg>
)

export const Trash = (p) => (
  <svg {...base} {...p}>
    <path d="M2.6 4.2h10.8" />
    <path d="M6 4.2V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.2" />
    <path d="M4 4.2 4.6 13a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4.2" />
  </svg>
)

export const Qr = (p) => (
  <svg {...base} {...p}>
    <rect x="2" y="2" width="4.6" height="4.6" rx="1" />
    <rect x="9.4" y="2" width="4.6" height="4.6" rx="1" />
    <rect x="2" y="9.4" width="4.6" height="4.6" rx="1" />
    <path d="M9.4 9.4h2v2h-2zM12.6 12.6h1.4M9.4 14h1.4" />
  </svg>
)

export const More = (p) => (
  <svg {...base} {...p}>
    <circle cx="3.4" cy="8" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="12.6" cy="8" r="1.05" fill="currentColor" stroke="none" />
  </svg>
)

export const Plus = (p) => (
  <svg {...base} {...p} strokeWidth={1.9}>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </svg>
)

export const External = (p) => (
  <svg {...base} {...p}>
    <path d="M9.2 2.6H13.4V6.8" />
    <path d="M13.4 2.6 7.8 8.2" />
    <path d="M12.2 9.6v2.8a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4V5.2a1.4 1.4 0 0 1 1.4-1.4h2.8" />
  </svg>
)

export const Camera = (p) => (
  <svg {...base} {...p}>
    <path d="M2 6.2a1.6 1.6 0 0 1 1.6-1.6h1L5.4 3h5.2l.8 1.6h1A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4z" />
    <circle cx="8" cy="8.6" r="2.4" />
  </svg>
)

export const Expand = (p) => (
  <svg {...base} {...p}>
    <path d="M4.6 6.4 8 9.8l3.4-3.4" />
  </svg>
)
