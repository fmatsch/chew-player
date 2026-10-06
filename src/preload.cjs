const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('chew', {
  state: () => ipcRenderer.invoke('state'),
  info: () => ipcRenderer.invoke('info'),
  addFolder: () => ipcRenderer.invoke('folders:add'),
  removeFolder: (dir) => ipcRenderer.invoke('folders:remove', dir),
  scan: () => ipcRenderer.invoke('scan'),
  fetchMissing: (ids) => ipcRenderer.invoke('fetch', ids),
  cancelFetch: () => ipcRenderer.invoke('fetch:cancel'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  editTracks: (ids, edits) => ipcRenderer.invoke('tracks:edit', ids, edits),
  reveal: (id) => ipcRenderer.invoke('tracks:reveal', id),
  markPlayed: (id) => ipcRenderer.invoke('tracks:played', id),
  rate: (ids, rating) => ipcRenderer.invoke('tracks:rate', ids, rating),
  openFolder: (dir) => ipcRenderer.invoke('folder:reveal', dir),
  openPaths: (paths) => ipcRenderer.invoke('open-paths', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  confirm: (message, detail, okLabel) => ipcRenderer.invoke('confirm', message, detail, okLabel),
  contextMenu: (items) => ipcRenderer.invoke('context-menu', items),
  session: {
    get: () => ipcRenderer.invoke('session:get'),
    set: (patch) => ipcRenderer.send('session:set', patch),
  },
  updates: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    status: () => ipcRenderer.invoke('update:status'),
  },
  playlists: {
    create: (name, ids, extra) => ipcRenderer.invoke('playlist:create', name, ids, extra),
    update: (id, patch) => ipcRenderer.invoke('playlist:update', id, patch),
    remove: (id) => ipcRenderer.invoke('playlist:delete', id),
    import: () => ipcRenderer.invoke('playlist:import'),
    export: (id, ids) => ipcRenderer.invoke('playlist:export', id, ids),
  },
  onLibraryChanged: on('library-changed'),
  onScanProgress: on('scan-progress'),
  onFetchProgress: on('fetch-progress'),
  onCommand: on('command'),
  onPlayTracks: on('play-tracks'),
  onUpdateStatus: on('update-status'),
  onVideoChanged: on('video-changed'),
  cast: {
    devices: () => ipcRenderer.invoke('cast:devices'),
    play: (opts) => ipcRenderer.invoke('cast:play', opts),
    control: (action, value) => ipcRenderer.invoke('cast:control', action, value),
    pairStart: (id) => ipcRenderer.invoke('cast:pair-start', id),
    pairFinish: (id, pin) => ipcRenderer.invoke('cast:pair-finish', id, pin),
  },
  onCastDevices: on('cast-devices'),
  onCastStatus: on('cast-status'),
  video: {
    state: () => ipcRenderer.invoke('video:state'),
    addFolder: () => ipcRenderer.invoke('video:folders:add'),
    removeFolder: (dir) => ipcRenderer.invoke('video:folders:remove', dir),
    scan: () => ipcRenderer.invoke('video:scan'),
    fetch: (ids) => ipcRenderer.invoke('video:fetch', ids),
    progress: (id, pos, dur) => ipcRenderer.invoke('video:progress', id, pos, dur),
    setWatched: (ids, watched) => ipcRenderer.invoke('video:watched', ids, watched),
    edit: (ids, edits) => ipcRenderer.invoke('video:edit', ids, edits),
    reveal: (id) => ipcRenderer.invoke('video:reveal', id),
  },
});
