import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, nativeTheme, session, powerSaveBlocker } from 'electron';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Library } from './library.js';
import { extOf, isAudioFile } from './formats.js';
import { transcodeStream, ffmpegPath, videoStream, subtitleStream } from './ffmpeg.js';
import { VideoLibrary } from './video-library.js';
import { CastManager } from './cast/manager.js';
import { initLog, log } from './log.js';
import { Updater } from './updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';

protocol.registerSchemesAsPrivileged([
  { scheme: 'chew', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } },
]);

// A failing stream or network call must never freeze the whole app behind an error dialog.
process.on('uncaughtException', (err) => { console.error('[chew] uncaught:', err); log('error', err?.stack || String(err)); });
process.on('unhandledRejection', (err) => console.error('[chew] unhandled rejection:', err));

// Development helpers: isolated profile and scripted screenshots (see README → Development).
if (process.env.CHEW_USER_DATA) app.setPath('userData', path.resolve(process.env.CHEW_USER_DATA));

// Audio runs through a Web Audio graph (gapless, ReplayGain, output device), so never wait for a user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Lets the video player switch between audio languages of a file without re-encoding.
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let library = null;
let videoLib = null;
let cast = null;
let updater = null;
const pendingOpen = [];

// The last playback session (queue + position) lives in its own small file so the
// big library JSON isn't rewritten every few seconds while music plays.
let sessionState = null;
let sessionTimer = null;
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
function loadSession() {
  try { sessionState = JSON.parse(readFileSync(sessionFile(), 'utf8')); } catch { sessionState = null; }
}
function saveSessionNow() {
  clearTimeout(sessionTimer);
  if (sessionState) { try { writeFileSync(sessionFile(), JSON.stringify(sessionState)); } catch { /* ignore */ } }
}

const MIME = {
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', mp2: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', wave: 'audio/wav', webm: 'audio/webm', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4',
  aac: 'audio/aac', mov: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};

// The renderer routes audio through Web Audio, which needs CORS-clean media.
const CORS = { 'Access-Control-Allow-Origin': '*' };
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;

// Byte-range aware file response so <audio> can seek.
async function serveFile(file, request) {
  const { size } = await fs.stat(file);
  const headers = { 'Content-Type': MIME[extOf(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', ...CORS };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (m && (m[1] || m[2])) {
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); } else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  return new Response(Readable.toWeb(createReadStream(file, { start, end })), { status, headers });
}

function registerProtocol() {
  protocol.handle('chew', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host === 'media' || url.host === 'transcode') {
        const track = library.data.tracks[url.pathname.slice(1)];
        if (!track) return new Response('Not found', { status: 404 });
        if (url.host === 'media') return await serveFile(track.path, request);
        const t = Number(url.searchParams.get('t')) || 0;
        return new Response(transcodeStream(track.path, t, track.sampleRate || 0), { headers: { 'Content-Type': 'audio/flac', ...CORS } });
      }
      if (url.host === 'video' || url.host === 'vstream' || url.host === 'subs') {
        const [id, n] = url.pathname.slice(1).split('/');
        const item = videoLib.data.items[id];
        if (!item) return new Response('Not found', { status: 404 });
        const start = Number(url.searchParams.get('t')) || 0;
        if (url.host === 'video') {
          const res = await serveFile(item.path, request);
          if (extOf(item.path) === 'mp4' || extOf(item.path) === 'webm') return res;
          res.headers.set('Content-Type', extOf(item.path) === 'webm' ? 'video/webm' : 'video/mp4');
          return res;
        }
        if (url.host === 'subs') {
          return new Response(subtitleStream(item, Number(n) || 0, start), { headers: { 'Content-Type': 'text/vtt; charset=utf-8', ...CORS } });
        }
        const stream = videoStream(item, { start, audio: Number(url.searchParams.get('a')) || 0, mode: url.searchParams.get('mode') === 'transcode' ? 'transcode' : 'remux' });
        return new Response(stream, { headers: { 'Content-Type': 'video/mp4', ...CORS } });
      }
      if (url.host === 'cover') {
        const p = url.searchParams.get('p');
        if (!library.isKnownCover(p) && !(videoLib.isKnownFile(p) && IMAGE_EXT.test(p))) return new Response('Forbidden', { status: 403 });
        const res = await serveFile(p, request);
        res.headers.set('Cache-Control', 'max-age=31536000');
        return res;
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return new Response(String(e.message), { status: 500 });
    }
  });
}

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

