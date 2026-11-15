/**
 * Crisp inline SVG icon helpers and the bespoke Al-Fayed Tourism luxury crest.
 * Decorative icons always set aria-hidden="true".
 */

export function brandCrestSvg(uid = 'hdr') {
  return `
    <svg width="32" height="32" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="afy-gold-${uid}" x1="12" y1="10" x2="52" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#F7DC98"/>
          <stop offset="50%" stop-color="#D4A449"/>
          <stop offset="100%" stop-color="#A87822"/>
        </linearGradient>
        <linearGradient id="afy-teal-${uid}" x1="18" y1="44" x2="48" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#2DD4BF"/>
          <stop offset="100%" stop-color="#99F6E4"/>
        </linearGradient>
      </defs>
      <path d="M32 9.5L47.9 16.1L54.5 32L47.9 47.9L32 54.5L16.1 47.9L9.5 32L16.1 16.1L32 9.5Z" stroke="url(#afy-gold-${uid})" stroke-width="2.6" stroke-linejoin="round"/>
      <path d="M21 44V28.5C21 21.8 26.2 16 32 14C37.8 16 43 21.8 43 28.5V44" stroke="url(#afy-gold-${uid})" stroke-opacity="0.65" stroke-width="2" stroke-linecap="round"/>
      <path d="M16.5 38.5C23.5 36.2 31.5 30.8 43.8 20.5" stroke="url(#afy-teal-${uid})" stroke-width="3.6" stroke-linecap="round"/>
      <path d="M44.5 19.8L35.2 21.2L39.6 25.1L41.8 29.8L44.5 19.8Z" fill="url(#afy-teal-${uid})"/>
      <circle cx="21" cy="39.2" r="3.4" fill="url(#afy-gold-${uid})"/>
      <path d="M32 19L33.6 22.8L37.4 24.4L33.6 26L32 29.8L30.4 26L26.6 24.4L30.4 22.8L32 19Z" fill="url(#afy-gold-${uid})"/>
    </svg>
  `;
}

const PATHS = {
  hotel: '<path d="M3 21h18M5 21V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14M15 21V11h4a2 2 0 0 1 2 2v8M9 9h2M9 13h2M9 17h2"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor" stroke="none"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  sliders: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  compare: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  heartFill: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" fill="currentColor"/>',
  passport: '<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M8 17h8"/>',
  bed: '<path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9"/>',
  luggage: '<path d="M6 20h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M8 10v6M16 10v6"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
};

export function iconSvg(name, size = 18) {
  const path = PATHS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
