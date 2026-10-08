// Dialog for "Convert…" and "Copy to Device…" — shared by music and video.

import { $, esc, toast } from './util.js';
import { icon, hydrateIcons } from './icons.js';

const chew = window.chew;

const gb = (b) => (b == null ? '?' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`);
let formatsCache = null;

// kind: 'audio' | 'video'; mode: 'convert' | 'device'; items: the selected tracks/videos.
export async function openExport({ kind, items, mode, settings }) {
  if (!items.length) return;
  formatsCache ||= await chew.exporter.formats();
  const formats = formatsCache[kind];
  const ids = items.map((i) => i.id);
  const noun = kind === 'audio' ? (items.length === 1 ? 'song' : 'songs') : (items.length === 1 ? 'video' : 'videos');
  const allNative = kind === 'audio' ? items.every((i) => /^mp3$/i.test(i.format)) : items.every((i) => /^(mp4|m4v)$/i.test(i.format));
  const state = {
    devices: [],
    dest: null,
    customDir: settings.exportDir || null,
    format: mode === 'convert' ? (kind === 'audio' ? 'mp3-192' : 'mp4-1080') : (allNative ? 'keep' : (kind === 'audio' ? 'mp3-192' : 'mp4-1080')),
    layout: 'folders',
  };
  const modal = $('#modal');

  const destinations = () => [
    ...state.devices.map((d) => ({ value: d.path, label: `${d.name} — ${gb(d.free)} free`, device: d })),
    ...(state.customDir ? [{ value: state.customDir, label: state.customDir.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || state.customDir }] : []),
  ];

  async function refreshDevices() {
    state.devices = await chew.exporter.devices();
    const opts = destinations();
    if (!opts.some((o) => o.value === state.dest)) state.dest = mode === 'device' ? (state.devices[0]?.path || state.customDir) : (state.customDir || state.devices[0]?.path || null);
    draw();
  }

  async function updateEstimate() {
    const el = $('#ex-size');
    if (!el) return;
    const bytes = await chew.exporter.estimate(kind, ids, state.format);
    const device = state.devices.find((d) => d.path === state.dest);
    let text = `About ${gb(bytes)}`;
    let warn = false;
    if (device?.free != null) {
      text += ` · ${gb(device.free)} free on ${esc(device.name)}`;
      if (bytes > device.free) { text += ' — not enough space'; warn = true; }
    }
    if (device?.fat32 && items.some((i) => (i.size || 0) > 4 * 1024 ** 3) && state.format === 'keep') {
      text += ' · files over 4 GB don’t fit on this card (FAT32)';
      warn = true;
    }
    el.innerHTML = text;
    el.classList.toggle('warn', warn);
  }

  function draw() {
    const opts = destinations();
    modal.innerHTML = `<div class="modal">
      <h2>${mode === 'convert' ? `Convert ${items.length} ${noun}` : `Copy ${items.length} ${noun} to a device`}</h2>
      <div class="sub">${mode === 'convert' ? 'Save copies in another format. Your originals stay untouched.' : 'Copy to an MP3 player, SD card or USB stick — as they are or converted.'}</div>
      <form class="form" onsubmit="return false">
        <label class="wide">${mode === 'device' ? 'Device' : 'Save to'}
          <div class="row-inline">
            <select id="ex-dest">${opts.length ? opts.map((o) => `<option value="${esc(o.value)}" ${o.value === state.dest ? 'selected' : ''}>${esc(o.label)}</option>`).join('') : '<option value="">No device found</option>'}</select>
            <button class="btn ghost" type="button" data-x="folder">Folder…</button>
            ${mode === 'device' ? `<button class="btn ghost" type="button" data-x="refresh" title="Look for devices again">${icon('repeat')}</button>` : ''}
          </div>
        </label>
        ${mode === 'device' && !state.devices.length ? '<div class="wide hint">No MP3 player or SD card found. Connect one and click ↻, or pick any folder.</div>' : ''}
        <label class="wide">Format
          <select id="ex-format">${Object.entries(formats).map(([k, f]) => `<option value="${k}" ${k === state.format ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select>
        </label>
        <label class="wide">Folders
          <select id="ex-layout">
            <option value="folders" ${state.layout === 'folders' ? 'selected' : ''}>${kind === 'audio' ? 'Artist / Album / Song' : 'Show / Season / Episode'}</option>
            <option value="flat" ${state.layout === 'flat' ? 'selected' : ''}>All in one folder</option>
          </select>
        </label>
      </form>
      <div class="hint ex-size" id="ex-size"></div>
      <div class="modal-actions"><div></div><div>
        <button class="btn ghost" data-x="cancel">Cancel</button>
        <button class="btn" data-x="go" ${state.dest ? '' : 'disabled'}>${mode === 'convert' ? 'Convert' : state.format === 'keep' ? 'Copy' : 'Convert & Copy'}</button>
      </div></div>
    </div>`;
    hydrateIcons(modal);
    updateEstimate();
  }

  const close = () => { modal.hidden = true; modal.innerHTML = ''; modal.onclick = modal.onchange = modal.onkeydown = null; };
  modal.hidden = false;
  draw();
  refreshDevices();

  modal.onchange = (e) => {
    if (e.target.id === 'ex-dest') state.dest = e.target.value;
    if (e.target.id === 'ex-format') state.format = e.target.value;
    if (e.target.id === 'ex-layout') state.layout = e.target.value;
    draw();
  };
  modal.onkeydown = (e) => { if (e.key === 'Escape') close(); };
  modal.onclick = async (e) => {
    if (e.target === modal) return close();
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'cancel') close();
    if (x === 'refresh') refreshDevices();
    if (x === 'folder') {
      const dir = await chew.exporter.chooseFolder();
      if (dir) { state.customDir = dir; state.dest = dir; chew.setSetting('exportDir', dir); draw(); }
    }
    if (x === 'go' && state.dest) {
      close();
      try {
        await chew.exporter.start({ kind, ids, dest: state.dest, format: state.format, layout: state.layout });
      } catch (err) {
        toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      }
    }
  };
}

// When a job finishes: report, then offer to eject the device or show the folder.
export async function exportFinished(d) {
  const noun = d.kind === 'audio' ? 'song' : 'video';
  const plural = (n) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (d.cancelled) { toast(`Stopped — ${plural(d.ok)} done`); return; }
  const where = d.device ? d.device.name : d.dest.split(/[\\/]/).filter(Boolean).pop();
  const failed = d.failed.length ? `\n\n${d.failed.length} failed:\n${d.failed.slice(0, 5).map((f) => `• ${f.name}: ${f.error}`).join('\n')}${d.failed.length > 5 ? '\n…' : ''}` : '';
  if (d.device) {
    const yes = await chew.confirm(`${plural(d.ok)} copied to ${where}.`, `Eject ${where} now so it can be removed safely?${failed}`, 'Eject');
    if (yes) {
      try { await chew.exporter.eject(d.device.path); toast(`${where} can now be removed`); } catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    }
  } else {
    const show = await chew.confirm(`${plural(d.ok)} saved to “${where}”.`, `Show the folder?${failed}`, 'Show Folder');
    if (show) chew.exporter.reveal(d.dest);
  }
}
