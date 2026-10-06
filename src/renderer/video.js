// Video side of Chew Player: library views (Home, Movies, TV Shows, Folders, playlists) and the
// glue to the in-app player. Same principle as music: folders in, info filled in from open databases.

import { $, esc, collator, plural, coverUrl, coverDiv, sortName, toast, el } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { TrackTable, fmtTime } from './table.js';
import { evaluate, describe } from './smart.js';
import { VideoPlayer, stageHtml } from './video-player.js';

const chew = window.chew;

export function initVideo(app) {
  const { S } = app;
  const V = { items: [], byId: new Map(), folders: [], shows: [], showByKey: new Map() };

  const showKey = (n) => (n || '').toLowerCase();
  const progressPct = (it) => (it.duration && it.position ? Math.min(100, (it.position / it.duration) * 100) : 0);
  const epLabel = (it) => `S${it.season} · E${String(it.episode).padStart(2, '0')}`;
  const matches = (it) => !S.search || S.search.split(/\s+/).every((w) => `${it.title} ${it.show || ''} ${it.year || ''} ${it.genre || ''}`.toLowerCase().includes(w));

  async function load() {
    const st = await chew.video.state();
    V.items = st.items;
    V.folders = st.folders;
    V.byId = new Map(V.items.map((i) => [i.id, i]));
    const shows = new Map();
    for (const it of V.items) {
      if (it.type !== 'episode') continue;
      const k = showKey(it.show);
      if (!shows.has(k)) shows.set(k, { key: k, name: it.show, poster: null, year: null, genre: null, summary: null, episodes: [] });
      const s = shows.get(k);
      s.episodes.push(it);
      s.poster = s.poster || it.poster;
      s.summary = s.summary || it.showSummary;
      s.genre = s.genre || it.genre;
      if (it.year && (!s.year || it.year < s.year)) s.year = it.year;
    }
    for (const s of shows.values()) s.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    V.shows = [...shows.values()].sort((a, b) => collator.compare(sortName(a.name), sortName(b.name)));
    V.showByKey = shows;
  }

  // ---------------------------------------------------------------- player

  const stage = $('#vstage');
  stage.innerHTML = stageHtml();
  hydrateIcons(stage);
  const player = new VideoPlayer({
    chew,
    getItem: (id) => V.byId.get(id),
    onOpen: () => app.pauseMusic(),
    onClose: () => { load().then(() => app.render(true)); },
    onCast: (action, arg) => app.castVideo(action, arg),
  });
  player.setVolume(S.settings.videoVolume ?? 0.8);

  function play(list, i = 0, { resume = true } = {}) {
    const items = list.filter(Boolean);
    if (!items.length) return;
    player.open(items[i], { queue: items, index: i, resume });
  }

  // Episodes continue with the rest of their show; movies play alone.
  function playItem(it, opts) {
    if (it.type === 'episode') {
      const show = V.showByKey.get(showKey(it.show));
      const eps = show ? show.episodes : [it];
      return play(eps, Math.max(0, eps.indexOf(eps.find((e) => e.id === it.id))), opts);
    }
    return play([it], 0, opts);
  }

  // ---------------------------------------------------------------- building blocks

  const posterCard = (it) => `
    <div class="card vcard" data-vplay="${it.id}">
      <div class="poster-wrap">${coverDiv(it.poster || it.still, 'poster')}${it.watched ? '<span class="badge-watched">✓</span>' : ''}
        ${progressPct(it) ? `<div class="vprogress"><div style="width:${progressPct(it)}%"></div></div>` : ''}</div>
      <div class="card-title">${esc(it.title)}</div>
      <div class="card-sub">${[it.year, it.genre].filter(Boolean).map(esc).join(' · ')}</div>
    </div>`;

  const wideCard = (it) => `
    <div class="card vwide" data-vplay="${it.id}">
      <div class="poster-wrap">${coverDiv(it.still || it.poster, 'still')}
        ${progressPct(it) ? `<div class="vprogress"><div style="width:${progressPct(it)}%"></div></div>` : ''}
        <span class="play-overlay">${icon('play')}</span></div>
      <div class="card-title">${esc(it.type === 'episode' ? it.show : it.title)}</div>
      <div class="card-sub">${esc(it.type === 'episode' ? `${epLabel(it)} · ${it.title}` : [it.year, it.genre].filter(Boolean).join(' · '))}</div>
    </div>`;

  const showCard = (s) => {
    const watched = s.episodes.filter((e) => e.watched).length;
    return `<div class="card vcard" data-show="${esc(s.key)}">
      <div class="poster-wrap">${coverDiv(s.poster || s.episodes[0]?.still, 'poster')}${watched === s.episodes.length ? '<span class="badge-watched">✓</span>' : ''}</div>
      <div class="card-title">${esc(s.name)}</div>
      <div class="card-sub">${plural(s.episodes.length, 'episode')}${s.year ? ` · ${s.year}` : ''}</div>
    </div>`;
  };

  function welcome() {
    return el(`<div class="empty-state">
      <img src="logo.svg" alt="">
      <h2>Your videos, by folder</h2>
      <p>Add the folders with your movies and TV shows. Chew Player recognises movies and episodes from their file names, fills in posters and descriptions from Wikipedia and TVMaze, and remembers where you stopped.</p>
      <button class="btn" data-act="add-video-folder">${icon('folder')}Add Video Folder</button>
    </div>`);
  }

  function videoTable(list, opts = {}) {
    const t = new TrackTable({
      columns: opts.columns || ['index', 'vtitle', 'vyear', 'vgenre', 'res', 'time', 'format', 'vstate'],
      tracks: list,
      onPlay: (i) => play(list, i),
      onContext: (ids) => itemMenu(ids, opts.context || {}),
      onReorder: opts.onReorder,
      onDelete: opts.onDelete,
      isPlaying: (it) => player.item?.id === it.id,
    });
    S.table = t;
    return t.el;
  }

  // ---------------------------------------------------------------- views

  const views = {
    vhome() {
      if (!V.folders.length) return { title: 'Home', el: welcome() };
      const cont = V.items.filter((i) => i.inProgress).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 12);
      // Next unwatched episode of shows you've started.
      const upNext = [];
      for (const s of V.shows) {
        const started = s.episodes.some((e) => e.watched || e.inProgress);
        const next = s.episodes.find((e) => !e.watched);
        if (started && next && !cont.includes(next)) upNext.push(next);
      }
      const recent = [...V.items].sort((a, b) => (b.added || 0) - (a.added || 0)).slice(0, 18);
      const movies = V.items.filter((i) => i.type === 'movie' && !i.watched).sort(() => Math.random() - 0.5).slice(0, 12);
      const section = (title, html, cls = '') => (html ? `<h3 class="shelf-title">${title}</h3><div class="shelf ${cls}">${html}</div>` : '');
      const d = el(`<div class="scroll"><div class="pad">
        ${section('Continue Watching', cont.map(wideCard).join(''))}
        ${section('Up Next', upNext.slice(0, 12).map(wideCard).join(''))}
        ${section('Recently Added', recent.map(wideCard).join(''))}
        ${section('Movies You Haven’t Watched', movies.map(posterCard).join(''), 'posters')}
        ${!V.items.length ? '<p class="hint">Scanning your video folders…</p>' : ''}
      </div></div>`);
      return { title: 'Home', subtitle: `${plural(V.items.filter((i) => i.type === 'movie').length, 'movie')} · ${plural(V.shows.length, 'show')}`, el: d, noSearch: true, list: cont };
    },

    movies() {
      if (!V.folders.length) return { title: 'Movies', el: welcome() };
      const list = V.items.filter((i) => i.type === 'movie' && matches(i)).sort((a, b) => collator.compare(sortName(a.title), sortName(b.title)));
      const d = el(list.length ? `<div class="scroll"><div class="pad"><div class="grid posters">${list.map(posterCard).join('')}</div></div></div>` : '<div class="empty-state"><p>No movies found.</p></div>');
      return { title: 'Movies', subtitle: plural(list.length, 'movie'), list, el: d };
    },

    movie(id) {
      const it = V.byId.get(id);
      if (!it) return views.movies();
      const audio = it.audio?.map((a) => a.label).join(', ');
      const subs = it.subs?.map((s) => s.label).join(', ');
      const d = el(`<div class="scroll"><div class="vdetail">
        ${coverDiv(it.poster || it.still, 'poster big')}
        <div class="vinfo">
          <div class="kicker">${it.type === 'episode' ? esc(it.show) : 'Movie'}</div>
          <h2>${esc(it.title)}</h2>
          <div class="meta">${[it.year, it.genre, it.duration && fmtTime(it.duration), it.height && `${it.height}p`, it.director && `Directed by ${it.director}`].filter(Boolean).map(esc).join(' · ')}</div>
          ${it.summary ? `<p class="summary">${esc(it.summary)}</p>` : ''}
          ${progressPct(it) ? `<div class="vprogress inline"><div style="width:${progressPct(it)}%"></div></div><div class="hint">${fmtTime(it.duration - it.position)} left</div>` : ''}
          <div class="actions">
            <button class="btn" data-vact="play">${icon('play')}${it.inProgress ? `Resume from ${fmtTime(it.position)}` : 'Play'}</button>
            ${it.inProgress ? `<button class="btn ghost" data-vact="restart">Play from Beginning</button>` : ''}
            <button class="btn ghost" data-vact="${it.watched ? 'unwatched' : 'watched'}">${it.watched ? 'Mark as Unwatched' : 'Mark as Watched'}</button>
            <button class="btn ghost" data-vact="lookup">${icon('globe')}Look Up Online</button>
          </div>
          <div class="file-info">
            <span>File</span><b>${esc(it.path)}</b>
            <span>Video</span><b>${esc([it.vcodec?.toUpperCase(), it.width && `${it.width}×${it.height}`].filter(Boolean).join(' · ') || '—')}</b>
            ${audio ? `<span>Audio</span><b>${esc(audio)}</b>` : ''}
            ${subs ? `<span>Subtitles</span><b>${esc(subs)}</b>` : ''}
            <span>Playback</span><b>${{ native: 'Native', remux: 'Re-wrapped on the fly (FFmpeg)', transcode: 'Converted on the fly (FFmpeg)' }[it.playback]}</b>
          </div>
        </div>
      </div></div>`);
      d.dataset.vid = it.id;
      return { title: it.title, subtitle: it.type === 'episode' ? `${it.show} · ${epLabel(it)}` : '', el: d, noSearch: true, ownActions: true };
    },

    shows() {
      if (!V.folders.length) return { title: 'TV Shows', el: welcome() };
      const list = V.shows.filter((s) => !S.search || s.name.toLowerCase().includes(S.search));
      const d = el(list.length ? `<div class="scroll"><div class="pad"><div class="grid posters">${list.map(showCard).join('')}</div></div></div>` : '<div class="empty-state"><p>No TV shows found. Episodes are recognised by names like “Show S01E02” or “Show/Season 1/02 Title”.</p></div>');
      return { title: 'TV Shows', subtitle: plural(list.length, 'show'), el: d, list: list.flatMap((s) => s.episodes) };
    },

    show(key) {
      const s = V.showByKey.get(key);
      if (!s) return views.shows();
      const seasons = new Map();
      for (const e of s.episodes) { if (!seasons.has(e.season)) seasons.set(e.season, []); seasons.get(e.season).push(e); }
      const next = s.episodes.find((e) => !e.watched) || s.episodes[0];
      const d = el(`<div class="scroll">
        <div class="vdetail">
          ${coverDiv(s.poster || s.episodes[0]?.still, 'poster big')}
          <div class="vinfo">
            <div class="kicker">TV Show</div>
            <h2>${esc(s.name)}</h2>
            <div class="meta">${[s.year, s.genre, plural(seasons.size, 'season'), plural(s.episodes.length, 'episode')].filter(Boolean).map(esc).join(' · ')}</div>
            ${s.summary ? `<p class="summary">${esc(s.summary)}</p>` : ''}
            <div class="actions">
              <button class="btn" data-vplay="${next.id}">${icon('play')}${next.inProgress ? 'Resume' : 'Play'} ${epLabel(next)}</button>
              <button class="btn ghost" data-vact="lookup-show">${icon('globe')}Look Up Online</button>
            </div>
          </div>
        </div>
        ${[...seasons.entries()].map(([n, eps]) => `
          <h3 class="season-title">Season ${n} <span>${plural(eps.length, 'episode')}</span></h3>
          <div class="episodes">${eps.map((e) => `
            <div class="episode" data-vplay="${e.id}" data-vid="${e.id}">
              <div class="poster-wrap">${coverDiv(e.still || e.poster, 'still')}
                ${progressPct(e) ? `<div class="vprogress"><div style="width:${progressPct(e)}%"></div></div>` : ''}<span class="play-overlay">${icon('play')}</span></div>
              <div class="ep-text">
                <div class="ep-title">${e.episode}. ${esc(e.title)} ${e.watched ? '<span class="watched">✓</span>' : ''}</div>
                <div class="hint">${[e.duration && fmtTime(e.duration), e.height && `${e.height}p`, e.format].filter(Boolean).join(' · ')}</div>
                ${e.summary ? `<div class="ep-summary">${esc(e.summary)}</div>` : ''}
              </div>
            </div>`).join('')}</div>`).join('')}
      </div>`);
      return { title: s.name, subtitle: '', el: d, list: s.episodes, noSearch: true, ownActions: true };
    },

    vfolders(dir) {
      if (!V.folders.length) return { title: 'Folders', el: welcome() };
      const sep = S.info.platform === 'win32' ? '\\' : '/';
      const lc = (p) => (S.info.platform === 'win32' ? p.toLowerCase() : p);
      if (!dir) {
        const rows = V.folders.map((r) => `<div class="list-row" data-vfolder="${esc(r)}">${icon('folder')}<div class="name">${esc(r)}</div><div class="meta">${plural(V.items.filter((i) => lc(i.path).startsWith(lc(r) + sep)).length, 'video')}</div>${icon('chevron')}</div>`).join('');
        return { title: 'Folders', subtitle: plural(V.folders.length, 'video folder'), el: el(`<div class="scroll">${rows}<div class="pad" style="padding-top:16px"><button class="btn ghost" data-act="add-video-folder">${icon('plus')}Add Video Folder…</button></div></div>`), noSearch: true };
      }
      const prefix = lc(dir) + sep;
      const subs = new Map();
      const here = [];
      for (const it of V.items) {
        if (!lc(it.path).startsWith(prefix)) continue;
        const rest = it.path.slice(prefix.length);
        const cut = rest.indexOf(sep);
        if (cut < 0) { if (matches(it)) here.push(it); continue; }
        const name = rest.slice(0, cut);
        if (!subs.has(name)) subs.set(name, 0);
        subs.set(name, subs.get(name) + 1);
      }
      here.sort((a, b) => collator.compare(a.path, b.path));
      const root = V.folders.find((r) => lc(dir) === lc(r) || lc(dir).startsWith(lc(r) + sep)) || dir;
      const crumbs = [{ label: root.split(sep).filter(Boolean).pop() || root, path: root }];
      let acc = root;
      for (const part of dir.slice(root.length).split(sep).filter(Boolean)) { acc += (acc.endsWith(sep) ? '' : sep) + part; crumbs.push({ label: part, path: acc }); }
      const subList = [...subs.entries()].sort((a, b) => collator.compare(a[0], b[0]));
      const d = el(`
        <div class="breadcrumb"><button data-vfolder="">Folders</button>${crumbs.map((c) => `${icon('chevron')}<button data-vfolder="${esc(c.path)}">${esc(c.label)}</button>`).join('')}</div>
        ${subList.length ? `<div class="scroll" style="${here.length ? 'flex:none;max-height:40%' : ''}">${subList.map(([n, c]) => `<div class="list-row" data-vfolder="${esc(dir + sep + n)}">${icon('folder')}<div class="name">${esc(n)}</div><div class="meta">${plural(c, 'video')}</div>${icon('chevron')}</div>`).join('')}</div>` : ''}`);
      for (const i of d.querySelectorAll('.breadcrumb i')) { i.style.width = '12px'; i.style.height = '12px'; }
      if (here.length) d.append(videoTable(here));
      return { title: crumbs[crumbs.length - 1].label, subtitle: '', list: here, el: d };
    },
  };

  function playlistView(p) {
    const list = p.smart ? evaluate(p, V.items, 'video') : p.trackIds.map((id) => V.byId.get(id) || { id, title: 'Missing file', missing: true });
    const d = el(`<div class="detail-head" style="padding-bottom:12px"><div>
      ${p.smart ? `<div class="smart-desc">${icon('smart')}<span>${esc(describe(p.smart, 'video'))}</span></div>` : ''}
      <div class="actions">
        <button class="btn" data-act="vplay-list">${icon('play')}Play</button>
        ${p.smart ? '<button class="btn ghost" data-act="edit-smart">Edit Rules…</button>' : '<button class="btn ghost" data-act="rename-playlist">Rename</button>'}
        <button class="btn danger" data-act="delete-playlist">Delete</button>
      </div></div></div>`);
    if (!list.length) d.append(app.emptyResult(p.smart ? 'No videos match these rules yet.' : 'This playlist is empty. Right-click videos and choose “Add to Playlist”, or drag them onto it.'));
    else {
      d.append(videoTable(list, {
        onReorder: p.smart ? null : (idx, at) => {
          const ids = [...p.trackIds];
          const moving = idx.map((i) => ids[i]);
          const before = idx.filter((i) => i < at).length;
          for (const i of [...idx].sort((a, b) => b - a)) ids.splice(i, 1);
          ids.splice(at - before, 0, ...moving);
          p.trackIds = ids;
          chew.playlists.update(p.id, { trackIds: ids });
          app.render();
        },
        onDelete: p.smart ? null : (idx) => { const drop = new Set(idx); p.trackIds = p.trackIds.filter((_, i) => !drop.has(i)); chew.playlists.update(p.id, { trackIds: p.trackIds }); app.render(); },
        context: p.smart ? {} : { playlist: p },
      }));
    }
    const dur = list.reduce((s, i) => s + (i.duration || 0), 0);
    return { title: p.name, subtitle: `${plural(list.length, 'video')} · ${fmtTime(dur)}`, list: list.filter((i) => !i.missing), el: d, noSearch: true, ownActions: true };
  }

  // ---------------------------------------------------------------- menus & info

  async function itemMenu(ids, ctx = {}) {
    const items = ids.map((id) => V.byId.get(id)).filter(Boolean);
    if (!items.length) return;
    const one = items.length === 1 ? items[0] : null;
    const menu = [
      { id: 'play', label: one?.inProgress ? `Resume from ${fmtTime(one.position)}` : 'Play' },
      ...(one?.inProgress ? [{ id: 'restart', label: 'Play from Beginning' }] : []),
      { type: 'separator' },
      { id: 'watched', label: 'Mark as Watched' },
      { id: 'unwatched', label: 'Mark as Unwatched' },
      { label: 'Add to Playlist', submenu: app.playlistSubmenu('video') },
      { type: 'separator' },
      { id: 'info', label: items.length > 1 ? 'Edit Info…' : 'Get Info…' },
      { id: 'lookup', label: 'Look Up Online' },
      { id: 'reveal', label: S.info.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer', enabled: !!one },
      ...(ctx.playlist ? [{ type: 'separator' }, { id: 'remove-pl', label: 'Remove from Playlist' }] : []),
    ];
    const c = await chew.contextMenu(menu);
    if (!c) return;
    if (c === 'play') { if (one) playItem(one); else play(items, 0); }
    if (c === 'restart') playItem(one, { resume: false });
    if (c === 'watched' || c === 'unwatched') { await chew.video.setWatched(ids, c === 'watched'); }
    if (c === 'pl:new') app.newPlaylist(ids, 'video');
    else if (c.startsWith('pl:')) app.addToPlaylist(c.slice(3), ids);
    if (c === 'info') openInfo(items);
    if (c === 'lookup') { chew.video.fetch(ids); toast('Looking up info online…'); }
    if (c === 'reveal') chew.video.reveal(one.id);
    if (c === 'remove-pl') { const drop = new Set(S.table.selectedIndices()); const p = ctx.playlist; p.trackIds = p.trackIds.filter((_, i) => !drop.has(i)); chew.playlists.update(p.id, { trackIds: p.trackIds }); app.render(); }
  }

  function openInfo(items) {
    const one = items.length === 1 ? items[0] : null;
    const common = (f) => { const s = new Set(items.map((i) => i[f] ?? '')); return s.size === 1 ? [...s][0] : null; };
    const fields = [['title', 'Title', 'wide'], ['year', 'Year'], ['genre', 'Genre'], ['show', 'TV Show', 'wide'], ['season', 'Season'], ['episode', 'Episode']];
    const type = common('type');
    const modal = $('#modal');
    modal.innerHTML = `<div class="modal">
      <h2>${one ? esc(one.title) : `Edit ${items.length} videos`}</h2>
      <div class="sub">${one ? esc(one.path) : 'Only fields you change are applied to all selected videos.'}</div>
      <form class="form" id="vinfo-form">
        <label class="wide">Type<select name="type" data-orig="${esc(type ?? '')}">
          ${type === null ? '<option value="" selected>Mixed</option>' : ''}
          <option value="movie" ${type === 'movie' ? 'selected' : ''}>Movie</option><option value="episode" ${type === 'episode' ? 'selected' : ''}>TV Episode</option></select></label>
        ${fields.map(([f, label, cls]) => { const v = common(f); return `<label class="${cls || ''}">${label}<input name="${f}" value="${esc(v ?? '')}" placeholder="${v === null ? 'Mixed' : ''}" data-orig="${esc(v ?? '')}"></label>`; }).join('')}
      </form>
      <div class="modal-actions"><div></div><div><button class="btn ghost" data-m="cancel">Cancel</button><button class="btn" data-m="save">Save</button></div></div>
    </div>`;
    modal.hidden = false;
    const close = () => { modal.hidden = true; modal.innerHTML = ''; };
    const save = async () => {
      const edits = {};
      for (const inp of modal.querySelectorAll('#vinfo-form input, #vinfo-form select')) if (inp.value !== inp.dataset.orig) edits[inp.name] = inp.value;
      if (Object.keys(edits).length) await chew.video.edit(items.map((i) => i.id), edits);
      close();
    };
    modal.onclick = (e) => { if (e.target === modal) close(); const m = e.target.closest('[data-m]')?.dataset.m; if (m === 'cancel') close(); if (m === 'save') save(); };
    modal.onkeydown = (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') { e.preventDefault(); save(); } };
  }

  // ---------------------------------------------------------------- events

  document.addEventListener('click', (e) => {
    if (S.mode !== 'video' || !e.target.closest('#content')) return;
    const playEl = e.target.closest('[data-vplay]');
    const isButton = e.target.closest('button');
    if (playEl) {
      const it = V.byId.get(playEl.dataset.vplay);
      if (!it) return;
      // Cards open the movie page; buttons, episodes and "continue" cards play right away.
      if (!isButton && playEl.classList.contains('vcard') && it.type === 'movie') return app.go('movie', it.id);
      return playItem(it);
    }
    const show = e.target.closest('[data-show]');
    if (show) return app.go('show', show.dataset.show);
    const folder = e.target.closest('[data-vfolder]');
    if (folder) return app.go('vfolders', folder.dataset.vfolder || null);
    const act = e.target.closest('[data-vact]')?.dataset.vact;
    if (act) {
      const it = V.byId.get(S.param);
      if (act === 'play' && it) playItem(it);
      if (act === 'restart' && it) playItem(it, { resume: false });
      if ((act === 'watched' || act === 'unwatched') && it) chew.video.setWatched([it.id], act === 'watched');
      if (act === 'lookup' && it) { chew.video.fetch([it.id]); toast('Looking up info online…'); }
      if (act === 'lookup-show') { const s = V.showByKey.get(S.param); if (s) { chew.video.fetch(s.episodes.map((x) => x.id)); toast('Looking up info online…'); } }
    }
  });

  document.addEventListener('contextmenu', (e) => {
    if (S.mode !== 'video') return;
    const card = e.target.closest('[data-vplay], [data-vid]');
    if (card) { e.preventDefault(); itemMenu([card.dataset.vplay || card.dataset.vid]); return; }
    const show = e.target.closest('[data-show]');
    if (show) {
      e.preventDefault();
      const s = V.showByKey.get(show.dataset.show);
      if (s) itemMenu(s.episodes.map((x) => x.id));
    }
  });

  chew.onVideoChanged(async () => {
    await load();
    if (S.mode === 'video' && $('#modal').hidden) app.render(true);
  });

  return {
    views,
    load,
    player,
    play,
    playItem,
    playlistView,
    items: () => V.items,
    folders: () => V.folders,
    get: (id) => V.byId.get(id),
  };
}