const overlayColors = () => (nativeTheme.shouldUseDarkColors
  ? { color: '#14171f', symbolColor: '#e8eaf0', height: 44 }
  : { color: '#f4f5f8', symbolColor: '#1b1f2a', height: 44 });

function createWindow() {
  const b = library.data.settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1240,
    height: b.height || 780,
    x: b.x,
    y: b.y,
    minWidth: 860,
    minHeight: 540,
    show: false,
    title: 'Chew Player',
    icon: path.join(here, '../../assets/icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14171f' : '#f4f5f8',
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 15 } } : { titleBarOverlay: overlayColors() }),
    webPreferences: {
      preload: path.join(here, '../preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(here, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());
  const saveBounds = () => { if (!win.isMaximized() && !win.isFullScreen()) { library.data.settings.bounds = win.getBounds(); library.save(); } };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Folders go to the library of the side the user is on (music or video).
function addFolders(dirs, kind) {
  const lib = kind === 'video' ? videoLib : library;
  const report = { kind, added: [], exists: [], covered: [] };
  for (const dir of dirs) report[lib.addFolder(dir)].push(dir);
  if (report.added.length) lib.scan();
  return report;
}

async function openPaths(paths, kind = 'audio') {
  const ids = [];
  const dirs = [];
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      if (st.isDirectory()) dirs.push(p);
      else if (isAudioFile(p)) ids.push((await library.addLoose(p)).id);
    } catch { /* ignore */ }
  }
  const report = dirs.length ? addFolders(dirs, kind) : null;
  if (ids.length) send('play-tracks', ids);
  return report;
}

async function chooseFolder(kind = 'audio') {
  const r = await dialog.showOpenDialog(win, {
    title: kind === 'video' ? 'Add Video Folder' : 'Add Music Folder',
    buttonLabel: 'Add',
    properties: ['openDirectory', 'multiSelections', 'createDirectory'],
  });
  if (r.canceled) return null;
  return addFolders(r.filePaths, kind);
}

