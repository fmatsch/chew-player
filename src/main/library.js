import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFile, selectCover } from 'music-metadata';
import { isAudioFile, extOf, IMAGE_EXTENSIONS, playbackMode } from './formats.js';
import { probeDuration } from './ffmpeg.js';
import * as online from './online.js';

const DB_VERSION = 1;
const TAG_FIELDS = ['title', 'artist', 'albumArtist', 'album', 'year', 'genre', 'trackNo', 'discNo'];
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'thumb'];

const normPath = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
export const trackId = (file) => createHash('sha1').update(normPath(file)).digest('hex').slice(0, 16);
const albumKey = (t) => `${(t.albumArtist || t.artist || '').toLowerCase()}\u0000${(t.album || '').toLowerCase()}`;
const isUnder = (file, root) => {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Classic "Artist/Album (Year)/01 - Title.ext" layout → best-effort tags when a file has none.
export function guessFromPath(file, root) {
  const guess = {};
  let base = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
  const num = /^(?:(\d)[-.])?(\d{1,3})(?:\s*[-.)]\s*|\s+)(.+)$/.exec(base);
  if (num) {
    guess.trackNo = parseInt(num[2], 10);
    if (num[1]) guess.discNo = parseInt(num[1], 10);
    base = num[3];
  }
  const dash = base.split(/\s+[-–]\s+/);
  if (dash.length >= 2) {
    guess.artist = dash[0].trim();
    guess.title = dash.slice(1).join(' - ').trim();
  } else {
    guess.title = base;
  }
  const dir = path.dirname(file);
  if (root && normPath(dir) !== normPath(root)) {
    let albumDir = path.basename(dir);
    if (/^(cd|disc|disk)\s*\d+$/i.test(albumDir)) albumDir = path.basename(path.dirname(dir));
    const year = /[([]\s*((?:19|20)\d{2})\s*[)\]]/.exec(albumDir) || /^((?:19|20)\d{2})\s*[-–.]\s*/.exec(albumDir);
    if (year) guess.year = Number(year[1]);
    guess.album = albumDir.replace(/[([]\s*(?:19|20)\d{2}\s*[)\]]/, '').replace(/^(?:19|20)\d{2}\s*[-–.]\s*/, '').trim();
    const parent = path.dirname(dir);
    if (!guess.artist && normPath(parent) !== normPath(root) && isUnder(parent, root)) {
      const dashAlbum = guess.album.split(/\s+[-–]\s+/);
      guess.artist = path.basename(parent);
      if (dashAlbum.length === 2 && dashAlbum[0].toLowerCase() === guess.artist.toLowerCase()) guess.album = dashAlbum[1];
    } else if (!guess.artist) {
      const dashAlbum = guess.album.split(/\s+[-–]\s+/);
      if (dashAlbum.length === 2) [guess.artist, guess.album] = dashAlbum.map((s) => s.trim());
    }
  }
  return guess;
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export class Library extends EventEmitter {
  constructor(dataDir, version) {
    super();
    this.dataDir = dataDir;
    this.dbFile = path.join(dataDir, 'library.json');
    this.coverDir = path.join(dataDir, 'covers');
    mkdirSync(this.coverDir, { recursive: true });
    online.setUserAgent(version);
    this.scanning = false;
    this.fetching = false;
    this.cancelFetch = false;
    this.folderCoverCache = new Map();
    this.data = this.load();
  }

  // ---------- persistence ----------

  load() {
    const empty = {
      version: DB_VERSION,
      settings: { folders: [], autoFetch: true, volume: 0.8, shuffle: false, repeat: 'off' },
      tracks: {},
      albums: {},
      playlists: [],
    };
    try {
      const data = JSON.parse(readFileSync(this.dbFile, 'utf8'));
      return { ...empty, ...data, settings: { ...empty.settings, ...data.settings } };
    } catch {
      return empty;
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    const tmp = `${this.dbFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data));
    await fs.rename(tmp, this.dbFile);
  }

  changed() {
    this.save();
    const now = Date.now();
    clearTimeout(this.changeTimer);
    // Throttle UI refreshes during long scans.
    if (now - (this.lastChange || 0) > 1500) {
      this.lastChange = now;
      this.emit('changed');
    } else {
      this.changeTimer = setTimeout(() => { this.lastChange = Date.now(); this.emit('changed'); }, 1500);
    }
  }

  // ---------- views for the renderer ----------

  // Tags from the file win; online results only fill gaps or replace guesses; user edits win over everything.
  view(t) {
    const v = { ...t };
    for (const f of TAG_FIELDS) {
      if (!t.online || t.online[f] == null) continue;
      if (v[f] == null || v[f] === '' || (f !== 'title' && t.guessed?.includes(f))) v[f] = t.online[f];
    }
    Object.assign(v, t.edits || {});
    const album = this.data.albums[albumKey(v)];
    v.cover = t.cover || album?.cover || null;
    delete v.online; delete v.edits; delete v.guessed;
    return v;
  }

  state() {
    return {
      settings: this.data.settings,
      tracks: Object.values(this.data.tracks).map((t) => this.view(t)),
      playlists: this.data.playlists,
      scanning: this.scanning,
      fetching: this.fetching,
    };
  }

  // Only serve artwork we put in our cover cache or found inside the user's music folders.
  isKnownCover(p) {
    if (!p || !IMAGE_EXTENSIONS.has(extOf(p))) return false;
    return isUnder(p, this.coverDir) || this.data.settings.folders.some((f) => isUnder(p, f))
      || Object.values(this.data.tracks).some((t) => t.cover === p);
  }

  // ---------- folders & scanning ----------

  addFolder(dir) {
    const folders = this.data.settings.folders;
    if (folders.some((f) => normPath(f) === normPath(dir))) return false;
    folders.push(dir);
    this.changed();
    return true;
  }

  removeFolder(dir) {
    this.data.settings.folders = this.data.settings.folders.filter((f) => normPath(f) !== normPath(dir));
    for (const [id, t] of Object.entries(this.data.tracks)) {
      if (!t.loose && !this.data.settings.folders.some((f) => isUnder(t.path, f))) delete this.data.tracks[id];
    }
    this.changed();
  }

  async walk(dir, out) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out);
      else if (e.isFile() && isAudioFile(e.name)) out.push(full);
    }
  }

  async folderCover(dir) {
    if (this.folderCoverCache.has(dir)) return this.folderCoverCache.get(dir);
    let found = null;
    try {
      const imgs = (await fs.readdir(dir)).filter((f) => IMAGE_EXTENSIONS.has(extOf(f)) && !f.startsWith('.'));
      const byName = (n) => imgs.find((f) => path.basename(f, path.extname(f)).toLowerCase().startsWith(n));
      const pick = COVER_NAMES.map(byName).find(Boolean) || (imgs.length === 1 ? imgs[0] : null);
      if (pick) found = path.join(dir, pick);
    } catch { /* unreadable */ }
    this.folderCoverCache.set(dir, found);
    return found;
  }

  async storeCover(data, type = 'image/jpeg') {
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
    const file = path.join(this.coverDir, `${createHash('sha1').update(data).digest('hex')}.${ext}`);
    if (!existsSync(file)) await fs.writeFile(file, data);
    return file;
  }

  async readTrack(file, root, stat) {
    const t = {
      id: trackId(file), path: file, root: root || null, folder: path.dirname(file),
      size: stat.size, mtime: stat.mtimeMs, format: extOf(file).toUpperCase(), added: Date.now(),
    };
    let meta = null;
    try {
      meta = await parseFile(file, { duration: false, skipCovers: false });
      if (!meta.format.duration && ['mp3', 'mp2'].includes(extOf(file))) meta = await parseFile(file, { duration: true });
    } catch { /* unsupported or broken — fall back to filename + FFmpeg */ }

    if (meta) {
      const c = meta.common;
      Object.assign(t, {
        title: c.title || null,
        artist: c.artist || (c.artists && c.artists.join(', ')) || null,
        albumArtist: c.albumartist || null,
        album: c.album || null,
        year: c.year || null,
        genre: c.genre?.[0] || null,
        trackNo: c.track?.no || null,
        discNo: c.disk?.no || null,
        duration: meta.format.duration || null,
        codec: meta.format.codec || null,
        bitrate: meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) : null,
        sampleRate: meta.format.sampleRate || null,
        bitsPerSample: meta.format.bitsPerSample || null,
        channels: meta.format.numberOfChannels || null,
        lossless: !!meta.format.lossless,
      });
      const pic = selectCover(c.picture);
      if (pic?.data?.length) t.cover = await this.storeCover(Buffer.from(pic.data), pic.format);
    }
    if (!t.duration) t.duration = await probeDuration(file);

    const guess = guessFromPath(file, root);
    t.guessed = [];
    for (const [k, v] of Object.entries(guess)) {
      if ((t[k] == null || t[k] === '') && v != null && v !== '') { t[k] = v; t.guessed.push(k); }
    }
    if (!t.cover) t.cover = await this.folderCover(t.folder);
    t.playback = playbackMode(file, t.codec || '');
    return t;
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    this.folderCoverCache.clear();
    this.emit('scan', { phase: 'walk', done: 0, total: 0 });
    try {
      const files = [];
      for (const root of this.data.settings.folders) {
        const before = files.length;
        await this.walk(root, files);
        for (let i = before; i < files.length; i++) files[i] = [files[i], root];
        this.emit('scan', { phase: 'walk', done: 0, total: files.length });
      }
      const seen = new Set();
      let done = 0;
      await pool(files, 4, async ([file, root]) => {
        const id = trackId(file);
        seen.add(id);
        try {
          const stat = await fs.stat(file);
          const old = this.data.tracks[id];
          if (!old || old.mtime !== stat.mtimeMs || old.size !== stat.size) {
            const t = await this.readTrack(file, root, stat);
            if (old) Object.assign(t, { online: old.online, edits: old.edits, added: old.added, lookedUp: old.lookedUp });
            this.data.tracks[id] = t;
            this.changed();
          } else if (!old.cover || !old.cover.startsWith(this.coverDir)) {
            old.cover = old.cover && existsSync(old.cover) ? old.cover : await this.folderCover(old.folder);
          }
        } catch { /* vanished mid-scan */ }
        if (++done % 25 === 0 || done === files.length) this.emit('scan', { phase: 'read', done, total: files.length });
      });
      for (const [id, t] of Object.entries(this.data.tracks)) {
        if (seen.has(id)) continue;
        if (t.loose && existsSync(t.path)) continue;
        delete this.data.tracks[id];
      }
    } finally {
      this.scanning = false;
      this.lastChange = 0;
      this.changed();
      this.emit('scan', { phase: 'done' });
    }
    if (this.data.settings.autoFetch) this.fetchMissing().catch((e) => this.emit('fetch', { phase: 'error', message: e.message }));
  }

  // Files opened via "Open with…" or dropped on the window that live outside the library folders.
  async addLoose(file) {
    const id = trackId(file);
    if (this.data.tracks[id]) return this.view(this.data.tracks[id]);
    const stat = await fs.stat(file);
    const root = this.data.settings.folders.find((f) => isUnder(file, f));
    const t = await this.readTrack(file, root || path.dirname(path.dirname(file)), stat);
    if (!root) t.loose = true;
    this.data.tracks[id] = t;
    this.lastChange = 0;
    this.changed();
    return this.view(t);
  }

  // ---------- online enrichment ----------

  needsLookup(t) {
    const v = this.view(t);
    return !v.album || !v.year || !v.artist || (t.guessed && t.guessed.length > 0) || !v.cover;
  }

  async fetchMissing(ids = null) {
    if (this.fetching) return;
    this.fetching = true;
    this.cancelFetch = false;
    const force = !!ids;
    const tracks = (ids ? ids.map((id) => this.data.tracks[id]).filter(Boolean)
      : Object.values(this.data.tracks).filter((t) => !t.lookedUp && this.needsLookup(t)));
    const total = tracks.length;
    let done = 0;
    let updated = 0;
    this.emit('fetch', { phase: 'start', done, total });
    try {
      // 1) tags per track
      for (const t of tracks) {
        if (this.cancelFetch) break;
        const v = this.view(t);
        const missingTags = !v.album || !v.year || !v.artist || (t.guessed?.length > 0);
        if ((missingTags || force) && v.title && v.artist) {
          try {
            const hit = await online.lookupRecording({ title: v.title, artist: v.artist, album: v.album });
            if (hit) {
              t.online = { ...hit };
              t.lookedUp = Date.now();
              updated++;
              this.changed();
            }
          } catch (e) {
            this.emit('fetch', { phase: 'error', message: e.message });
            if (/rate limiting/.test(e.message)) break;
            continue;
          }
        }
        t.lookedUp = t.lookedUp || Date.now();
        this.emit('fetch', { phase: 'tags', done: ++done, total });
      }

      // 2) one cover per album that still has none
      const albums = new Map();
      for (const t of tracks) {
        const v = this.view(t);
        if (v.cover || !v.album) continue;
        const key = albumKey(v);
        const entry = this.data.albums[key];
        if (entry?.cover || (entry?.lookedUp && !force)) continue;
        if (!albums.has(key)) albums.set(key, { v, online: t.online });
      }
      let n = 0;
      for (const [key, { v, online: o }] of albums) {
        if (this.cancelFetch) break;
        this.emit('fetch', { phase: 'covers', done: n++, total: albums.size });
        try {
          let img = o?.releaseId ? await online.fetchCover({ releaseId: o.releaseId, releaseGroupId: o.releaseGroupId }) : null;
          if (!img) {
            // No art for the matched edition — search the album by name and try its canonical release.
            const ids = await online.lookupRelease({ album: v.album, artist: v.albumArtist || v.artist });
            if (ids && ids.releaseId !== o?.releaseId) img = await online.fetchCover(ids);
          }
          this.data.albums[key] = { lookedUp: Date.now(), cover: img ? await this.storeCover(img.data, img.type) : null };
          if (img) { updated++; this.changed(); }
        } catch (e) {
          this.emit('fetch', { phase: 'error', message: e.message });
          if (/rate limiting/.test(e.message)) break;
        }
      }
    } finally {
      this.fetching = false;
      this.lastChange = 0;
      this.changed();
      this.emit('fetch', { phase: 'done', updated, cancelled: this.cancelFetch });
    }
  }

  // ---------- edits ----------

  editTracks(ids, edits) {
    const clean = {};
    for (const f of TAG_FIELDS) {
      if (!(f in edits)) continue;
      let val = edits[f];
      if (['year', 'trackNo', 'discNo'].includes(f)) val = val === '' || val == null ? null : parseInt(val, 10) || null;
      else val = val == null ? null : String(val).trim() || null;
      clean[f] = val;
    }
    for (const id of ids) {
      const t = this.data.tracks[id];
      if (t) t.edits = { ...(t.edits || {}), ...clean };
    }
    this.lastChange = 0;
    this.changed();
  }

  // ---------- playlists ----------

  playlist(id) { return this.data.playlists.find((p) => p.id === id); }

  createPlaylist(name, trackIds = []) {
    const p = { id: randomUUID(), name: name || 'New Playlist', trackIds: [...trackIds], created: Date.now() };
    this.data.playlists.push(p);
    this.lastChange = 0;
    this.changed();
    return p;
  }

  updatePlaylist(id, patch) {
    const p = this.playlist(id);
    if (!p) return;
    if (typeof patch.name === 'string') p.name = patch.name.trim() || p.name;
    if (Array.isArray(patch.trackIds)) p.trackIds = patch.trackIds;
    if (Array.isArray(patch.add)) p.trackIds.push(...patch.add);
    this.lastChange = 0;
    this.changed();
  }

  deletePlaylist(id) {
    this.data.playlists = this.data.playlists.filter((p) => p.id !== id);
    this.lastChange = 0;
    this.changed();
  }

  async exportM3U(id, file) {
    const p = this.playlist(id);
    const lines = ['#EXTM3U', `#PLAYLIST:${p.name}`];
    for (const tid of p.trackIds) {
      const t = this.data.tracks[tid];
      if (!t) continue;
      const v = this.view(t);
      lines.push(`#EXTINF:${Math.round(v.duration || -1)},${v.artist ? `${v.artist} - ` : ''}${v.title || ''}`, t.path);
    }
    await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  }

  async importM3U(file) {
    const text = await fs.readFile(file, 'utf8');
    const base = path.dirname(file);
    let name = path.basename(file, path.extname(file));
    const ids = [];
    let missing = 0;
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/^﻿/, '').trim();
      if (line.startsWith('#PLAYLIST:')) name = line.slice(10).trim() || name;
      if (!line || line.startsWith('#')) continue;
      if (/^file:\/\//i.test(line)) line = decodeURIComponent(new URL(line).pathname).replace(/^\/([A-Za-z]:)/, '$1');
      const abs = path.isAbsolute(line) ? line : path.resolve(base, line);
      const id = trackId(abs);
      if (this.data.tracks[id]) ids.push(id);
      else if (existsSync(abs) && isAudioFile(abs)) { await this.addLoose(abs); ids.push(id); }
      else missing++;
    }
    const p = this.createPlaylist(name, ids);
    return { playlist: p, missing };
  }
}
