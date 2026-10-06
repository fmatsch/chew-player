import { icon, hydrateIcons, setIcon, noteMask } from './icons.js';
import { Player } from './player.js';
import { TrackTable, fmtTime } from './table.js';
import { $, esc, collator, plural, coverUrl, coverDiv, sortName, toast, el } from './util.js';
import { evaluate, describe, editSmart } from './smart.js';
import { initVideo } from './video.js';

const chew = window.chew;
const S = {
  tracks: [],
  byId: new Map(),
  playlists: [],
  settings: {},
  info: { platform: 'darwin', ffmpeg: false },
  albums: [],
  albumByKey: new Map(),
  artists: [],
  view: 'songs',
  param: null,
  devices: [],
  update: null,
  history: [],
  search: '',
  sort: { key: 'artist', dir: 1 },
  current: null,
  table: null,
};

const player = new Player({ getTrack: (id) => S.byId.get(id), ffmpeg: false });

// ---------------------------------------------------------------- data

function buildIndex() {
  S.byId = new Map(S.tracks.map((t) => [t.id, t]));
  for (const t of S.tracks) {
    t._s = [t.title, t.artist, t.album, t.albumArtist, t.genre, t.year, t.format].filter(Boolean).join(' ').toLowerCase();
  }
  const sep = S.info.platform === 'win32' ? '\\' : '/';
  const albums = new Map();
  for (const t of S.tracks) {
    let folder = t.folder || '';
    const base = folder.slice(folder.lastIndexOf(sep) + 1);
    if (/^(cd|disc|disk)\s*\d+$/i.test(base)) folder = folder.slice(0, folder.lastIndexOf(sep));
    const title = t.album || 'Unknown Album';
    // Folder-based grouping: an album is one title inside one folder (CD1/CD2 subfolders merged).
    const key = `${title.toLowerCase()}|${folder}`;
    let a = albums.get(key);
    if (!a) albums.set(key, (a = { key, title, albumArtist: null, artists: new Set(), year: null, cover: null, tracks: [] }));
    a.tracks.push(t);
    if (t.artist) a.artists.add(t.artist);
    if (t.albumArtist && !a.albumArtist) a.albumArtist = t.albumArtist;
    if (t.year && (!a.year || t.year < a.year)) a.year = t.year;
    if (!a.cover && t.cover) a.cover = t.cover;
    t._album = key;
  }
  for (const a of albums.values()) {
    a.artist = a.albumArtist || (a.artists.size === 1 ? [...a.artists][0] : a.artists.size ? 'Various Artists' : 'Unknown Artist');
    a.tracks.sort(byDiscTrack);
    a.duration = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  }
  S.albums = [...albums.values()].sort((a, b) => collator.compare(sortName(a.artist), sortName(b.artist)) || (a.year || 0) - (b.year || 0) || collator.compare(a.title, b.title));
  S.albumByKey = albums;

  const artists = new Map();
  for (const t of S.tracks) {
    const name = t.albumArtist || t.artist || 'Unknown Artist';
    if (!artists.has(name.toLowerCase())) artists.set(name.toLowerCase(), { name, tracks: [], albums: new Set() });
    const ar = artists.get(name.toLowerCase());
    ar.tracks.push(t);
    ar.albums.add(t._album);
  }
  S.artists = [...artists.values()].sort((a, b) => collator.compare(sortName(a.name), sortName(b.name)));
}

function byDiscTrack(a, b) {
  return (a.discNo || 1) - (b.discNo || 1) || (a.trackNo || 999) - (b.trackNo || 999) || collator.compare(a.path, b.path);
}

function sortTracks(list, { key, dir }) {
  const chain = [key, 'artist', 'album', 'discNo', 'trackNo', 'title'].filter((k, i, arr) => arr.indexOf(k) === i);
  const cmp = (a, b) => {
    for (const k of chain) {
      const x = a[k]; const y = b[k];
      const empty = (v) => v == null || v === '';
      if (empty(x) && empty(y)) continue;
      if (empty(x)) return 1;
      if (empty(y)) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y
        : collator.compare(k === 'artist' ? sortName(x) : String(x), k === 'artist' ? sortName(y) : String(y));
      if (r) return k === key ? r * dir : r;
    }
    return 0;
  };
  return [...list].sort(cmp);
}

const matches = (t) => {
  if (!S.search) return true;
  return S.search.split(/\s+/).every((w) => t._s?.includes(w));
};

async function loadState() {
  const st = await chew.state();
  S.tracks = st.tracks;
  S.playlists = st.playlists;
  S.settings = st.settings;
  buildIndex();
  if (player.track && S.byId.has(player.track.id)) {
    const fresh = S.byId.get(player.track.id);
    if (player.transcoding) fresh.playback = 'transcode';
    player.track = fresh;
    renderNowPlaying();
  }
  renderPlaylists();
}

// ---------------------------------------------------------------- navigation

function go(view, param = null, push = true) {
  if (push && (S.view !== view || S.param !== param)) S.history.push([S.view, S.param]);
  if (['songs', 'albums', 'artists', 'queue', 'settings', 'playlist', 'vhome', 'movies', 'shows'].includes(view)) S.history = [];
  if ((view === 'folders' || view === 'vfolders') && param === null) S.history = [];
  S.view = view;
  S.param = param;
  for (const b of document.querySelectorAll('.nav-item')) {
    b.classList.toggle('active', b.dataset.view === view || (view === 'album' && b.dataset.view === 'albums')
      || (view === 'artist' && b.dataset.view === 'artists') || (view === 'playlist' && b.dataset.playlist === param)
      || (view === 'movie' && b.dataset.view === (video.get(param)?.type === 'episode' ? 'shows' : 'movies')) || (view === 'show' && b.dataset.view === 'shows'));
  }
  render(false);
}

function back() {
  const prev = S.history.pop();
  if (prev) go(prev[0], prev[1], false);
}

// Rebuild the current view. When `keep` is set, scroll positions and selection survive (used for live library updates).
function render(keep = true) {
  const content = $('#content');
  const scrolls = keep ? [...content.querySelectorAll('.table-body, .scroll')].map((el) => el.scrollTop) : [];
  const selected = keep && S.table ? new Set(S.table.selected) : null;
  S.table = null;

  const fn = VIEWS[S.view] || video.views[S.view] || VIEWS.songs;
  const v = fn(S.param) || VIEWS.songs();
  S.current = v;
  $('#view-title').textContent = v.title;
  $('#view-subtitle').textContent = v.subtitle || '';
  $('#back').hidden = !S.history.length;
  $('#play-all').hidden = $('#shuffle-all').hidden = !(v.list && v.list.length) || !!v.ownActions;
  $('.search').hidden = v.noSearch;

  content.replaceChildren(v.el);
  hydrateIcons(content);
  if (selected && S.table) { S.table.selected = selected; S.table.refresh(); }
  const els = [...content.querySelectorAll('.table-body, .scroll')];
  scrolls.forEach((y, i) => { if (els[i]) els[i].scrollTop = y; });
}


function welcome() {
  const d = el(`<div class="empty-state">
    <img src="logo.svg" alt="">
    <h2>Welcome to Chew Player</h2>
    <p>Point Chew Player at the folders where your music lives. It reads the files, fills in missing details from MusicBrainz and keeps everything organised by folder — nothing is moved or modified.</p>
    <button class="btn" data-act="add-folder">${icon('folder')}Add Music Folder</button>
  </div>`);
  return d;
}

function emptyResult(text) {
  return el(`<div class="empty-state"><p>${esc(text)}</p></div>`);
}

function trackTable(list, opts = {}) {
  const t = new TrackTable({
    columns: opts.columns || ['num', 'title', 'artist', 'album', 'year', 'time', 'format'],
    tracks: list,
    sort: opts.sortable ? S.sort : null,
    onSort: opts.sortable ? (s) => { S.sort = s; render(); } : null,
    onPlay: opts.onPlay || ((i) => playFrom(list, i)),
    onContext: (ids, i) => trackMenu(ids, opts.context || {}),
    onReorder: opts.onReorder,
    onDelete: opts.onDelete,
    isPlaying: opts.isPlaying || ((t) => t.id === player.currentId && !!player.track),
    onRate: (id, n) => { const t = S.byId.get(id); rateIds([id], t?.rating === n ? 0 : n); },
  });
  S.table = t;
  return t.el;
}

// ---------------------------------------------------------------- views

const toggle = (key) => `<label class="switch"><input type="checkbox" data-setting="${key}" ${S.settings[key] !== false ? 'checked' : ''}><span></span></label>`;

