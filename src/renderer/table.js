import { icon, hydrateIcons } from './icons.js';

export const fmtTime = (s) => {
  if (!s || !Number.isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const COLUMNS = {
  num: { label: '#', width: '44px', cell: (t, i) => (t.trackNo ?? '') || '', sortKey: 'trackNo' },
  index: { label: '#', width: '44px', cell: (t, i) => i + 1 },
  title: { label: 'Title', width: 'minmax(140px, 2.2fr)', cell: (t) => esc(t.title), sortKey: 'title' },
  artist: { label: 'Artist', width: 'minmax(100px, 1.4fr)', cell: (t) => esc(t.artist), sortKey: 'artist' },
  album: { label: 'Album', width: 'minmax(100px, 1.4fr)', cell: (t) => esc(t.album), sortKey: 'album' },
  year: { label: 'Year', width: '52px', cell: (t) => t.year || '', sortKey: 'year' },
  genre: { label: 'Genre', width: 'minmax(70px, 0.7fr)', cell: (t) => esc(t.genre), sortKey: 'genre' },
  time: { label: 'Time', width: '56px', cell: (t) => fmtTime(t.duration), sortKey: 'duration' },
  format: { label: 'Format', width: '60px', cell: (t) => esc(t.format), sortKey: 'format' },
};

// Virtualised track list: only the visible rows exist in the DOM, so 50k tracks stay smooth.
export class TrackTable {
  constructor({ columns, tracks, sort, onSort, onPlay, onContext, onReorder, onDelete, isPlaying, dragType = 'tracks' }) {
    this.columns = columns;
    this.tracks = tracks;
    this.sort = sort;
    this.onSort = onSort;
    this.onPlay = onPlay;
    this.onContext = onContext;
    this.onReorder = onReorder;
    this.onDelete = onDelete;
    this.isPlaying = isPlaying || (() => false);
    this.selected = new Set();
    this.anchor = null;
    this.rowH = 32;

    this.el = document.createElement('div');
    this.el.className = 'table';
    this.el.style.setProperty('--cols', columns.map((c) => COLUMNS[c].width).join(' '));
    this.head = document.createElement('div');
    this.head.className = 'table-head';
    this.body = document.createElement('div');
    this.body.className = 'table-body';
    this.body.tabIndex = 0;
    this.spacer = document.createElement('div');
    this.spacer.className = 'table-spacer';
    this.body.append(this.spacer);
    this.el.append(this.head, this.body);
    this.renderHead();

    this.body.addEventListener('scroll', () => this.schedule());
    new ResizeObserver(() => this.schedule()).observe(this.body);
    this.bindEvents(dragType);
    this.setTracks(tracks);
  }

  renderHead() {
    this.head.innerHTML = this.columns.map((c) => {
      const col = COLUMNS[c];
      const sortable = this.onSort && col.sortKey;
      const sorted = sortable && this.sort?.key === col.sortKey;
      return `<div class="c-${c} ${sortable ? 'sortable' : ''} ${sorted ? 'sorted' : ''}" data-sort="${sortable ? col.sortKey : ''}">${col.label}${sorted ? icon(this.sort.dir > 0 ? 'up' : 'down') : ''}</div>`;
    }).join('');
    for (const i of this.head.querySelectorAll('i')) { i.style.width = '12px'; i.style.height = '12px'; }
  }

  setTracks(tracks) {
    this.tracks = tracks;
    const ids = new Set(tracks.map((t) => t.id));
    for (const id of this.selected) if (!ids.has(id)) this.selected.delete(id);
    this.spacer.style.height = `${tracks.length * this.rowH}px`;
    this.rendered = null;
    this.schedule();
  }

  refresh() { this.rendered = null; this.schedule(); }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.renderRows(); });
  }

  renderRows() {
    const top = this.body.scrollTop;
    const h = this.body.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / this.rowH) - 8);
    const last = Math.min(this.tracks.length, Math.ceil((top + h) / this.rowH) + 8);
    const key = `${first}:${last}`;
    if (this.rendered === key) return;
    this.rendered = key;
    let html = '';
    for (let i = first; i < last; i++) {
      const t = this.tracks[i];
      const playing = this.isPlaying(t, i);
      const cls = `row${this.selected.has(t.id) ? ' selected' : ''}${playing ? ' playing' : ''}`;
      html += `<div class="${cls}" data-i="${i}" draggable="true" style="top:${i * this.rowH}px">`;
      for (const c of this.columns) {
        let v = COLUMNS[c].cell(t, i);
        if (playing && (c === 'num' || c === 'index')) v = icon('speaker');
        if (c === 'title' && t.missing) html += `<div class="c-title missing">${v || 'Missing file'}</div>`;
        else html += `<div class="c-${c}">${v}</div>`;
      }
      html += '</div>';
    }
    this.spacer.innerHTML = html;
    hydrateIcons(this.spacer);
  }

  rowIndex(e) {
    const row = e.target.closest('.row');
    return row ? Number(row.dataset.i) : -1;
  }

  selectedIds() { return this.tracks.filter((t) => this.selected.has(t.id)).map((t) => t.id); }
  selectedIndices() { return this.tracks.map((t, i) => (this.selected.has(t.id) ? i : -1)).filter((i) => i >= 0); }

  select(i, e = {}) {
    const t = this.tracks[i];
    if (!t) return;
    if (e.shiftKey && this.anchor != null) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      if (!(e.metaKey || e.ctrlKey)) this.selected.clear();
      for (let k = a; k <= b; k++) this.selected.add(this.tracks[k].id);
    } else if (e.metaKey || e.ctrlKey) {
      if (this.selected.has(t.id)) this.selected.delete(t.id); else this.selected.add(t.id);
      this.anchor = i;
    } else {
      this.selected.clear();
      this.selected.add(t.id);
      this.anchor = i;
    }
    this.refresh();
  }

  scrollTo(i) {
    const y = i * this.rowH;
    if (y < this.body.scrollTop) this.body.scrollTop = y;
    else if (y + this.rowH > this.body.scrollTop + this.body.clientHeight) this.body.scrollTop = y + this.rowH - this.body.clientHeight;
  }

  bindEvents(dragType) {
    this.head.addEventListener('click', (e) => {
      const key = e.target.closest('[data-sort]')?.dataset.sort;
      if (!key) return;
      const dir = this.sort?.key === key ? -this.sort.dir : 1;
      this.onSort({ key, dir });
    });
    this.body.addEventListener('mousedown', (e) => {
      const i = this.rowIndex(e);
      if (i < 0) { if (e.button === 0) { this.selected.clear(); this.refresh(); } return; }
      if (e.button === 2 && this.selected.has(this.tracks[i].id)) return;
      // Keep a multi-selection intact when the user starts dragging it.
      if (e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey && this.selected.has(this.tracks[i].id) && this.selected.size > 1) {
        this.pendingSelect = i;
        return;
      }
      this.select(i, e);
    });
    this.body.addEventListener('click', (e) => {
      if (this.pendingSelect != null) { this.select(this.pendingSelect); this.pendingSelect = null; }
    });
    this.body.addEventListener('dblclick', (e) => {
      const i = this.rowIndex(e);
      if (i >= 0) this.onPlay?.(i);
    });
    this.body.addEventListener('contextmenu', (e) => {
      const i = this.rowIndex(e);
      if (i < 0) return;
      e.preventDefault();
      this.onContext?.(this.selectedIds(), i);
    });
    this.body.addEventListener('keydown', (e) => {
      const sel = this.selectedIndices();
      const cur = sel.length ? sel[sel.length - 1] : -1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = Math.max(0, Math.min(this.tracks.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
        this.select(i, { shiftKey: e.shiftKey });
        this.scrollTo(i);
      } else if (e.key === 'Enter' && cur >= 0) {
        e.preventDefault();
        this.onPlay?.(sel[0]);
      } else if ((e.key === 'a') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        for (const t of this.tracks) this.selected.add(t.id);
        this.refresh();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.onDelete && sel.length) {
        e.preventDefault();
        this.onDelete(sel);
      }
    });

    // Drag rows out (to playlists) and — when reorderable — within the table.
    this.body.addEventListener('dragstart', (e) => {
      const i = this.rowIndex(e);
      if (i < 0) return;
      this.pendingSelect = null;
      if (!this.selected.has(this.tracks[i].id)) this.select(i);
      const ids = this.selectedIds();
      this.dragIndices = this.selectedIndices();
      e.dataTransfer.setData('application/x-chew-tracks', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'copyMove';
      const ghost = document.createElement('div');
      ghost.textContent = ids.length === 1 ? this.tracks[i].title : `${ids.length} songs`;
      Object.assign(ghost.style, { position: 'fixed', top: '-100px', padding: '6px 12px', background: '#ff4f7b', color: '#fff', borderRadius: '6px', font: '600 12px sans-serif' });
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    });
    if (this.onReorder) {
      const clear = () => this.spacer.querySelectorAll('.drop-before,.drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
      this.body.addEventListener('dragover', (e) => {
        if (!this.dragIndices) return;
        e.preventDefault();
        clear();
        const row = e.target.closest('.row');
        if (!row) return;
        const after = e.clientY - row.getBoundingClientRect().top > this.rowH / 2;
        row.classList.add(after ? 'drop-after' : 'drop-before');
        this.dropAt = Number(row.dataset.i) + (after ? 1 : 0);
      });
      this.body.addEventListener('dragleave', clear);
      this.body.addEventListener('drop', (e) => {
        if (!this.dragIndices) return;
        e.preventDefault();
        clear();
        if (this.dropAt != null) this.onReorder(this.dragIndices, this.dropAt);
      });
    }
    this.body.addEventListener('dragend', () => { this.dragIndices = null; this.dropAt = null; });
  }
}