async function importPlaylist() {
  const r = await dialog.showOpenDialog(win, { title: 'Import Playlist', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8'] }] });
  if (r.canceled) return null;
  let last = null;
  for (const f of r.filePaths) last = await library.importM3U(f);
  return last;
}

function buildMenu() {
  const cmd = (command) => () => send('command', command);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Folder…', accelerator: 'CmdOrCtrl+O', click: cmd('add-folder') },
        { label: 'Add Music Folder…', click: () => chooseFolder('audio').then((r) => send('folders-added', r)) },
        { label: 'Add Video Folder…', click: () => chooseFolder('video').then((r) => send('folders-added', r)) },
        { label: 'Rescan Library', accelerator: 'CmdOrCtrl+R', click: () => library.scan() },
        { label: 'Fetch Missing Info Online', click: () => library.fetchMissing() },
        { type: 'separator' },
        { label: 'New Playlist', accelerator: 'CmdOrCtrl+N', click: cmd('new-playlist') },
        { label: 'Import Playlist…', click: async () => { const r = await importPlaylist(); if (r) send('command', `show-playlist:${r.playlist.id}`); } },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Controls',
      submenu: [
        { label: 'Play / Pause', click: cmd('toggle') },
        { label: 'Next', accelerator: 'CmdOrCtrl+Right', click: cmd('next') },
        { label: 'Previous', accelerator: 'CmdOrCtrl+Left', click: cmd('prev') },
        { type: 'separator' },
        { label: 'Volume Up', accelerator: 'CmdOrCtrl+Up', click: cmd('vol-up') },
        { label: 'Volume Down', accelerator: 'CmdOrCtrl+Down', click: cmd('vol-down') },
        { type: 'separator' },
        { label: 'Shuffle', click: cmd('shuffle') },
        { label: 'Repeat', click: cmd('repeat') },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
      ],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Chew Player Website', click: () => shell.openExternal('https://fmatsch.github.io/chew-player/') }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('state', () => library.state());
  ipcMain.handle('info', () => ({ version: app.getVersion(), platform: process.platform, ffmpeg: !!ffmpegPath() }));
  ipcMain.handle('folders:add', (_e, kind) => chooseFolder(kind || 'audio'));
  ipcMain.handle('folders:remove', (_e, dir) => library.removeFolder(dir));
  ipcMain.handle('scan', () => { library.scan(); });
  ipcMain.handle('fetch', (_e, ids) => { library.fetchMissing(ids || null).catch(() => {}); });
  ipcMain.handle('fetch:cancel', () => { library.cancelFetch = true; });
  ipcMain.handle('settings:set', (_e, key, value) => {
    library.data.settings[key] = value;
    if (key === 'theme') nativeTheme.themeSource = value;
    if (key === 'watchFolders') { library.watch(); videoLib.watch(); }
    if (key === 'autoUpdate') updater.schedule();
    if (key === 'airplayTransfer') cast.restartCurrent();
    library.save();
  });
  ipcMain.handle('session:get', () => sessionState);
  ipcMain.on('session:set', (_e, patch) => {
    sessionState = { ...(sessionState || {}), ...patch };
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSessionNow, 2000);
  });
  ipcMain.handle('update:check', () => updater.check(true));

  // ---- video library
  ipcMain.handle('video:state', () => videoLib.state());
  ipcMain.handle('video:folders:add', () => chooseFolder('video'));
  ipcMain.handle('video:folders:remove', (_e, dir) => videoLib.removeFolder(dir));
  ipcMain.handle('video:scan', () => { videoLib.scan(); });
  ipcMain.handle('video:fetch', (_e, ids) => { videoLib.fetchMissing(ids || null).catch(() => {}); });
  ipcMain.handle('video:progress', (_e, id, pos, dur) => videoLib.progress(id, pos, dur));
  ipcMain.handle('video:watched', (_e, ids, watched) => videoLib.setWatched(ids, watched));
  ipcMain.handle('video:edit', (_e, ids, edits) => videoLib.edit(ids, edits));
  // ---- casting
  ipcMain.handle('cast:devices', () => { cast.refresh(); return cast.devices(); });
  ipcMain.handle('cast:play', (_e, opts) => cast.play(opts));
  ipcMain.handle('cast:control', (_e, action, value) => cast.control(action, value));
  ipcMain.handle('cast:pair-start', (_e, id) => cast.pairStart(id));
  ipcMain.handle('cast:add-manual', (_e, opts) => cast.addManual(opts));
  ipcMain.handle('cast:quicktime', (_e, opts) => cast.openInQuickTime(opts));
  ipcMain.handle('cast:network-settings', () => shell.openExternal(isMac
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'
    : 'ms-settings:privacy')),
  ipcMain.handle('cast:pair-finish', (_e, id, pin) => cast.pairFinish(id, pin));
  ipcMain.handle('video:reveal', (_e, id) => { const it = videoLib.data.items[id]; if (it) shell.showItemInFolder(it.path); });
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('update:status', () => updater.status);
  ipcMain.handle('tracks:edit', (_e, ids, edits) => library.editTracks(ids, edits));
  ipcMain.handle('tracks:reveal', (_e, id) => { const t = library.data.tracks[id]; if (t) shell.showItemInFolder(t.path); });
  ipcMain.handle('folder:reveal', (_e, dir) => shell.openPath(dir));
  ipcMain.handle('open-paths', (_e, paths, kind) => openPaths(paths, kind));
  ipcMain.handle('playlist:create', (_e, name, ids, extra) => library.createPlaylist(name, ids, extra));
  ipcMain.handle('tracks:played', (_e, id) => library.markPlayed(id));
  ipcMain.handle('tracks:rate', (_e, ids, rating) => library.rateTracks(ids, rating));
  ipcMain.handle('playlist:update', (_e, id, patch) => library.updatePlaylist(id, patch));
  ipcMain.handle('playlist:delete', (_e, id) => library.deletePlaylist(id));
  ipcMain.handle('playlist:import', () => importPlaylist());
  ipcMain.handle('playlist:export', async (_e, id, ids) => {
    const p = library.playlist(id);
    if (!p) return false;
    const r = await dialog.showSaveDialog(win, { title: 'Export Playlist', defaultPath: `${p.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u8`, filters: [{ name: 'M3U Playlist', extensions: ['m3u8', 'm3u'] }] });
    if (r.canceled || !r.filePath) return false;
    await library.exportM3U(id, r.filePath, ids);
    return true;
  });
  ipcMain.handle('confirm', async (_e, message, detail, okLabel) => {
    const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: [okLabel || 'OK', 'Cancel'], defaultId: 0, cancelId: 1 });
    return r.response === 0;
  });

  // Native context menus: the renderer describes the items, we resolve with the clicked id (or null).
  ipcMain.handle('context-menu', (_e, items) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const build = (list) => list.map((it) => (it.type === 'separator' ? { type: 'separator' } : {
      label: it.label,
      enabled: it.enabled !== false,
      type: it.checked != null ? 'checkbox' : 'normal',
      checked: !!it.checked,
      ...(it.submenu ? { submenu: build(it.submenu) } : { click: () => finish(it.id) }),
    }));
    Menu.buildFromTemplate(build(items)).popup({ window: win, callback: () => setTimeout(() => finish(null), 100) });
  }));
}