function outputOptions() {
  const current = S.settings.outputDevice || 'default';
  const list = S.devices.length ? S.devices : [{ deviceId: 'default', label: 'System default' }];
  return list.map((d) => `<option value="${esc(d.deviceId)}" ${d.deviceId === current ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
}

function updateText() {
  const u = S.update || {};
  switch (u.state) {
    case 'checking': return 'Checking for updates…';
    case 'current': return `You’re up to date (version ${S.info.version}).`;
    case 'available': return `Version ${u.version} is available.`;
    case 'downloading': return `Downloading version ${u.version}… ${u.percent || 0}%`;
    case 'ready': return `Version ${u.version} is ready to install.`;
    case 'error': return `Couldn’t check for updates: ${u.message || 'unknown error'}`;
    default: return `You’re running version ${S.info.version}.`;
  }
}

const VIEWS = {
  songs() {
    if (!S.tracks.length) return { title: 'Songs', el: welcome() };
    const list = sortTracks(S.tracks.filter(matches), S.sort);
    const dur = list.reduce((s, t) => s + (t.duration || 0), 0);
    const d = el('');
    d.append(list.length ? trackTable(list, { sortable: true, columns: ['num', 'title', 'artist', 'album', 'year', 'genre', 'rating', 'time', 'format'] }) : emptyResult('No songs match your search.'));
    return { title: 'Songs', subtitle: `${plural(list.length, 'song')} · ${fmtTime(dur)}`, list, el: d };
  },

  albums() {
    if (!S.tracks.length) return { title: 'Albums', el: welcome() };
    const q = S.search;
    const albums = S.albums.filter((a) => !q || q.split(/\s+/).every((w) => `${a.title} ${a.artist} ${a.year || ''}`.toLowerCase().includes(w)));
    const d = el(`<div class="scroll"><div class="pad"><div class="grid">${albums.map((a) => `
      <div class="card" data-album="${esc(a.key)}">
        ${coverDiv(a.cover)}
        <div class="card-title">${esc(a.title)}</div>
        <div class="card-sub">${esc(a.artist)}${a.year ? ` · ${a.year}` : ''}</div>
      </div>`).join('')}</div></div></div>`);
    if (!albums.length) return { title: 'Albums', el: emptyResult('No albums match your search.') };
    const list = albums.flatMap((a) => a.tracks);
    return { title: 'Albums', subtitle: plural(albums.length, 'album'), list, el: d };
  },

  album(key) {
    const a = S.albumByKey.get(key);
    if (!a) return VIEWS.albums();
    const list = a.tracks;
    const multiDisc = new Set(list.map((t) => t.discNo || 1)).size > 1;
    const formats = [...new Set(list.map((t) => t.format))].join(', ');
    const d = el(`<div class="detail-head">
        ${coverDiv(a.cover)}
        <div>
          <div class="kicker">Album</div>
          <h2>${esc(a.title)}</h2>
          <div class="meta"><a class="link" data-artist="${esc(a.artist)}">${esc(a.artist)}</a>${a.year ? ` · ${a.year}` : ''} · ${plural(list.length, 'song')} · ${fmtTime(a.duration)} · ${esc(formats)}${multiDisc ? ' · multi-disc' : ''}</div>
          <div class="actions">
            <button class="btn" data-act="play">${icon('play')}Play</button>
            <button class="btn ghost" data-act="shuffle">${icon('shuffle')}Shuffle</button>
            <button class="btn ghost" data-act="lookup" title="Look up tags and cover art on MusicBrainz">${icon('globe')}Look Up Online</button>
          </div>
        </div>
      </div>`);
    d.append(trackTable(list, { columns: ['num', 'title', 'artist', 'time', 'format'] }));
    return { title: a.title, subtitle: a.artist, list, el: d, noSearch: true, ownActions: true };
  },

  artists() {
    if (!S.tracks.length) return { title: 'Artists', el: welcome() };
    const q = S.search;
    const artists = S.artists.filter((a) => !q || q.split(/\s+/).every((w) => a.name.toLowerCase().includes(w)));
    if (!artists.length) return { title: 'Artists', el: emptyResult('No artists match your search.') };
    let html = '<div class="scroll">';
    let letter = '';
    for (const a of artists) {
      const l = (sortName(a.name)[0] || '#').toUpperCase();
      const L = /[A-Z]/.test(l) ? l : '#';
      if (L !== letter) { letter = L; html += `<div class="letter">${L}</div>`; }
      html += `<div class="list-row" data-artist="${esc(a.name)}">
        <div class="avatar">${esc((sortName(a.name)[0] || '?').toUpperCase())}</div>
        <div class="name">${esc(a.name)}</div>
        <div class="meta">${plural(a.albums.size, 'album')} · ${plural(a.tracks.length, 'song')}</div>
        ${icon('chevron')}
      </div>`;
    }
    html += '</div>';
    return { title: 'Artists', subtitle: plural(artists.length, 'artist'), list: artists.flatMap((a) => a.tracks), el: el(html) };
  },

  artist(name) {
    const a = S.artists.find((x) => x.name === name) || S.artists.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!a) return VIEWS.artists();
    const albums = [...a.albums].map((k) => S.albumByKey.get(k)).filter(Boolean).sort((x, y) => (x.year || 9999) - (y.year || 9999));
    const list = albums.flatMap((al) => al.tracks.filter((t) => a.tracks.includes(t)));
    const d = el(`<div class="scroll" style="flex:none;max-height:46%"><div class="pad"><div class="grid">${albums.map((al) => `
      <div class="card" data-album="${esc(al.key)}">
        ${coverDiv(al.cover)}
        <div class="card-title">${esc(al.title)}</div>
        <div class="card-sub">${al.year || ''}</div>
      </div>`).join('')}</div></div></div>`);
    d.append(trackTable(list, { columns: ['num', 'title', 'album', 'year', 'time', 'format'] }));
    return { title: a.name, subtitle: `${plural(albums.length, 'album')} · ${plural(list.length, 'song')}`, list, el: d, noSearch: true };
  },

  folders(dir) {
    const roots = S.settings.folders || [];
    if (!roots.length) return { title: 'Folders', el: welcome() };
    const sep = S.info.platform === 'win32' ? '\\' : '/';
    const lc = (p) => (S.info.platform === 'win32' ? p.toLowerCase() : p);
    const q = S.search;

    if (!dir) {
      const rows = roots.map((r) => {
        const n = S.tracks.filter((t) => lc(t.path).startsWith(lc(r) + sep)).length;
        return `<div class="list-row" data-folder="${esc(r)}">${icon('folder')}<div class="name">${esc(r)}</div><div class="meta">${plural(n, 'song')}</div>${icon('chevron')}</div>`;
      }).join('');
      const list = S.tracks.filter((t) => matches(t) && !t.loose).sort((a, b) => collator.compare(a.path, b.path));
      const d = el(`<div class="scroll">${rows}</div>`);
      return { title: 'Folders', subtitle: plural(roots.length, 'library folder'), list, el: d, noSearch: true };
    }

    const prefix = lc(dir) + sep;
    const subs = new Map();
    const here = [];
    for (const t of S.tracks) {
      const p = lc(t.path);
      if (!p.startsWith(prefix)) continue;
      const rest = t.path.slice(prefix.length);
      const cut = rest.indexOf(sep);
      if (cut < 0) { if (matches(t)) here.push(t); continue; }
      const name = rest.slice(0, cut);
      if (!subs.has(name)) subs.set(name, { name, count: 0, cover: null, tracks: [] });
      const s = subs.get(name);
      s.count++;
      s.tracks.push(t);
      if (!s.cover && t.cover) s.cover = t.cover;
    }
    here.sort(byDiscTrack);
    const subList = [...subs.values()].filter((s) => !q || s.name.toLowerCase().includes(q) || s.tracks.some(matches)).sort((a, b) => collator.compare(a.name, b.name));

    const root = roots.find((r) => lc(dir) === lc(r) || lc(dir).startsWith(lc(r) + sep)) || dir;
    const crumbs = [{ label: root.split(sep).filter(Boolean).pop() || root, path: root }];
    const relParts = dir.slice(root.length).split(sep).filter(Boolean);
    let acc = root;
    for (const part of relParts) { acc = acc + (acc.endsWith(sep) ? '' : sep) + part; crumbs.push({ label: part, path: acc }); }

    const folderCover = here.find((t) => t.cover)?.cover || subList.find((s) => s.cover)?.cover;
    const name = crumbs[crumbs.length - 1].label;
    const all = [...here, ...subList.flatMap((s) => s.tracks.filter(matches).sort((a, b) => collator.compare(a.path, b.path)))];
    const d = el(`
      <div class="breadcrumb"><button data-folder="">Folders</button>${crumbs.map((c) => `${icon('chevron')}<button data-folder="${esc(c.path)}">${esc(c.label)}</button>`).join('')}</div>
      <div class="detail-head">
        ${coverDiv(folderCover)}
        <div>
          <div class="kicker">Folder</div>
          <h2>${esc(name)}</h2>
          <div class="meta">${subList.length ? `${plural(subList.length, 'folder')} · ` : ''}${plural(all.length, 'song')}</div>
          <div class="actions">
            <button class="btn" data-act="play">${icon('play')}Play</button>
            <button class="btn ghost" data-act="shuffle">${icon('shuffle')}Shuffle</button>
            <button class="btn ghost" data-act="reveal-folder" data-path="${esc(dir)}">${icon('folder')}${S.info.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer'}</button>
          </div>
        </div>
      </div>
      ${subList.length ? `<div class="scroll" style="${here.length ? 'flex:none;max-height:40%' : ''}">${subList.map((s) => `
        <div class="list-row" data-folder="${esc(dir + sep + s.name)}">${icon('folder')}<div class="name">${esc(s.name)}</div><div class="meta">${plural(s.count, 'song')}</div>${icon('chevron')}</div>`).join('')}</div>` : ''}`);
    for (const i of d.querySelectorAll('.breadcrumb i')) { i.style.width = '12px'; i.style.height = '12px'; }
    if (here.length) d.append(trackTable(here, { columns: ['num', 'title', 'artist', 'album', 'time', 'format'] }));
    return { title: name, subtitle: '', list: all, el: d, ownActions: true };
  },

  queue() {
    const ids = player.order.map((i) => player.queue[i]);
    const list = ids.map((id) => S.byId.get(id) || { id, title: 'Missing file', missing: true });
    if (!list.length) return { title: 'Queue', el: emptyResult('The queue is empty. Double-click a song to start playing.') };
    const d = el('');
    d.append(trackTable(list, {
      columns: ['index', 'title', 'artist', 'album', 'time', 'format'],
      onPlay: (i) => player.jumpTo(i),
      isPlaying: (t, i) => i === player.pos && !!player.track,
      onDelete: (idx) => { player.removeUpcoming(idx); },
      context: { queue: true },
    }));
    const left = list.slice(player.pos + 1).reduce((s, t) => s + (t.duration || 0), 0);
    return { title: 'Queue', subtitle: `${plural(list.length, 'song')} · ${fmtTime(left)} remaining`, el: d, noSearch: true };
  },

  playlist(id) {
    const p = S.playlists.find((x) => x.id === id);
    if (!p) return VIEWS.songs();
    if (kindOf(p) === 'video') return video.playlistView(p);
    if (p.smart) return smartPlaylistView(p);
    const list = p.trackIds.map((tid) => S.byId.get(tid) || { id: tid, title: 'Missing file', missing: true });
    const dur = list.reduce((s, t) => s + (t.duration || 0), 0);
    const d = el(`<div class="detail-head" style="padding-bottom:12px">
      <div><div class="actions" style="margin-top:0">
        <button class="btn" data-act="play">${icon('play')}Play</button>
        <button class="btn ghost" data-act="shuffle">${icon('shuffle')}Shuffle</button>
        <button class="btn ghost" data-act="export-playlist">Export M3U…</button>
        <button class="btn ghost" data-act="rename-playlist">Rename</button>
        <button class="btn danger" data-act="delete-playlist">Delete</button>
      </div></div></div>`);
    if (!list.length) {
      d.append(emptyResult('This playlist is empty. Drag songs onto it in the sidebar, or right-click songs and choose “Add to Playlist”.'));
    } else {
      d.append(trackTable(list, {
        columns: ['index', 'title', 'artist', 'album', 'time', 'format'],
        onReorder: (idx, at) => {
          const ids = [...p.trackIds];
          const moving = idx.map((i) => ids[i]);
          const before = idx.filter((i) => i < at).length;
          for (const i of [...idx].sort((a, b) => b - a)) ids.splice(i, 1);
          ids.splice(at - before, 0, ...moving);
          p.trackIds = ids;
          chew.playlists.update(p.id, { trackIds: ids });
          render();
        },
        onDelete: (idx) => removeFromPlaylist(p, idx),
        context: { playlist: p },
      }));
    }
    return { title: p.name, subtitle: `${plural(list.length, 'song')} · ${fmtTime(dur)}`, list: list.filter((t) => !t.missing), el: d, noSearch: true, ownActions: true };
  },

  settings() {
    const f = S.settings.folders || [];
    const theme = S.settings.theme || 'system';
    const d = el(`<div class="scroll"><div class="pad settings">
      <h3>Music folders</h3>
      <div class="box">
        ${f.map((p) => `<div class="box-row">${icon('folder')}<div class="grow"><div class="path" title="${esc(p)}">${esc(p)}</div>
          <div class="hint">${plural(S.tracks.filter((t) => t.root === p).length, 'song')}</div></div>
          <button class="btn ghost" data-act="reveal-folder" data-path="${esc(p)}">Show</button>
          <button class="btn danger" data-act="remove-folder" data-path="${esc(p)}">Remove</button></div>`).join('')}
        <div class="box-row"><div class="grow"><div>Watch folders for changes</div>
          <div class="hint">New, changed and deleted files are picked up automatically, without a manual rescan.</div></div>
          ${toggle('watchFolders')}</div>
        <div class="box-row"><div class="grow hint">Chew Player never moves, renames or rewrites your files. Edits are stored in its own library.</div>
          <button class="btn ghost" data-act="rescan">Rescan</button>
          <button class="btn" data-act="add-folder">${icon('plus')}Add Folder…</button></div>
      </div>

      <h3>Video folders</h3>
      <div class="box">
        ${video.folders().map((p) => `<div class="box-row">${icon('film')}<div class="grow"><div class="path" title="${esc(p)}">${esc(p)}</div>
          <div class="hint">${plural(video.items().filter((i) => i.root === p).length, 'video')}</div></div>
          <button class="btn ghost" data-act="reveal-folder" data-path="${esc(p)}">Show</button>
          <button class="btn danger" data-act="remove-video-folder" data-path="${esc(p)}">Remove</button></div>`).join('')}
        <div class="box-row"><div class="grow hint">Movies and TV episodes are recognised from file and folder names. Posters and descriptions come from Wikipedia/Wikidata and TVMaze.</div>
          <button class="btn ghost" data-act="rescan-video">Rescan</button>
          <button class="btn" data-act="add-video-folder">${icon('plus')}Add Folder…</button></div>
      </div>

      <h3>Online information</h3>
      <div class="box">
        <div class="box-row"><div class="grow"><div>Look up missing tags and album art automatically</div>
          <div class="hint">Uses the open MusicBrainz and Cover Art Archive databases after each scan.</div></div>
          <label class="switch"><input type="checkbox" data-setting="autoFetch" ${S.settings.autoFetch ? 'checked' : ''}><span></span></label></div>
        <div class="box-row"><div class="grow hint">Run a lookup now for every song with incomplete info or without cover art.</div>
          <button class="btn ghost" data-act="fetch">${icon('globe')}Music</button>
          <button class="btn ghost" data-act="fetch-video">${icon('globe')}Videos</button></div>
      </div>

      <h3>Appearance</h3>
      <div class="box"><div class="box-row"><div class="grow">Theme</div>
        <div class="segmented">${['system', 'light', 'dark'].map((t) => `<button data-theme="${t}" class="${t === theme ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div></div>

      <h3>Playback</h3>
      <div class="box">
        <div class="box-row"><div class="grow"><div>Gapless playback</div>
          <div class="hint">Songs flow into each other without a pause, as on live and concept albums.</div></div>
          ${toggle('gapless')}</div>
        <div class="box-row"><div class="grow"><div>Volume leveling (ReplayGain)</div>
          <div class="hint">Evens out loudness between songs using the ReplayGain values stored in the files. “Smart” uses album gain when playing in order and track gain when shuffling.</div></div>
          <div class="segmented">${[['off', 'Off'], ['track', 'Track'], ['album', 'Album'], ['auto', 'Smart']].map(([v, l]) => `<button data-rg="${v}" class="${(S.settings.replayGain || 'auto') === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="box-row"><div class="grow"><div>Output device</div>
          <div class="hint">Play through a specific device, such as a USB DAC or headphones.</div></div>
          <select class="select" id="output-select">${outputOptions()}</select></div>
        <div class="box-row"><div class="grow"><div>Format support</div>
        <div class="hint">${S.info.ffmpeg
          ? 'MP3, AAC, FLAC, Ogg, Opus and WAV play natively. Everything else (ALAC, AIFF, WMA, APE, WavPack, Musepack, DSD, …) is decoded on the fly with the bundled FFmpeg.'
          : 'FFmpeg was not found, so only MP3, AAC, FLAC, Ogg, Opus and WAV can be played.'}</div></div></div></div>

      <h3>Updates</h3>
      <div class="box">
        <div class="box-row"><div class="grow"><div>Check for updates automatically</div>
          <div class="hint">${S.info.platform === 'win32' ? 'New versions are downloaded in the background and installed when you restart.' : 'You’ll be notified when a new version is available.'}</div></div>
          ${toggle('autoUpdate')}</div>
        <div class="box-row"><div class="grow hint" id="update-text">${esc(updateText())}</div>
          ${S.update?.state === 'ready' || S.update?.state === 'available'
            ? `<button class="btn" data-act="install-update">${S.update.state === 'ready' ? 'Restart & Update' : 'Download'}</button>`
            : '<button class="btn ghost" data-act="check-update">Check Now</button>'}</div>
      </div>

      <h3>About</h3>
      <div class="box"><div class="box-row"><img src="logo.svg" width="40" height="40" alt="">
        <div class="grow"><div><b>Chew Player</b> ${esc(S.info.version || '')}</div><div class="hint">A simple, folder-based music player. MIT licensed.</div></div>
        <button class="btn ghost" data-act="website">Website</button></div></div>
    </div></div>`);
    return { title: 'Settings', el: d, noSearch: true };
  },
};

function smartPlaylistView(p) {
  const list = evaluate(p, S.tracks, 'audio');
  const dur = list.reduce((s, t) => s + (t.duration || 0), 0);
  const d = el(`<div class="detail-head" style="padding-bottom:12px">
    <div>
      <div class="smart-desc">${icon('smart')}<span>${esc(describe(p.smart, 'audio'))}</span></div>
      <div class="actions">
        <button class="btn" data-act="play">${icon('play')}Play</button>
        <button class="btn ghost" data-act="shuffle">${icon('shuffle')}Shuffle</button>
        <button class="btn ghost" data-act="edit-smart">Edit Rules…</button>
        <button class="btn ghost" data-act="export-playlist">Export M3U…</button>
        <button class="btn danger" data-act="delete-playlist">Delete</button>
      </div>
    </div></div>`);
  if (!list.length) d.append(emptyResult('No songs match these rules yet.'));
  else d.append(trackTable(list, { columns: ['index', 'title', 'artist', 'album', 'rating', 'plays', 'time', 'format'] }));
  return { title: p.name, subtitle: `${plural(list.length, 'song')} · ${fmtTime(dur)}`, list, el: d, noSearch: true, ownActions: true };
}

const kindOf = (p) => p.kind || 'audio';
const exportPlaylist = (id) => {
  const p = S.playlists.find((x) => x.id === id);
  return chew.playlists.export(id, p?.smart ? evaluate(p, S.tracks, 'audio').map((t) => t.id) : null);
};
const addablePlaylists = (kind = 'audio') => S.playlists.filter((p) => !p.smart && kindOf(p) === kind);
const playlistSubmenu = (kind = 'audio') => {
  const lists = addablePlaylists(kind);
  return [{ id: 'pl:new', label: 'New Playlist…' }, ...(lists.length ? [{ type: 'separator' }] : []), ...lists.map((p) => ({ id: `pl:${p.id}`, label: p.name }))];
};
const ratingSubmenu = (current) => [0, 1, 2, 3, 4, 5].map((n) => ({ id: `rate:${n}`, label: n ? '★'.repeat(n) : 'None', checked: (current || 0) === n }));

async function rateIds(ids, n) {
  for (const id of ids) { const t = S.byId.get(id); if (t) t.rating = n || null; }
  if (S.table) S.table.refresh();
  await chew.rate(ids, n);
}

async function newSmartPlaylist(kind = 'audio') {
  const items = kind === 'video' ? (window.chewVideo?.items() || []) : S.tracks;
  const r = await editSmart({ kind, countFor: (pl) => evaluate(pl, items, kind).length });
  if (!r) return;
  const p = await chew.playlists.create(r.name, [], { kind, smart: r.smart });
  S.playlists.push(p);
  renderPlaylists();
  go('playlist', p.id);
}

async function editSmartPlaylist(p) {
  const kind = kindOf(p);
  const items = kind === 'video' ? (window.chewVideo?.items() || []) : S.tracks;
  const r = await editSmart({ name: p.name, smart: p.smart, kind, countFor: (pl) => evaluate(pl, items, kind).length });
  if (!r) return;
  p.name = r.name;
  p.smart = r.smart;
  await chew.playlists.update(p.id, { name: r.name, smart: r.smart });
  renderPlaylists();
  render();
}

// ---------------------------------------------------------------- actions

function playFrom(list, i, shuffle = false) {
  const playable = list.filter((t) => !t.missing);
  if (!playable.length) return;
  const start = Math.max(0, playable.indexOf(list[i]));
  player.playList(playable.map((t) => t.id), shuffle ? null : start, { shuffle });
  syncToggles();
}

function removeFromPlaylist(p, indices) {
  const drop = new Set(indices);
  p.trackIds = p.trackIds.filter((_, i) => !drop.has(i));
  chew.playlists.update(p.id, { trackIds: p.trackIds });
  render();
}

async function newPlaylist(ids = [], kind = S.mode || 'audio') {
  const p = await chew.playlists.create('New Playlist', ids, { kind });
  S.playlists.push(p);
  renderPlaylists();
  go('playlist', p.id);
  startRename(p.id);
}

function addToPlaylist(pid, ids) {
  const p = S.playlists.find((x) => x.id === pid);
  if (!p) return;
  p.trackIds.push(...ids);
  chew.playlists.update(pid, { add: ids });
  toast(`Added ${plural(ids.length, kindOf(p) === 'video' ? 'video' : 'song')} to “${p.name}”`);
  renderPlaylists();
  if (S.view === 'playlist' && S.param === pid) render();
}

async function lookup(ids) {
  await chew.fetchMissing(ids);
}

const revealLabel = () => (S.info.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer');

async function trackMenu(ids, ctx) {
  if (!ids.length) return;
  const items = [
    { id: 'play', label: ids.length > 1 ? `Play ${ids.length} Songs` : 'Play' },
    { id: 'next', label: 'Play Next' },
    { id: 'queue', label: 'Add to Queue' },
    { type: 'separator' },
    { label: 'Add to Playlist', submenu: playlistSubmenu('audio') },
    { label: 'Rating', submenu: ratingSubmenu(ids.length === 1 ? S.byId.get(ids[0])?.rating : null) },
    { type: 'separator' },
    { id: 'info', label: ids.length > 1 ? 'Edit Info…' : 'Get Info…' },
    { id: 'lookup', label: 'Look Up Online' },
    { id: 'reveal', label: revealLabel(), enabled: ids.length === 1 },
  ];
  if (ctx.playlist) items.push({ type: 'separator' }, { id: 'remove-pl', label: 'Remove from Playlist' });
  if (ctx.queue) items.push({ type: 'separator' }, { id: 'remove-q', label: 'Remove from Queue' });
  const choice = await chew.contextMenu(items);
  if (!choice) return;
  const tracks = ids.map((id) => S.byId.get(id)).filter(Boolean);
  if (choice === 'play') playFrom(tracks, 0);
  else if (choice === 'next') { player.playNext(tracks.map((t) => t.id)); toast('Playing next'); }
  else if (choice === 'queue') { player.enqueue(tracks.map((t) => t.id)); toast(`Added ${plural(tracks.length, 'song')} to the queue`); }
  else if (choice === 'pl:new') newPlaylist(ids);
  else if (choice.startsWith('pl:')) addToPlaylist(choice.slice(3), ids);
  else if (choice.startsWith('rate:')) rateIds(ids, Number(choice.slice(5)));
  else if (choice === 'info') openInfo(ids);
  else if (choice === 'lookup') lookup(ids);
  else if (choice === 'reveal') chew.reveal(ids[0]);
  else if (choice === 'remove-pl') removeFromPlaylist(ctx.playlist, S.table.selectedIndices());
  else if (choice === 'remove-q') player.removeUpcoming(S.table.selectedIndices());
}

async function groupMenu(tracks, extra = []) {
  const items = [
    { id: 'play', label: 'Play' },
    { id: 'shuffle', label: 'Shuffle' },
    { id: 'next', label: 'Play Next' },
    { id: 'queue', label: 'Add to Queue' },
    { type: 'separator' },
    { label: 'Add to Playlist', submenu: playlistSubmenu('audio') },
    { id: 'lookup', label: 'Look Up Online' },
    ...extra,
  ];
  const choice = await chew.contextMenu(items);
  const ids = tracks.map((t) => t.id);
  if (choice === 'play') playFrom(tracks, 0);
  else if (choice === 'shuffle') playFrom(tracks, 0, true);
  else if (choice === 'next') player.playNext(ids);
  else if (choice === 'queue') { player.enqueue(ids); toast(`Added ${plural(ids.length, 'song')} to the queue`); }
  else if (choice === 'pl:new') newPlaylist(ids);
  else if (choice?.startsWith('pl:')) addToPlaylist(choice.slice(3), ids);
  else if (choice === 'lookup') lookup(ids);
  return choice;
}

function folderTracks(dir) {
  const sep = S.info.platform === 'win32' ? '\\' : '/';
  const lc = (p) => (S.info.platform === 'win32' ? p.toLowerCase() : p);
  const prefix = lc(dir) + sep;
  return S.tracks.filter((t) => lc(t.path).startsWith(prefix)).sort((a, b) => collator.compare(a.path, b.path));
}

// ---------------------------------------------------------------- info dialog

function openInfo(ids) {
  const tracks = ids.map((id) => S.byId.get(id)).filter(Boolean);
  if (!tracks.length) return;
  const fields = [
    ['title', 'Title', 'wide'], ['artist', 'Artist'], ['albumArtist', 'Album Artist'],
    ['album', 'Album', 'wide'], ['year', 'Year'], ['genre', 'Genre'], ['trackNo', 'Track'], ['discNo', 'Disc'],
  ];
  const common = (f) => {
    const vals = new Set(tracks.map((t) => t[f] ?? ''));
    return vals.size === 1 ? [...vals][0] : null;
  };
  const one = tracks.length === 1 ? tracks[0] : null;
  const tech = one ? [
    ['File', one.path],
    ['Format', [one.format, one.codec].filter(Boolean).join(' · ')],
    ['Quality', [one.bitrate && `${one.bitrate} kbps`, one.sampleRate && `${(one.sampleRate / 1000).toFixed(1)} kHz`, one.bitsPerSample && `${one.bitsPerSample} bit`, one.channels && (one.channels === 2 ? 'stereo' : one.channels === 1 ? 'mono' : `${one.channels} ch`)].filter(Boolean).join(' · ') || '—'],
    ['Length', fmtTime(one.duration)],
    ['Size', `${(one.size / 1048576).toFixed(1)} MB`],
    ['Playback', one.playback === 'transcode' ? 'via FFmpeg' : 'native'],
  ] : null;
  const modal = $('#modal');
  modal.innerHTML = `<div class="modal">
    <h2>${one ? esc(one.title) : `Edit ${tracks.length} songs`}</h2>
    <div class="sub">${one ? esc([one.artist, one.album].filter(Boolean).join(' — ')) : 'Only fields you change are applied to all selected songs.'}</div>
    <form class="form" id="info-form">
      ${fields.map(([f, label, cls]) => {
        const v = common(f);
        return `<label class="${cls || ''}">${label}<input name="${f}" value="${esc(v ?? '')}" placeholder="${v === null ? 'Mixed' : ''}" data-orig="${esc(v ?? '')}"></label>`;
      }).join('')}
    </form>
    ${tech ? `<div class="file-info">${tech.map(([k, v]) => `<span>${k}</span><b>${esc(v)}</b>`).join('')}</div>` : ''}
    <div class="modal-actions">
      <div><button class="btn ghost" data-m="lookup">${icon('globe')}Look Up Online</button></div>
      <div><button class="btn ghost" data-m="cancel">Cancel</button><button class="btn" data-m="save">Save</button></div>
    </div>
  </div>`;
  hydrateIcons(modal);
  modal.hidden = false;
  modal.querySelector('input')?.focus();
  const close = () => { modal.hidden = true; modal.innerHTML = ''; };
  const save = async () => {
    const edits = {};
    for (const input of modal.querySelectorAll('#info-form input')) {
      if (input.value !== input.dataset.orig) edits[input.name] = input.value;
    }
    if (Object.keys(edits).length) await chew.editTracks(ids, edits);
    close();
  };
  modal.onclick = (e) => {
    if (e.target === modal) return close();
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (m === 'cancel') close();
    if (m === 'save') save();
    if (m === 'lookup') { lookup(ids); close(); }
  };
  modal.onkeydown = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') { e.preventDefault(); save(); }
  };
}

// ---------------------------------------------------------------- sidebar playlists

function renderPlaylists() {
  const box = $('#playlists');
  if (box.querySelector('input')) return; // don't clobber an active rename
  const mode = S.mode || 'audio';
  box.innerHTML = S.playlists.filter((p) => kindOf(p) === mode).map((p) => `
    <button class="nav-item${S.view === 'playlist' && S.param === p.id ? ' active' : ''}${p.smart ? ' smart' : ''}" data-playlist="${p.id}">
      ${icon(p.smart ? 'smart' : 'playlist')}<span>${esc(p.name)}</span><span class="count">${p.smart ? '' : (p.trackIds.length || '')}</span>
    </button>`).join('');
}

function startRename(id) {
  const btn = $(`[data-playlist="${id}"]`);
  const p = S.playlists.find((x) => x.id === id);
  if (!btn || !p) return;
  const span = btn.querySelector('span');
  const input = document.createElement('input');
  input.value = p.name;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.remove();
    if (ok && name && name !== p.name) { p.name = name; chew.playlists.update(id, { name }); }
    renderPlaylists();
    if (S.view === 'playlist' && S.param === id) render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

async function deletePlaylist(id) {
  const p = S.playlists.find((x) => x.id === id);
  if (!p) return;
  if (!(await chew.confirm(`Delete the playlist “${p.name}”?`, 'The songs themselves stay in your library.', 'Delete'))) return;
  await chew.playlists.remove(id);
  S.playlists = S.playlists.filter((x) => x.id !== id);
  renderPlaylists();
  if (S.view === 'playlist' && S.param === id) go('songs');
}

// ---------------------------------------------------------------- player UI

const seek = $('#seek');
const volume = $('#volume');
let seeking = false;

function setRangePct(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', `${pct}%`);
}

function renderNowPlaying() {
  const t = player.track;
  $('#now-title').textContent = t ? t.title : 'Nothing playing';
  $('#now-artist').textContent = t ? [t.artist, t.album].filter(Boolean).join(' — ') : 'Pick a song and press play';
  const c = $('#now-cover');
  c.className = `now-cover cover${t?.cover ? '' : ' empty'}`;
  c.style.backgroundImage = t?.cover ? `url('${coverUrl(t.cover)}')` : '';
  const tech = t ? [t.format, t.lossless && t.sampleRate ? `${+(t.sampleRate / 1000).toFixed(1)} kHz` : t.bitrate ? `${t.bitrate} kbps` : '', t.lossless && t.bitsPerSample ? `${t.bitsPerSample} bit` : ''].filter(Boolean).join(' · ') : '';
  $('#now-tech').textContent = tech;
  document.title = t ? `${t.title} — ${t.artist || 'Chew Player'}` : 'Chew Player';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({
      title: t.title || '', artist: t.artist || '', album: t.album || '',
      artwork: t.cover ? [{ src: coverUrl(t.cover), sizes: '500x500' }] : [],
    }) : null;
  }
}

function renderTime() {
  const remote = castingAudio();
  const cur = remote ? cast.status.position : player.currentTime;
  const dur = remote ? cast.status.duration || player.duration : player.duration;
  $('#time-cur').textContent = fmtTime(cur);
  $('#time-dur').textContent = fmtTime(dur);
  if (!seeking) {
    seek.value = dur ? Math.round((cur / dur) * 1000) : 0;
    setRangePct(seek);
  }
}

function syncToggles() {
  $('#btn-shuffle').classList.toggle('on', player.shuffle);
  const r = $('#btn-repeat');
  r.classList.toggle('on', player.repeat !== 'off');
  setIcon(r, 'repeat');
  r.querySelector('.badge')?.remove();
  if (player.repeat === 'one') r.insertAdjacentHTML('beforeend', '<span class="badge">1</span>');
  r.title = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' }[player.repeat];
}

function setVolume(v, persist = true) {
  v = Math.max(0, Math.min(1, v));
  player.setVolume(v);
  volume.value = Math.round(v * 100);
  setRangePct(volume);
  setIcon($('#btn-mute'), v === 0 ? 'mute' : 'volume');
  if (persist) { clearTimeout(setVolume.t); setVolume.t = setTimeout(() => chew.setSetting('volume', v), 400); }
}

player.addEventListener('time', renderTime);
player.addEventListener('state', () => {
  setIcon($('#btn-play'), player.playing ? 'pause' : 'play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
});
player.addEventListener('track', () => {
  renderNowPlaying();
  if (S.table) S.table.refresh();
  if (S.view === 'queue') render();
});
player.addEventListener('queue', () => { if (S.view === 'queue') render(); });
player.addEventListener('error', (e) => toast(`Can't play “${e.detail?.title}”`));

seek.addEventListener('input', () => {
  seeking = true;
  setRangePct(seek);
  $('#time-cur').textContent = fmtTime((seek.value / 1000) * player.duration);
});
seek.addEventListener('change', () => {
  if (castingAudio()) { chew.cast.control('seek', (seek.value / 1000) * (cast.status.duration || player.duration)); seeking = false; return; }
  player.seek((seek.value / 1000) * player.duration);
  seeking = false;
});
volume.addEventListener('input', () => setVolume(volume.value / 100));
let lastVolume = 0.8;
$('#btn-mute').addEventListener('click', () => {
  if (player.volume > 0) { lastVolume = player.volume; setVolume(0); } else setVolume(lastVolume || 0.8);
});
$('#btn-play').addEventListener('click', () => (castingAudio() ? chew.cast.control(cast.status.state === 'playing' ? 'pause' : 'play') : player.toggle()));
$('#btn-next').addEventListener('click', () => (castingAudio() ? castMusicStep(1) : player.next()));
$('#btn-prev').addEventListener('click', () => (castingAudio() ? (cast.status.position > 3 ? chew.cast.control('seek', 0) : castMusicStep(-1)) : player.prev()));
$('#btn-shuffle').addEventListener('click', () => { player.setShuffle(!player.shuffle); syncToggles(); chew.setSetting('shuffle', player.shuffle); });
$('#btn-repeat').addEventListener('click', () => {
  player.setRepeat({ off: 'all', all: 'one', one: 'off' }[player.repeat]);
  syncToggles();
  chew.setSetting('repeat', player.repeat);
});
$('.now').addEventListener('click', () => { if (player.track) go('queue'); });

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => player.play());
  ms.setActionHandler('pause', () => player.pause());
  ms.setActionHandler('previoustrack', () => player.prev());
  ms.setActionHandler('nexttrack', () => player.next());
  try { ms.setActionHandler('seekto', (d) => player.seek(d.seekTime)); } catch { /* unsupported */ }
}

// ---------------------------------------------------------------- status & toasts


const status = { scan: null, fetch: null, vscan: null, vfetch: null };
function renderStatus() {
  const box = $('#status');
  const bar = $('#status-bar');
  const prog = bar.parentElement;
  const s = status.scan || status.vscan || status.fetch || status.vfetch;
  box.hidden = !s;
  if (!s) return;
  $('#status-label').textContent = s.label;
  $('#status-cancel').hidden = !status.fetch || !!status.scan;
  prog.classList.toggle('indeterminate', !s.total);
  bar.style.width = s.total ? `${Math.round((s.done / s.total) * 100)}%` : '0';
}

chew.onScanProgress((p) => {
  const key = p.source === 'video' ? 'vscan' : 'scan';
  const what = p.source === 'video' ? 'videos' : 'music';
  if (p.phase === 'done') status[key] = null;
  else if (p.phase === 'walk') status[key] = { label: `Finding ${what}… ${p.total ? p.total.toLocaleString() : ''}`, done: 0, total: 0 };
  else status[key] = { label: `Reading ${what} ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`, done: p.done, total: p.total };
  renderStatus();
});

let lastErr = 0;
chew.onFetchProgress((p) => {
  const key = p.source === 'video' ? 'vfetch' : 'fetch';
  if (p.phase === 'done') {
    status[key] = null;
    if (p.updated) toast(`Updated info for ${plural(p.updated, 'item')} from ${p.source === 'video' ? 'Wikipedia and TVMaze' : 'MusicBrainz'}`);
  } else if (p.phase === 'error') {
    if (Date.now() - lastErr > 10000) { lastErr = Date.now(); toast(`Online lookup: ${p.message}`); }
  } else if (p.phase === 'start' || p.phase === 'tags') {
    status[key] = { label: `Looking up ${p.source === 'video' ? 'video ' : ''}info… ${p.done}/${p.total}`, done: p.done, total: p.total };
  } else if (p.phase === 'covers') {
    status.fetch = { label: `Fetching album art… ${p.done}/${p.total}`, done: p.done, total: p.total };
  }
  renderStatus();
});
$('#status-cancel').addEventListener('click', () => chew.cancelFetch());

chew.onLibraryChanged(async () => {
  await loadState();
  if ($('#modal').hidden) render(true);
});

chew.onPlayTracks(async (ids) => {
  await loadState();
  render(true);
  const ok = ids.filter((id) => S.byId.has(id));
  if (ok.length) player.playList(ok, 0);
});

// ---------------------------------------------------------------- events

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('.nav-item[data-view]');
  if (nav) return go(nav.dataset.view);
  const pl = e.target.closest('.nav-item[data-playlist]');
  if (pl) return go('playlist', pl.dataset.playlist);

  const card = e.target.closest('[data-album]');
  if (card) return go('album', card.dataset.album);
  const artist = e.target.closest('[data-artist]');
  if (artist) return go('artist', artist.dataset.artist);
  const folder = e.target.closest('[data-folder]');
  if (folder) return go('folders', folder.dataset.folder || null);
  const rg = e.target.closest('[data-rg]');
  if (rg) {
    S.settings.replayGain = rg.dataset.rg;
    player.setReplayGain(rg.dataset.rg);
    chew.setSetting('replayGain', rg.dataset.rg);
    return render();
  }
  const theme = e.target.closest('[data-theme]');
  if (theme) {
    S.settings.theme = theme.dataset.theme;
    await chew.setSetting('theme', theme.dataset.theme);
    return render();
  }

  const act = e.target.closest('[data-act]');
  if (!act) return;
  const list = S.current?.list || [];
  switch (act.dataset.act) {
    case 'add-folder': chew.addFolder(); break;
    case 'remove-folder':
      if (await chew.confirm('Remove this folder from the library?', `${act.dataset.path}\n\nThe files on disk are not touched.`, 'Remove')) {
        await chew.removeFolder(act.dataset.path);
      }
      break;
    case 'reveal-folder': chew.openFolder(act.dataset.path); break;
    case 'rescan': chew.scan(); break;
    case 'fetch': chew.fetchMissing(); break;
    case 'website': window.open('https://fmatsch.github.io/chew-player/'); break;
    case 'check-update': {
      const st = await chew.updates.check();
      setUpdate(st);
      if (st?.state === 'current') toast('You’re up to date');
      break;
    }
    case 'install-update': chew.updates.install(); break;
    case 'play': playFrom(list, 0); break;
    case 'shuffle': playFrom(list, 0, true); break;
    case 'vplay-list': video.play(list, 0); break;
    case 'add-video-folder': chew.video.addFolder(); break;
    case 'remove-video-folder':
      if (await chew.confirm('Remove this video folder from the library?', `${act.dataset.path}\n\nThe files on disk are not touched.`, 'Remove')) await chew.video.removeFolder(act.dataset.path);
      break;
    case 'rescan-video': chew.video.scan(); break;
    case 'fetch-video': chew.video.fetch(); break;
    case 'lookup': lookup(list.map((t) => t.id)); break;
    case 'export-playlist': if (await exportPlaylist(S.param)) toast('Playlist exported'); break;
    case 'rename-playlist': startRename(S.param); break;
    case 'edit-smart': { const p = S.playlists.find((x) => x.id === S.param); if (p) editSmartPlaylist(p); break; }
    case 'delete-playlist': deletePlaylist(S.param); break;
    default: break;
  }
});

document.addEventListener('change', (e) => {
  const key = e.target.dataset?.setting;
  if (key) {
    S.settings[key] = e.target.checked;
    chew.setSetting(key, e.target.checked);
    if (key === 'gapless') player.setGapless(e.target.checked);
  }
  if (e.target.id === 'output-select') chooseOutput(e.target.value);
});

document.addEventListener('dblclick', (e) => {
  const pl = e.target.closest('.nav-item[data-playlist]');
  if (pl) startRename(pl.dataset.playlist);
});

document.addEventListener('contextmenu', async (e) => {
  const pl = e.target.closest('.nav-item[data-playlist]');
  if (pl) {
    e.preventDefault();
    const id = pl.dataset.playlist;
    const p = S.playlists.find((x) => x.id === id);
    const choice = await chew.contextMenu([
      { id: 'play', label: 'Play' }, { id: 'shuffle', label: 'Shuffle' }, { type: 'separator' },
      ...(p.smart ? [{ id: 'edit', label: 'Edit Rules…' }] : []),
      { id: 'rename', label: 'Rename' }, { id: 'export', label: 'Export as M3U…' }, { type: 'separator' },
      { id: 'delete', label: 'Delete Playlist' },
    ]);
    const tracks = p.smart ? evaluate(p, S.tracks, 'audio') : p.trackIds.map((t) => S.byId.get(t)).filter(Boolean);
    if (choice === 'edit') editSmartPlaylist(p);
    if (choice === 'play') playFrom(tracks, 0);
    if (choice === 'shuffle') playFrom(tracks, 0, true);
    if (choice === 'rename') startRename(id);
    if (choice === 'export' && (await exportPlaylist(id))) toast('Playlist exported');
    if (choice === 'delete') deletePlaylist(id);
    return;
  }
  const card = e.target.closest('[data-album]');
  if (card) {
    e.preventDefault();
    const a = S.albumByKey.get(card.dataset.album);
    if (a) groupMenu(a.tracks);
    return;
  }
  const artist = e.target.closest('.list-row[data-artist]');
  if (artist) {
    e.preventDefault();
    const a = S.artists.find((x) => x.name === artist.dataset.artist);
    if (a) groupMenu(a.tracks);
    return;
  }
  const folder = e.target.closest('.list-row[data-folder]');
  if (folder) {
    e.preventDefault();
    const dir = folder.dataset.folder;
    const choice = await groupMenu(folderTracks(dir), [{ type: 'separator' }, { id: 'reveal', label: revealLabel() }]);
    if (choice === 'reveal') chew.openFolder(dir);
    return;
  }
  if (!e.target.closest('input')) e.preventDefault();
});

$('#back').addEventListener('click', back);
$('#new-playlist').addEventListener('click', async (e) => {
  e.stopPropagation();
  const choice = await chew.contextMenu([{ id: 'plain', label: 'New Playlist' }, { id: 'smart', label: 'New Smart Playlist…' }, { type: 'separator' }, { id: 'import', label: 'Import Playlist…' }]);
  if (choice === 'plain') newPlaylist();
  if (choice === 'smart') newSmartPlaylist(S.mode || 'audio');
  if (choice === 'import') { const r = await chew.playlists.import(); if (r) { await loadState(); go('playlist', r.playlist.id); } }
});
const shuffled = (list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
$('#play-all').addEventListener('click', () => (S.mode === 'video' ? video.play(S.current?.list || [], 0) : playFrom(S.current?.list || [], 0)));
$('#shuffle-all').addEventListener('click', () => (S.mode === 'video' ? video.play(shuffled(S.current?.list || []), 0) : playFrom(S.current?.list || [], 0, true)));

// ---------------------------------------------------------------- music / video switch

function setMode(mode, navigate = true) {
  S.mode = mode;
  document.body.classList.toggle('mode-video', mode === 'video');
  for (const b of document.querySelectorAll('#mode-switch button')) b.classList.toggle('on', b.dataset.mode === mode);
  renderPlaylists();
  chew.setSetting('mode', mode);
  if (navigate) go(mode === 'video' ? 'vhome' : 'songs');
}
$('#mode-switch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b && b.dataset.mode !== S.mode) setMode(b.dataset.mode);
});

const search = $('#search');
search.addEventListener('input', () => {
  S.search = search.value.trim().toLowerCase();
  clearTimeout(search.t);
  search.t = setTimeout(() => render(false), 120);
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { search.value = ''; S.search = ''; render(false); search.blur(); }
  if (e.key === 'ArrowDown' || e.key === 'Enter') { S.table?.body.focus(); }
});

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest('input, textarea, [contenteditable]');
  if (typing || !$('#modal').hidden) return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  if ((e.metaKey || e.ctrlKey) && e.key === '[') back();
  if (e.key === 'Backspace' && !S.table && S.history.length) back();
});

