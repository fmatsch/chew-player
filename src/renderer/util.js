// Small helpers shared by the music and video parts of the UI.

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
export const coverUrl = (p) => `chew://cover/?p=${encodeURIComponent(p).replace(/'/g, '%27')}`;
export const coverDiv = (p, cls = '') => `<div class="cover ${p ? '' : 'empty'} ${cls}"${p ? ` style="background-image:url('${coverUrl(p)}')"` : ''}></div>`;
export const sortName = (s) => (s || '').replace(/^the\s+/i, '');

export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3200);
}

// A flex column wrapper for a view's content.
export function el(html) {
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0';
  d.innerHTML = html;
  return d;
}

export const stars = (n, interactive = true) => `<span class="stars${interactive ? ' rate' : ''}">${[1, 2, 3, 4, 5].map((i) => `<span data-star="${i}" class="${i <= (n || 0) ? 'on' : ''}">★</span>`).join('')}</span>`;