// CHEW_CAPTURE=out.png [CHEW_STEPS='js;;js'] [CHEW_DELAY=ms]: run renderer snippets, then save a screenshot per step.
async function captureAndQuit(out) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const delay = Number(process.env.CHEW_DELAY) || 2500;
  const steps = (process.env.CHEW_STEPS || '').split(';;').filter(Boolean);
  await wait(delay);
  const shots = steps.length ? steps : [''];
  for (let i = 0; i < shots.length; i++) {
    if (shots[i]) {
      const r = await win.webContents.executeJavaScript(`(async () => { ${shots[i]} })()`).catch((e) => `ERR ${e.message}`);
      if (r !== undefined) console.log(`step ${i}:`, typeof r === 'string' ? r : JSON.stringify(r));
      await wait(1200);
    }
    const img = await win.webContents.capturePage();
    await fs.writeFile(shots.length > 1 ? out.replace(/\.png$/, `-${i}.png`) : out, img.toPNG());
  }
  await library.saveNow();
  await videoLib.saveNow();
  saveSessionNow();
  app.exit(0);
}

app.on('open-file', (e, file) => {
  e.preventDefault();
  if (library && win) openPaths([file]); else pendingOpen.push(file);
});

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  openPaths(argv.slice(1).filter((a) => !a.startsWith('-') && path.isAbsolute(a)));
});

app.whenReady().then(() => {
  initLog(app.getPath('userData'));
  log('app', `Chew Player ${app.getVersion()} on ${process.platform} ${process.arch}`);
  library = new Library(app.getPath('userData'), app.getVersion());
  nativeTheme.themeSource = library.data.settings.theme || 'system';
  library.on('changed', () => send('library-changed'));
  library.on('scan', (p) => send('scan-progress', p));
  library.on('fetch', (p) => send('fetch-progress', p));
  videoLib = new VideoLibrary(app.getPath('userData'), {
    autoFetch: () => library.data.settings.autoFetch !== false,
    watchFolders: () => library.data.settings.watchFolders !== false,
    lang: () => (app.getLocale() || 'en').split('-')[0],
  });
  videoLib.on('changed', () => send('video-changed'));
  videoLib.on('scan', (p) => send('scan-progress', { ...p, source: 'video' }));
  videoLib.on('fetch', (p) => send('fetch-progress', { ...p, source: 'video' }));
  cast = new CastManager({
    dataDir: app.getPath('userData'),
    settings: () => library.data.settings,
    getVideo: (id) => (videoLib.data.items[id] ? videoLib.view(videoLib.data.items[id]) : null),
    getTrack: (id) => (library.data.tracks[id] ? library.view(library.data.tracks[id]) : null),
  });
  cast.on('devices', (list) => send('cast-devices', list));
  // While something plays on a TV, this process may be serving the media — keep macOS from napping it.
  let castBlocker = null;
  cast.on('status', (st) => {
    send('cast-status', st);
    if (st.active && castBlocker === null) castBlocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!st.active && castBlocker !== null) { powerSaveBlocker.stop(castBlocker); castBlocker = null; }
  });
  cast.start();
  loadSession();
  updater = new Updater({ send: (status) => send('update-status', status), enabled: () => library.data.settings.autoUpdate !== false });

  // Let the renderer list and pick audio output devices (USB DACs, headphones, …).
  const allowed = new Set(['media', 'speaker-selection']);
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  nativeTheme.on('updated', () => { if (!isMac && win) win.setTitleBarOverlay(overlayColors()); });

  registerProtocol();
  registerIpc();
  buildMenu();
  createWindow();

  win.webContents.once('did-finish-load', () => {
    if (library.data.settings.folders.length) library.scan();
    library.watch();
    if (videoLib.data.folders.length) videoLib.scan();
    videoLib.watch();
    updater.schedule();
    const argvFiles = isMac ? [] : process.argv.slice(1).filter((a) => !a.startsWith('-') && path.isAbsolute(a) && a !== app.getAppPath());
    openPaths([...pendingOpen.splice(0), ...argvFiles]);
    if (process.env.CHEW_CAPTURE) captureAndQuit(process.env.CHEW_CAPTURE);
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (!isMac) app.quit(); });
app.on('before-quit', () => { cast?.close(); library?.saveNow(); videoLib?.saveNow(); saveSessionNow(); library?.unwatch(); videoLib?.unwatch(); });