// Drag tracks onto sidebar playlists; drop files/folders from the OS anywhere.
const isTracks = (e) => e.dataTransfer?.types.includes('application/x-chew-tracks');
const isFiles = (e) => e.dataTransfer?.types.includes('Files');
$('#nav').addEventListener('dragover', (e) => {
  const target = e.target.closest('.nav-item[data-playlist], #new-playlist');
  if (!target || !isTracks(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.querySelectorAll('.drop-target').forEach((x) => x !== target && x.classList.remove('drop-target'));
  target.classList.add('drop-target');
});
$('#nav').addEventListener('dragleave', (e) => e.target.closest?.('.drop-target')?.classList.remove('drop-target'));
$('#nav').addEventListener('drop', (e) => {
  const target = e.target.closest('.nav-item[data-playlist], #new-playlist');
  document.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
  if (!target || !isTracks(e)) return;
  e.preventDefault();
  const ids = JSON.parse(e.dataTransfer.getData('application/x-chew-tracks'));
  if (target.id === 'new-playlist') newPlaylist(ids); else addToPlaylist(target.dataset.playlist, ids);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (isFiles(e) && !isTracks(e)) { dragDepth++; $('#drop-overlay').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (isFiles(e) && !isTracks(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => { if (isFiles(e) && !isTracks(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!isFiles(e) || isTracks(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => chew.pathForFile(f)).filter(Boolean);
  if (paths.length) chew.openPaths(paths);
});

chew.onCommand(async (cmd) => {
  if (cmd === 'toggle') player.toggle();
  else if (cmd === 'next') player.next();
  else if (cmd === 'prev') player.prev();
  else if (cmd === 'vol-up') setVolume(player.volume + 0.05);
  else if (cmd === 'vol-down') setVolume(player.volume - 0.05);
  else if (cmd === 'shuffle') $('#btn-shuffle').click();
  else if (cmd === 'repeat') $('#btn-repeat').click();
  else if (cmd === 'find') { if (S.current?.noSearch) go('songs'); search.focus(); search.select(); }
  else if (cmd === 'new-playlist') newPlaylist();
  else if (cmd.startsWith('show-playlist:')) { await loadState(); go('playlist', cmd.slice(14)); }
});

// ---------------------------------------------------------------- play counts

// A song counts as played once half of it (at most 4 minutes) has actually been heard, like scrobblers do.
const listen = { id: null, secs: 0, counted: false, last: 0 };
player.addEventListener('track', () => Object.assign(listen, { id: player.currentId, secs: 0, counted: false, last: player.currentTime }));
player.addEventListener('time', () => {
  const t = player.currentTime;
  const delta = t - listen.last;
  listen.last = t;
  if (!player.playing || listen.counted || listen.id !== player.currentId) return;
  if (delta > 0 && delta < 2) listen.secs += delta;
  if (listen.secs >= Math.min((player.duration || 480) / 2, 240)) {
    listen.counted = true;
    const tr = S.byId.get(listen.id);
    if (tr) { tr.plays = (tr.plays || 0) + 1; tr.lastPlayed = Date.now(); }
    chew.markPlayed(listen.id);
  }
});

// First start: a few classic smart playlists to show what they can do.
async function seedSmartPlaylists() {
  if (S.settings.smartSeeded) return;
  const seeds = [
    ['Top Rated', { match: 'all', rules: [{ field: 'rating', op: 'gt', value: '3' }], limit: null }],
    ['Recently Added', { match: 'all', rules: [{ field: 'added', op: 'inLast', value: '30', unit: 'days' }], limit: { count: 200, by: 'newest' } }],
    ['Most Played', { match: 'all', rules: [{ field: 'plays', op: 'gt', value: '0' }], limit: { count: 50, by: 'mostPlayed' } }],
    ['Never Played', { match: 'all', rules: [{ field: 'lastPlayed', op: 'never' }], limit: null }],
  ];
  for (const [name, smart] of seeds) await chew.playlists.create(name, [], { kind: 'audio', smart });
  S.settings.smartSeeded = true;
  await chew.setSetting('smartSeeded', true);
  await loadState();
}

// ---------------------------------------------------------------- session

// Queue and position survive restarts. The full queue is only sent when it changes;
// while playing just the position is updated every few seconds.
let lastSessionSave = 0;
function saveSession(full) {
  if (!player.queue.length) return;
  const snap = player.snapshot();
  chew.session.set(full ? snap : { pos: snap.pos, time: snap.time });
  lastSessionSave = Date.now();
}
player.addEventListener('queue', () => saveSession(true));
player.addEventListener('track', () => saveSession(true));
player.addEventListener('state', () => saveSession(false));
player.addEventListener('time', () => { if (Date.now() - lastSessionSave > 3000) saveSession(false); });
window.addEventListener('beforeunload', () => saveSession(true));

// ---------------------------------------------------------------- output devices

async function refreshDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const outs = all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
    S.devices = outs.map((d) => ({
      deviceId: d.deviceId,
      label: d.deviceId === 'default' ? `System default${d.label ? ` (${d.label.replace(/^Default - /, '')})` : ''}` : d.label || 'Unknown device',
    }));
  } catch {
    S.devices = [];
  }
  const wanted = S.settings.outputDevice || 'default';
  // A device that was unplugged falls back to the system default until it comes back.
  const target = S.devices.some((d) => d.deviceId === wanted) ? wanted : 'default';
  if (target !== S.activeDevice) {
    S.activeDevice = target;
    await player.setOutputDevice(target);
  }
  const sel = $('#output-select');
  if (sel) sel.innerHTML = outputOptions();
}

async function chooseOutput(deviceId) {
  S.settings.outputDevice = deviceId;
  chew.setSetting('outputDevice', deviceId);
  S.activeDevice = deviceId;
  const ok = await player.setOutputDevice(deviceId);
  const name = S.devices.find((d) => d.deviceId === deviceId)?.label || 'device';
  toast(ok ? `Playing through ${name}` : `Couldn’t switch to ${name}`);
  const sel = $('#output-select');
  if (sel) sel.innerHTML = outputOptions();
}

navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);

$('#btn-output').addEventListener('click', async () => {
  await refreshDevices();
  const current = S.activeDevice || 'default';
  const choice = await chew.contextMenu(S.devices.map((d) => ({ id: d.deviceId, label: d.label, checked: d.deviceId === current })));
  if (choice) chooseOutput(choice);
});

// ---------------------------------------------------------------- updates

function setUpdate(st) {
  S.update = st;
  const banner = $('#update');
  const show = st && ['available', 'downloading', 'ready'].includes(st.state);
  banner.hidden = !show;
  if (show) {
    $('#update-label').textContent = st.state === 'downloading' ? `Downloading ${st.version}… ${st.percent || 0}%` : `Chew Player ${st.version} is available`;
    const btn = $('#update-btn');
    btn.hidden = st.state === 'downloading';
    btn.textContent = st.state === 'ready' ? 'Restart & Update' : 'Download';
  }
  if (S.view === 'settings') render();
}
chew.onUpdateStatus(setUpdate);
$('#update-btn').addEventListener('click', () => chew.updates.install());

// ---------------------------------------------------------------- casting

const PROTOCOLS = { airplay: 'AirPlay', cast: 'Google Cast', dlna: 'DLNA' };
const cast = { status: { active: false }, deviceId: null };
const castingAudio = () => cast.status.active && cast.status.kind === 'audio';

async function chooseDevice(kind) {
  const devices = (await chew.cast.devices()).filter((d) => kind === 'audio' || d.video);
  cast.devices = devices;
  const st = cast.status;
  const items = [{ id: 'local', label: 'This Computer', checked: !st.active }];
  if (devices.length) {
    for (const proto of ['airplay', 'cast', 'dlna']) {
      const group = devices.filter((d) => d.protocol === proto);
      if (!group.length) continue;
      items.push({ type: 'separator' }, { label: PROTOCOLS[proto], enabled: false });
      for (const d of group) items.push({ id: d.id, label: d.name, checked: st.active && st.deviceId === d.id });
    }
  } else {
    items.push({ type: 'separator' }, { label: 'Looking for TVs and receivers…', enabled: false });
    if (S.info.platform === 'darwin') items.push({ id: 'perm', label: 'No TV? Check “Local Network” Permission…' });
  }
  items.push({ type: 'separator' }, { id: 'manual', label: 'Connect by IP Address…' }, { id: 'help', label: 'Apple TV, Android TV & Fire TV help…' });
  const choice = await chew.contextMenu(items);
  if (choice === 'help') { showCastHelp(); return null; }
  if (choice === 'perm') { chew.cast.networkSettings(); return null; }
  if (choice === 'manual') return manualDeviceDialog();
  return choice;
}

// ---- music on a TV

async function castMusic(deviceId, start) {
  if (!player.track) { toast('Pick a song first'); return; }
  cast.deviceId = deviceId;
  player.pause();
  const r = await chew.cast.play({ deviceId, kind: 'audio', id: player.currentId, start: start ?? player.currentTime });
  if (r?.state === 'error') toast(r.message);
}

async function castMusicStep(dir, auto = false) {
  let pos = dir > 0 ? (auto ? player.peekNext() : player.pos + 1) : player.pos - 1;
  if (dir > 0 && pos >= player.order.length) pos = player.repeat !== 'off' ? 0 : null;
  if (pos == null || pos < 0) { if (auto) chew.cast.control('stop'); return; }
  player.cue(pos);
  await castMusic(cast.deviceId, 0);
}

$('#btn-cast').addEventListener('click', async () => {
  const choice = await chooseDevice('audio');
  if (!choice) return;
  if (choice === 'local') {
    if (!castingAudio()) return;
    const at = cast.status.position;
    await chew.cast.control('stop');
    player.load(true, at);
    return;
  }
  castMusic(choice);
});

// ---- video on a TV (called by the video player)

async function castVideo(action, arg) {
  const vp = video.player;
  if (action === 'menu') {
    const choice = await chooseDevice('video');
    if (!choice) return;
    if (choice === 'local') {
      if (!vp.remote) return;
      const at = cast.status.position || vp.time;
      await chew.cast.control('stop');
      vp.setRemote(null);
      vp.load(vp.item.playback === 'native' ? 'native' : vp.item.playback, at, true);
      return;
    }
    cast.deviceId = choice;
    const at = vp.time;
    vp.video.pause();
    vp.setRemote({ state: 'connecting', deviceName: cast.devices?.find?.((d) => d.id === choice)?.name || 'TV', position: at, duration: vp.duration });
    const r = await chew.cast.play({ deviceId: choice, kind: 'video', id: vp.item.id, start: at, audio: vp.audioIndex, subtitle: vp.subIndex });
    if (r?.state === 'error') { toast(r.message); vp.setRemote(null); }
    return;
  }
  if (action === 'load') return chew.cast.play({ deviceId: cast.deviceId, kind: 'video', id: arg.item.id, start: arg.at, audio: vp.audioIndex, subtitle: vp.subIndex });
  if (action === 'stop') { vp.remote = null; return chew.cast.control('stop'); }
  return chew.cast.control(action, arg);
}

chew.onCastDevices((list) => { cast.devices = list; });

chew.onCastStatus((st) => {
  const prev = cast.status;
  cast.status = st;
  if (st.state === 'pin-required') { pairDialog(st); return; }
  if (st.state === 'error') { toast(st.message || 'Casting failed'); }
  const vp = video.player;
  if (st.active && st.kind === 'video') {
    if (vp.item) vp.setRemote(st);
    if (st.state === 'ended') { if (vp.index < vp.queue.length - 1) vp.next(); else { chew.cast.control('stop'); vp.remote = null; vp.close(); } }
  } else if (vp.remote && !st.active) {
    vp.setRemote(null);
  }
  if (st.active && st.kind === 'audio') {
    if (st.state === 'ended' && prev.state !== 'ended') castMusicStep(1, true);
    renderCastMusic();
  } else if (prev.active && prev.kind === 'audio') {
    renderCastMusic();
  }
});

function renderCastMusic() {
  const on = castingAudio();
  $('#btn-cast').classList.toggle('on', on);
  $('#btn-cast').style.color = on ? 'var(--accent)' : '';
  if (on) {
    $('#now-tech').textContent = `▶ ${cast.status.deviceName}`;
    setIcon($('#btn-play'), cast.status.state === 'playing' || cast.status.state === 'buffering' ? 'pause' : 'play');
  } else {
    renderNowPlaying();
    setIcon($('#btn-play'), player.playing ? 'pause' : 'play');
  }
  renderTime();
}

function pairDialog(st) {
  const modal = $('#modal');
  modal.innerHTML = `<div class="modal">
    <h2>Pair with ${esc(st.deviceName)}</h2>
    <div class="sub">This Apple TV only accepts paired devices. A 4-digit code is now shown on your TV — enter it here. You only have to do this once.</div>
    <form class="form" onsubmit="return false"><label class="wide">Code on the TV<input id="pin" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="1234"></label></form>
    <div class="hint" id="pin-msg" style="margin-top:10px"></div>
    <div class="modal-actions"><div></div><div><button class="btn ghost" data-m="cancel">Cancel</button><button class="btn" data-m="pair">Pair</button></div></div>
  </div>`;
  modal.hidden = false;
  const msg = $('#pin-msg');
  chew.cast.pairStart(st.deviceId).then(() => $('#pin').focus()).catch((e) => { msg.textContent = `Couldn’t start pairing: ${e.message}`; });
  const close = () => { modal.hidden = true; modal.innerHTML = ''; modal.onclick = modal.onkeydown = null; };
  const pair = async () => {
    msg.textContent = 'Pairing…';
    try {
      await chew.cast.pairFinish(st.deviceId, $('#pin').value.trim());
      close();
      toast(`Paired with ${st.deviceName}`);
      const r = await chew.cast.play(st.pending);
      if (r?.state === 'error') toast(r.message);
    } catch (e) {
      msg.textContent = /PIN/i.test(e.message) ? 'That code didn’t work. Check the TV and try again.' : e.message;
    }
  };
  modal.onclick = (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (m === 'cancel' || e.target === modal) { close(); video.player.setRemote(null); }
    if (m === 'pair') pair();
  };
  modal.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); pair(); } if (e.key === 'Escape') close(); };
}

// Resolves with the new device id (or null) so the caller can start casting right away.
function manualDeviceDialog() {
  return new Promise((resolve) => {
    const modal = $('#modal');
    modal.innerHTML = `<div class="modal">
      <h2>Connect by IP Address</h2>
      <div class="sub">If your TV doesn’t show up automatically, enter its IP address. You find it in the TV’s network settings (Apple TV: Settings › Network).</div>
      <form class="form" onsubmit="return false">
        <label>Type<select id="md-type"><option value="airplay">Apple TV (AirPlay)</option><option value="cast">Google Cast / Android TV</option></select></label>
        <label>IP address<input id="md-host" placeholder="192.168.1.20" autocomplete="off"></label>
      </form>
      <div class="hint" id="md-msg" style="margin-top:10px"></div>
      <div class="modal-actions"><div></div><div><button class="btn ghost" data-m="cancel">Cancel</button><button class="btn" data-m="add">Connect</button></div></div>
    </div>`;
    modal.hidden = false;
    $('#md-host').focus();
    const close = (v) => { modal.hidden = true; modal.innerHTML = ''; modal.onclick = modal.onkeydown = null; resolve(v); };
    const add = async () => {
      $('#md-msg').textContent = 'Connecting…';
      try {
        const d = await chew.cast.addManual({ protocol: $('#md-type').value, host: $('#md-host').value });
        toast(`Added ${d.name}`);
        close(d.id);
      } catch (e) {
        $('#md-msg').textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      }
    };
    modal.onclick = (e) => { const m = e.target.closest('[data-m]')?.dataset.m; if (m === 'cancel' || e.target === modal) close(null); if (m === 'add') add(); };
    modal.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') close(null); };
  });
}

function showCastHelp() {
  const modal = $('#modal');
  modal.innerHTML = `<div class="modal wide">
    <h2>Playing on your TV</h2>
    <div class="sub">Your computer and the TV must be on the same network. Chew Player converts files the TV can’t play on the fly.</div>
    <div class="help">
      <h4>${icon('tv')}Apple TV — AirPlay</h4>
      <p>Appears automatically. The first time, the Apple TV shows a 4-digit code that you enter in Chew Player.</p>
      <h4>${icon('tv')}Android TV, Google TV, Chromecast — Google Cast</h4>
      <p>Appears automatically on TVs with “Chromecast built-in” (Sony, Philips, TCL, Nvidia Shield, Chromecast with Google TV, …).</p>
      <h4>${icon('tv')}Amazon Fire TV Stick</h4>
      <p>Fire TV has no built-in way to receive from a computer. Install a free receiver app from the Amazon Appstore, for example <b>AirScreen</b> (receives AirPlay, Google Cast and DLNA) or <b>Kodi</b> (enable <i>Settings → Services → UPnP/DLNA → Allow remote control</i>). The Fire TV then shows up here.</p>
      <h4>${icon('tv')}Smart TVs (Samsung, LG, Panasonic, …) — DLNA</h4>
      <p>Most smart TVs appear automatically as DLNA receivers. Turn on media sharing / DLNA in the TV’s network settings if yours doesn’t.</p>
      ${S.info.platform === 'win32' ? '<p class="hint">Windows may ask whether Chew Player may use the network — allow it for private networks so the TV can fetch the video.</p>' : '<p class="hint">If macOS asks whether Chew Player may accept incoming connections, allow it so the TV can fetch the video.</p>'}
    </div>
    <div class="modal-actions"><div></div><div><button class="btn" data-m="ok">Got it</button></div></div>
  </div>`;
  hydrateIcons(modal);
  modal.hidden = false;
  modal.onclick = (e) => { if (e.target === modal || e.target.closest('[data-m]')) { modal.hidden = true; modal.innerHTML = ''; } };
}

// ---------------------------------------------------------------- video

const video = initVideo({
  S,
  go: (...a) => go(...a),
  render: (keep) => render(keep),
  newPlaylist: (ids, kind) => newPlaylist(ids, kind),
  addToPlaylist: (pid, ids) => addToPlaylist(pid, ids),
  playlistSubmenu: (kind) => playlistSubmenu(kind),
  emptyResult: (t) => emptyResult(t),
  pauseMusic: () => player.pause(),
  castVideo: (action, arg) => castVideo(action, arg),
});
window.chewVideo = video;

// ---------------------------------------------------------------- boot

(async function boot() {
  document.documentElement.style.setProperty('--note-mask', noteMask);
  S.info = await chew.info();
  document.body.classList.add(`platform-${S.info.platform}`);
  player.ffmpeg = S.info.ffmpeg;
  hydrateIcons();
  await loadState();
  await seedSmartPlaylists();
  player.shuffle = !!S.settings.shuffle;
  player.repeat = S.settings.repeat || 'off';
  player.gapless = S.settings.gapless !== false;
  player.setReplayGain(S.settings.replayGain || 'auto');
  setVolume(S.settings.volume ?? 0.8, false);
  await refreshDevices();
  const session = await chew.session.get();
  if (session) player.restore(session);
  setUpdate(await chew.updates.status());
  window.chewPlayer = player; // handy in DevTools
  syncToggles();
  renderNowPlaying();
  renderTime();
  await video.load();
  video.player.setVolume(S.settings.videoVolume ?? 0.8);
  setMode(S.settings.mode === 'video' ? 'video' : 'audio', false);
  go(S.mode === 'video' ? 'vhome' : 'songs', null, false);
})();
