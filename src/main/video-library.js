import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { VIDEO_EXTENSIONS, SUBTITLE_EXTENSIONS, probeVideo, videoPlayback, guessVideo, grabFrame, langName } from './video-probe.js';
import { IMAGE_EXTENSIONS, extOf } from './formats.js';
import * as online from './video-online.js';
import { mergeFolder } from './folders.js';

const normPath = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
export const videoId = (file) => `v${createHash('sha1').update(normPath(file)).digest('hex').slice(0, 15)}`;
const isUnder = (file, root) => {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const showKey = (name) => (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const EDIT_FIELDS = ['title', 'year', 'genre', 'show', 'season', 'episode', 'type'];
const POSTER_NAMES = ['poster', 'folder', 'cover', 'movie', 'show'];

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

export class VideoLibrary extends EventEmitter {
  constructor(dataDir, { autoFetch, watchFolders, lang }) {
    super();
    this.file = path.join(dataDir, 'video.json');
    this.thumbDir = path.join(dataDir, 'video-art');
    mkdirSync(this.thumbDir, { recursive: true });
    this.autoFetch = autoFetch;
    this.watchFolders = watchFolders;
    this.lang = lang;
    this.scanning = false;
    this.fetching = false;
    this.watchers = [];
    this.data = this.load();
  }

  load() {
    const empty = { version: 1, folders: [], items: {}, shows: {}, movies: {} };
    try { return { ...empty, ...JSON.parse(readFileSync(this.file, 'utf8')) }; } catch { return empty; }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data));
    await fs.rename(tmp, this.file);
  }

  changed(now = false) {
    this.save();
    clearTimeout(this.changeTimer);
    if (now || Date.now() - (this.lastChange || 0) > 1500) { this.lastChange = Date.now(); this.emit('changed'); } else {
      this.changeTimer = setTimeout(() => { this.lastChange = Date.now(); this.emit('changed'); }, 1500);
    }
  }

  // ---------------------------------------------------------------- views

  // Guess from the file name < online info < the user's own edits.
  view(it) {
    const v = { ...it.guess, ...it };
    const e = it.edits || {};
    const type = e.type || it.guess?.type;
    v.type = type;
    if (type === 'episode') {
      v.show = e.show || it.guess?.show;
      v.season = e.season ?? it.guess?.season;
      v.episode = e.episode ?? it.guess?.episode;
      const show = this.data.shows[showKey(v.show)];
      if (show?.name && !e.show) v.show = show.name;
      const ep = show?.episodes?.[`${v.season}:${v.episode}`];
      v.title = e.title || ep?.name || it.guess?.epTitle || `Episode ${v.episode}`;
      v.summary = ep?.summary || null;
      v.year = e.year || (ep?.airdate ? Number(ep.airdate.slice(0, 4)) : show?.year) || null;
      v.genre = e.genre || show?.genres?.[0] || null;
      v.poster = it.localPoster || show?.poster || null;
      v.still = show?.stills?.[`${v.season}:${v.episode}`] || it.thumb || null;
      v.showSummary = show?.summary || null;
    } else {
      const m = this.data.movies[it.id] || {};
      v.title = e.title || m.title || it.guess?.title;
      v.year = e.year || m.year || it.guess?.year || null;
      v.genre = e.genre || m.genre || null;
      v.summary = m.summary || null;
      v.director = m.director || null;
      v.poster = it.localPoster || m.poster || null;
      v.still = it.thumb || null;
    }
    v.format = path.extname(it.path).slice(1).toUpperCase();
    v.inProgress = !!(it.position > 30 && !it.watched);
    delete v.guess; delete v.edits;
    return v;
  }

  state() {
    return {
      folders: this.data.folders,
      items: Object.values(this.data.items).map((it) => this.view(it)),
      scanning: this.scanning,
      fetching: this.fetching,
    };
  }

  isKnownFile(p) {
    return isUnder(p, this.thumbDir) || this.data.folders.some((f) => isUnder(p, f));
  }

  // ---------------------------------------------------------------- folders

  addFolder(dir) {
    const { result, list } = mergeFolder(this.data.folders, dir);
    if (result !== 'added') return result;
    this.data.folders = list;
    this.changed(true);
    this.watch();
    return result;
  }

  removeFolder(dir) {
    this.data.folders = this.data.folders.filter((f) => normPath(f) !== normPath(dir));
    for (const [id, it] of Object.entries(this.data.items)) {
      if (!this.data.folders.some((f) => isUnder(it.path, f))) delete this.data.items[id];
    }
    this.changed(true);
    this.watch();
  }

  watch() {
    this.unwatch();
    if (!this.watchFolders()) return;
    for (const root of this.data.folders) {
      try {
        const w = fsWatch(root, { recursive: true }, (_ev, file) => {
          const name = file ? path.basename(String(file)) : '';
          if (name.startsWith('.')) return;
          const ext = extOf(name);
          if (name && ext && !VIDEO_EXTENSIONS.has(ext) && !SUBTITLE_EXTENSIONS.has(ext) && !IMAGE_EXTENSIONS.has(ext)) return;
          clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => this.scan(), 4000);
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch { /* not watchable */ }
    }
  }

  unwatch() {
    clearTimeout(this.watchTimer);
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
  }

  // ---------------------------------------------------------------- scanning

  async walk(dir, out) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(extras?|featurettes|behind the scenes|deleted scenes|trailers?|samples?)$/i.test(e.name)) continue;
        await this.walk(full, out);
      } else if (e.isFile() && VIDEO_EXTENSIONS.has(extOf(e.name)) && !/[-._ ]sample$/i.test(path.basename(e.name, path.extname(e.name)))) out.push(full);
    }
  }

  // Sidecar files: subtitles named like the video (Movie.srt, Movie.en.srt, Movie.German.forced.srt) and posters.
  async sidecars(file) {
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file)).toLowerCase();
    let names = [];
    try { names = await fs.readdir(dir); } catch { /* ignore */ }
    const subs = [];
    let poster = null;
    const videosHere = names.filter((n) => VIDEO_EXTENSIONS.has(extOf(n))).length;
    for (const n of names) {
      const ext = extOf(n);
      const stem = path.basename(n, path.extname(n)).toLowerCase();
      if (SUBTITLE_EXTENSIONS.has(ext) && ext !== 'sub' && (stem === base || stem.startsWith(`${base}.`) || (videosHere === 1 && !n.startsWith('.')))) {
        const tag = stem.startsWith(`${base}.`) ? stem.slice(base.length + 1) : '';
        const lang = tag.split('.').find((t) => /^[a-z]{2,3}$/.test(t)) || tag.split('.').find((t) => t && t !== 'forced' && t !== 'sdh') || null;
        subs.push({ path: path.join(dir, n), lang, forced: /forced/.test(tag), title: tag ? null : 'External' });
      }
      if (IMAGE_EXTENSIONS.has(ext)) {
        const isOwn = stem === base || stem === `${base}-poster`;
        const isFolder = videosHere === 1 && POSTER_NAMES.some((p) => stem === p || stem === `${p}-poster`);
        if (isOwn || (isFolder && !poster)) poster = path.join(dir, n);
      }
    }
    return { subs, poster };
  }

  async readItem(file, root, stat, old) {
    const info = await probeVideo(file);
    const side = await this.sidecars(file);
    const it = {
      id: videoId(file), path: file, root, folder: path.dirname(file), size: stat.size, mtime: stat.mtimeMs,
      added: old?.added || Date.now(),
      duration: info?.duration || null, width: info?.width || null, height: info?.height || null,
      vcodec: info?.vcodec || null, acodec: info?.acodec || null,
      audio: (info?.audio || []).map((a) => ({ ...a, label: [a.title, langName(a.lang), a.codec?.toUpperCase(), a.channels].filter(Boolean).join(' · ') || `Track ${a.index + 1}` })),
      subs: [
        ...(info?.subs || []).filter((sb) => sb.text).map((sb) => ({ kind: 'embedded', index: sb.index, lang: sb.lang, forced: sb.forced, label: [sb.title, langName(sb.lang), sb.forced ? 'Forced' : ''].filter(Boolean).join(' · ') || `Subtitle ${sb.index + 1}` })),
        ...side.subs.map((sb) => ({ kind: 'external', path: sb.path, lang: sb.lang, forced: sb.forced, label: [langName(sb.lang) || sb.lang, sb.forced ? 'Forced' : '', 'External'].filter(Boolean).join(' · ') })),
      ],
      playback: videoPlayback(file, info),
      guess: guessVideo(file, root),
      localPoster: side.poster,
      // keep what the user did with this file
      edits: old?.edits, position: old?.position || 0, watched: old?.watched || false, plays: old?.plays || 0,
      lastPlayed: old?.lastPlayed || null, thumb: old?.thumb && existsSync(old.thumb) ? old.thumb : null, lookedUp: old?.lookedUp,
    };
    return it;
  }

  async scan() {
    if (this.scanning) { this.rescanPending = true; return; }
    this.scanning = true;
    this.rescanPending = false;
    this.emit('scan', { phase: 'walk', done: 0, total: 0 });
    try {
      const files = [];
      for (const root of this.data.folders) {
        const start = files.length;
        await this.walk(root, files);
        for (let i = start; i < files.length; i++) files[i] = [files[i], root];
      }
      const seen = new Set();
      let done = 0;
      await pool(files, 3, async ([file, root]) => {
        const id = videoId(file);
        seen.add(id);
        try {
          const stat = await fs.stat(file);
          const old = this.data.items[id];
          if (!old || old.mtime !== stat.mtimeMs || old.size !== stat.size) {
            this.data.items[id] = await this.readItem(file, root, stat, old);
            this.changed();
          } else {
            // Sidecar subtitles/posters may have been added without the video changing.
            const side = await this.sidecars(file);
            old.localPoster = side.poster;
            const ext = side.subs.map((sb) => ({ kind: 'external', path: sb.path, lang: sb.lang, forced: sb.forced, label: [langName(sb.lang) || sb.lang, sb.forced ? 'Forced' : '', 'External'].filter(Boolean).join(' · ') }));
            old.subs = [...(old.subs || []).filter((sb) => sb.kind === 'embedded'), ...ext];
          }
        } catch { /* vanished */ }
        if (++done % 10 === 0 || done === files.length) this.emit('scan', { phase: 'read', done, total: files.length });
      });
      for (const id of Object.keys(this.data.items)) if (!seen.has(id)) delete this.data.items[id];
    } finally {
      this.scanning = false;
      this.changed(true);
      this.emit('scan', { phase: 'done' });
    }
    if (this.rescanPending) { this.scan(); return; }
    this.makeThumbs().then(() => {
      if (this.autoFetch()) this.fetchMissing().catch((e) => this.emit('fetch', { phase: 'error', message: e.message }));
    });
  }

  // A frame from ~10 % into the video as a fallback picture.
  async makeThumbs() {
    const todo = Object.values(this.data.items).filter((it) => !it.thumb && it.vcodec);
    await pool(todo, 2, async (it) => {
      const out = path.join(this.thumbDir, `${it.id}.jpg`);
      const at = it.duration ? Math.min(Math.max(it.duration * 0.1, 1), 300) : 5;
      if (await grabFrame(it.path, at, out)) { it.thumb = out; this.changed(); }
    });
  }

  async storeImage(url, name) {
    try {
      const img = await online.download(url);
      if (!img) return null;
      const ext = img.type.includes('png') ? 'png' : img.type.includes('webp') ? 'webp' : 'jpg';
      const file = path.join(this.thumbDir, `${name}.${ext}`);
      await fs.writeFile(file, img.data);
      return file;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- online info

  async fetchMissing(ids = null) {
    if (this.fetching) return;
    this.fetching = true;
    const force = !!ids;
    const items = ids ? ids.map((id) => this.data.items[id]).filter(Boolean) : Object.values(this.data.items);
    const shows = new Map();
    const movies = [];
    for (const it of items) {
      const v = this.view(it);
      if (v.type === 'episode') {
        const key = showKey(v.show);
        if (force || !this.data.shows[key]?.lookedUp) shows.set(key, v.show);
      } else if (force || !it.lookedUp) movies.push(it);
    }
    const total = shows.size + movies.length;
    let done = 0;
    let updated = 0;
    this.emit('fetch', { phase: 'start', done, total });
    try {
      for (const [key, name] of shows) {
        try {
          const s = await online.lookupShow(name);
          const entry = { lookedUp: Date.now() };
          if (s) {
            Object.assign(entry, { name: s.name, year: s.year, genres: s.genres, summary: s.summary, episodes: s.episodes, tvmazeId: s.tvmazeId });
            if (s.image) entry.poster = await this.storeImage(s.image, `show-${s.tvmazeId}`);
            // Episode stills only for episodes we actually have.
            entry.stills = {};
            for (const it of Object.values(this.data.items)) {
              const v = this.view(it);
              if (v.type !== 'episode' || showKey(v.show) !== key && showKey(v.show) !== showKey(s.name)) continue;
              const ep = s.episodes[`${v.season}:${v.episode}`];
              if (ep?.image) entry.stills[`${v.season}:${v.episode}`] = await this.storeImage(ep.image, `ep-${s.tvmazeId}-${v.season}-${v.episode}`);
            }
            updated++;
          }
          this.data.shows[key] = entry;
          this.changed();
        } catch (e) { this.emit('fetch', { phase: 'error', message: e.message }); }
        this.emit('fetch', { phase: 'tags', done: ++done, total });
      }
      for (const it of movies) {
        try {
          const g = it.edits?.title ? { title: it.edits.title, year: it.edits.year } : it.guess;
          const m = await online.lookupMovie(g.title, g.year, this.lang());
          it.lookedUp = Date.now();
          if (m) {
            const poster = m.image ? await this.storeImage(m.image, `movie-${m.wikidataId}`) : null;
            this.data.movies[it.id] = { ...m, poster };
            updated++;
          }
          this.changed();
        } catch (e) { this.emit('fetch', { phase: 'error', message: e.message }); }
        this.emit('fetch', { phase: 'tags', done: ++done, total });
      }
    } finally {
      this.fetching = false;
      this.changed(true);
      this.emit('fetch', { phase: 'done', updated });
    }
  }

  // ---------------------------------------------------------------- user actions

  progress(id, position, duration) {
    const it = this.data.items[id];
    if (!it) return;
    const d = duration || it.duration || 0;
    it.lastPlayed = Date.now();
    if (d && position / d > 0.92) {
      if (!it.watched) it.plays = (it.plays || 0) + 1;
      it.watched = true;
      it.position = 0;
    } else {
      it.position = position;
    }
    this.changed();
  }

  setWatched(ids, watched) {
    for (const id of ids) {
      const it = this.data.items[id];
      if (!it) continue;
      it.watched = watched;
      it.position = 0;
      if (watched) { it.plays = Math.max(1, it.plays || 0); it.lastPlayed = it.lastPlayed || Date.now(); }
    }
    this.changed(true);
  }

  edit(ids, edits) {
    for (const id of ids) {
      const it = this.data.items[id];
      if (!it) continue;
      const clean = {};
      for (const f of EDIT_FIELDS) {
        if (!(f in edits)) continue;
        let val = edits[f];
        if (['year', 'season', 'episode'].includes(f)) val = val === '' || val == null ? null : parseInt(val, 10) || null;
        else val = val == null ? null : String(val).trim() || null;
        clean[f] = val;
      }
      it.edits = { ...(it.edits || {}), ...clean };
      if ('title' in clean || 'year' in clean) it.lookedUp = null;
    }
    this.changed(true);
  }
}
