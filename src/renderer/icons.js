// Flat 24×24 icon set, drawn inline so everything works offline.
const P = {
  note: '<path d="M9 18V5l11-2v13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="currentColor"/><circle cx="17" cy="16" r="3" fill="currentColor"/>',
  album: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" fill="currentColor"/>',
  queue: '<path d="M4 6h12M4 11h12M4 16h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15 14.5v6l5-3z" fill="currentColor"/>',
  playlist: '<path d="M4 6h11M4 11h11M4 16h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17 8v9.5" stroke="currentColor" stroke-width="2"/><circle cx="15" cy="17.5" r="2.5" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  gear: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  back: '<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  search: '<circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 16l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2" fill="currentColor"/>',
  next: '<path d="M5 5.2v13.6a.8.8 0 0 0 1.2.7l10-6.8a.8.8 0 0 0 0-1.4l-10-6.8a.8.8 0 0 0-1.2.7z" fill="currentColor"/><rect x="17" y="5" width="2.5" height="14" rx="1" fill="currentColor"/>',
  prev: '<path d="M19 5.2v13.6a.8.8 0 0 1-1.2.7l-10-6.8a.8.8 0 0 1 0-1.4l10-6.8a.8.8 0 0 1 1.2.7z" fill="currentColor"/><rect x="4.5" y="5" width="2.5" height="14" rx="1" fill="currentColor"/>',
  shuffle: '<path d="M3 7h3.5c2 0 3.2 1 4.3 2.7l2.4 4.6C14.3 16 15.5 17 17.5 17H21M3 17h3.5c1.4 0 2.4-.5 3.2-1.4M14.3 8.4c.8-.9 1.8-1.4 3.2-1.4H21M18 4l3 3-3 3M18 14l3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  repeat: '<path d="M4 11V9.5A2.5 2.5 0 0 1 6.5 7H20M17 4l3 3-3 3M20 13v1.5a2.5 2.5 0 0 1-2.5 2.5H4M7 20l-3-3 3-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  volume: '<path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.4 3.7a.8.8 0 0 0 1.3-.6V5.4a.8.8 0 0 0-1.3-.6L8 8.5H5a1 1 0 0 0-1 1z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  mute: '<path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.4 3.7a.8.8 0 0 0 1.3-.6V5.4a.8.8 0 0 0-1.3-.6L8 8.5H5a1 1 0 0 0-1 1z" fill="currentColor"/><path d="M17 9.5l5 5M22 9.5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  speaker: '<path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.4 3.7a.8.8 0 0 0 1.3-.6V5.4a.8.8 0 0 0-1.3-.6L8 8.5H5a1 1 0 0 0-1 1z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  globe: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.5 3.7 5.5 3.7 9s-1.2 6.5-3.7 9c-2.5-2.5-3.7-5.5-3.7-9S9.5 5.5 12 3z" fill="none" stroke="currentColor" stroke-width="2"/>',
  chevron: '<path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  up: '<path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
};

export const icon = (name) => `<i data-icon="${name}"><svg viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg></i>`;

// Fill every <i data-icon="…"> placeholder that is still empty.
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]:empty')) {
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${P[el.dataset.icon] || ''}</svg>`;
  }
}

export function setIcon(el, name) {
  const i = el.querySelector('i[data-icon]') || el;
  i.dataset.icon = name;
  i.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

export const noteMask = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${P.note.replace(/currentColor/g, '#000')}</svg>`)}")`;
