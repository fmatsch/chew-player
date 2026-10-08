// Converting and copying: selected songs/videos go to a folder or a connected device (MP3 player,
// SD card, USB stick) — as they are, or converted to MP3 / MP4 in a chosen quality.

import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream';
import { ffmpegPath } from './ffmpeg.js';
import { log } from './log.js';

export const AUDIO_FORMATS = {
  keep: { label: 'Keep original format' },
  'mp3-320': { label: 'MP3 · 320 kbps (best)', kbps: 320 },
  'mp3-256': { label: 'MP3 · 256 kbps', kbps: 256 },
  'mp3-192': { label: 'MP3 · 192 kbps (good)', kbps: 192 },
  'mp3-128': { label: 'MP3 · 128 kbps (small)', kbps: 128 },
};

export const VIDEO_FORMATS = {
  keep: { label: 'Keep original format' },
  'mp4-original': { label: 'MP4 · original quality', height: 0, crf: 18, abr: 256, mbps: 0 },
  'mp4-1080': { label: 'MP4 · 1080p', height: 1080, crf: 21, abr: 192, mbps: 5 },
  'mp4-720': { label: 'MP4 · 720p', height: 720, crf: 22, abr: 160, mbps: 2.5 },
  'mp4-480': { label: 'MP4 · 480p (small)', height: 480, crf: 23, abr: 128, mbps: 1.2 },
};

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? '' : out)));

// Names that work on FAT32/exFAT cards and every OS.
const safe = (s, fallback = 'Unknown') => {
  const v = String(s ?? '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  return (v || fallback).slice(0, 120);
};
const pad = (n) => String(n || 0).padStart(2, '0');

async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return { free: null, total: null };
  }
}

const plistValue = (xml, key) => {
  const m = new RegExp(`<key>${key}</key>\\s*<(string|integer|true|false)\\s*/?>([^<]*)`).exec(xml);
  if (!m) return null;
  if (m[1] === 'true') return true;
  if (m[1] === 'false') return false;
  return m[1] === 'integer' ? Number(m[2]) : m[2];
};

// Removable and external drives: SD cards, MP3 players, USB sticks. Network shares are left out.
export async function listDevices() {
  const devices = [];
  if (process.platform === 'darwin') {
    let names = [];
    try { names = await fsp.readdir('/Volumes'); } catch { /* none */ }
    for (const name of names) {
      const mount = path.join('/Volumes', name);
      const xml = await run('/usr/sbin/diskutil', ['info', '-plist', mount]);
      if (!xml) continue; // network shares and disk images without a device are not drives
      const internal = plistValue(xml, 'Internal');
      const removable = plistValue(xml, 'RemovableMedia') || plistValue(xml, 'Ejectable') || plistValue(xml, 'Removable');
      if (plistValue(xml, 'MountPoint') === '/' || (internal && !removable)) continue;
      if (/^(Recovery|Preboot|VM|Update)$/i.test(name)) continue;
      const fsType = plistValue(xml, 'FilesystemType') || '';
      devices.push({ path: mount, name: plistValue(xml, 'VolumeName') || name, fs: fsType, fat32: /msdos|fat/i.test(fsType) && !/exfat/i.test(fsType), ...(await freeSpace(mount)) });
    }
  } else if (process.platform === 'win32') {
    const ps = "Get-CimInstance Win32_LogicalDisk | Where-Object { ($_.DriveType -eq 2) -or ($_.DriveType -eq 3 -and $_.DeviceID -ne $env:SystemDrive) } | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace,DriveType | ConvertTo-Json";
    const out = await run('powershell.exe', ['-NoProfile', '-Command', ps]);
    let list = [];
    try { list = [].concat(JSON.parse(out || '[]')); } catch { /* ignore */ }
    for (const d of list) {
      devices.push({ path: `${d.DeviceID}\\`, name: d.VolumeName || (d.DriveType === 2 ? 'Removable drive' : 'Drive'), fs: d.FileSystem || '', fat32: /^FAT/i.test(d.FileSystem || '') && !/exFAT/i.test(d.FileSystem || ''), free: d.FreeSpace, total: d.Size, label: d.DeviceID });
    }
  } else {
    const user = os.userInfo().username;
    for (const base of [`/media/${user}`, `/run/media/${user}`, '/media']) {
      let names = [];
      try { names = await fsp.readdir(base); } catch { continue; }
      for (const n of names) {
        const mount = path.join(base, n);
        if (devices.some((d) => d.path === mount)) continue;
        devices.push({ path: mount, name: n, fs: '', fat32: false, ...(await freeSpace(mount)) });
      }
    }
  }
  return devices;
}

export function eject(mount) {
  return new Promise((resolve, reject) => {
    const done = (err) => (err ? reject(new Error('The device could not be ejected — is a file still open?')) : resolve());
    if (process.platform === 'darwin') execFile('/usr/sbin/diskutil', ['eject', mount], { timeout: 30000 }, done);
    else if (process.platform === 'win32') {
      const drive = mount.replace(/\\$/, '');
      execFile('powershell.exe', ['-NoProfile', '-Command', `(New-Object -comObject Shell.Application).Namespace(17).ParseName('${drive}').InvokeVerb('Eject')`], { timeout: 30000 }, done);
    } else execFile('udisksctl', ['unmount', '-b', mount], { timeout: 30000 }, done);
  });
}

// macOS keeps extended attributes on FAT/exFAT cards in hidden "._name" companion files, which
// MP3 players and car stereos show as broken tracks. Strip the attributes from what we wrote …
function clearAppleDouble(file) {
  if (process.platform !== 'darwin') return Promise.resolve();
  return new Promise((resolve) => execFile('/usr/bin/xattr', ['-c', file], () => resolve()));
}

// … and remove any "._" files left in the destination.
async function cleanDotUnderscore(dir) {
  if (process.platform !== 'darwin') return;
  const walk = async (d) => {
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.name.startsWith('._')) await fsp.rm(p, { force: true }).catch(() => {});
      else if (e.isDirectory() && !e.name.startsWith('.')) await walk(p);
    }
  };
  await walk(dir);
}

export class Exporter extends EventEmitter {
  constructor({ getTrack, getVideo }) {
    super();
    this.getTrack = getTrack;
    this.getVideo = getVideo;
    this.jobs = new Map();
  }

  // Where a file goes inside the destination.
  target(kind, item, layout, ext) {
    if (kind === 'audio') {
      const title = safe(item.title, path.basename(item.path, path.extname(item.path)));
      const artist = safe(item.albumArtist || item.artist, 'Unknown Artist');
      if (layout === 'flat') return `${safe(item.artist, 'Unknown Artist')} - ${title}${ext}`;
      const disc = item.discNo > 1 ? `${item.discNo}-` : '';
      return path.join(artist, safe(item.album, 'Unknown Album'), `${disc}${item.trackNo ? `${pad(item.trackNo)} ` : ''}${title}${ext}`);
    }
    if (item.type === 'episode') {
      const name = `${safe(item.show)} S${pad(item.season)}E${pad(item.episode)} ${safe(item.title, '')}`.trim();
      return layout === 'flat' ? `${name}${ext}` : path.join(safe(item.show), `Season ${item.season || 1}`, `${name}${ext}`);
    }
    return `${safe(item.title)}${item.year ? ` (${item.year})` : ''}${ext}`;
  }

  outExt(kind, item, format) {
    if (format === 'keep') return path.extname(item.path).toLowerCase();
    return kind === 'audio' ? '.mp3' : '.mp4';
  }

  estimate(kind, item, format) {
    if (format === 'keep') return item.size || 0;
    const d = item.duration || 0;
    if (kind === 'audio') return (d * AUDIO_FORMATS[format].kbps * 1000) / 8;
    const f = VIDEO_FORMATS[format];
    if (!f.mbps) return item.size || 0;
    return (d * (f.mbps * 1e6 + f.abr * 1000)) / 8;
  }

  async start({ kind, ids, dest, format = 'keep', layout = 'folders' }) {
    const items = ids.map((id) => (kind === 'audio' ? this.getTrack(id) : this.getVideo(id))).filter(Boolean);
    if (!items.length) throw new Error('Nothing selected');
    await fsp.mkdir(dest, { recursive: true });
    const devices = await listDevices().catch(() => []);
    const device = devices.find((d) => dest === d.path || dest.startsWith(d.path.endsWith(path.sep) ? d.path : d.path + path.sep));
    const job = { id: randomUUID(), kind, items, dest, format, layout, device, cancelled: false, done: 0, failed: [], proc: null };
    this.jobs.set(job.id, job);
    log('export', `${kind} ×${items.length} → ${dest} as ${format}`);
    this.run(job);
    return { jobId: job.id, count: items.length };
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.cancelled = true;
    try { job.proc?.kill('SIGKILL'); } catch { /* gone */ }
    try { job.stream?.destroy(); } catch { /* gone */ }
  }

  progress(job, fraction = 0, current = null) {
    this.emit('progress', {
      jobId: job.id, kind: job.kind, total: job.items.length, done: job.done,
      percent: Math.min(100, Math.round(((job.done + fraction) / job.items.length) * 100)),
      current, converting: job.format !== 'keep', deviceName: job.device?.name || null,
    });
  }

  async run(job) {
    const used = new Set();
    for (const item of job.items) {
      if (job.cancelled) break;
      const ext = this.outExt(job.kind, item, job.format);
      let rel = this.target(job.kind, item, job.layout, ext);
      // Two different files must not end up with the same name.
      for (let n = 2; used.has(rel.toLowerCase()); n++) rel = rel.replace(/( \(\d+\))?(\.[^.]+)$/, ` (${n})$2`);
      used.add(rel.toLowerCase());
      const out = path.join(job.dest, rel);
      const part = `${out}.partial`;
      this.progress(job, 0, path.basename(out));
      try {
        await fsp.mkdir(path.dirname(out), { recursive: true });
        if (job.device?.fat32 && this.estimate(job.kind, item, job.format) > 4 * 1024 ** 3) {
          throw new Error('larger than 4 GB, which this card (FAT32) can’t store — format it as exFAT');
        }
        if (job.format === 'keep') await this.copy(job, item, part);
        else await this.convert(job, item, part);
        if (job.cancelled) throw new Error('cancelled');
        await clearAppleDouble(part);
        await fsp.rename(part, out);
        job.done++;
      } catch (e) {
        await fsp.rm(part, { force: true }).catch(() => {});
        if (job.cancelled) break;
        const msg = e.code === 'ENOSPC' ? 'not enough space on the destination' : e.code === 'EFBIG' ? 'too large for this card’s file system (FAT32, max 4 GB)' : e.message;
        job.failed.push({ name: path.basename(item.path), error: msg });
        log('export', `failed: ${path.basename(item.path)} — ${msg}`);
        job.done++;
        if (e.code === 'ENOSPC') break;
      }
      this.progress(job, 0, null);
    }
    this.jobs.delete(job.id);
    if (job.device) await cleanDotUnderscore(job.dest);
    const ok = job.done - job.failed.length;
    log('export', `finished: ${ok} ok, ${job.failed.length} failed${job.cancelled ? ', cancelled' : ''}`);
    this.emit('done', { jobId: job.id, kind: job.kind, ok, failed: job.failed, cancelled: job.cancelled, dest: job.dest, device: job.device || null });
  }

  copy(job, item, to) {
    return new Promise((resolve, reject) => {
      const size = item.size || 1;
      let copied = 0;
      const src = fs.createReadStream(item.path, { highWaterMark: 1 << 20 });
      job.stream = src;
      src.on('data', (chunk) => { copied += chunk.length; this.progress(job, copied / size, path.basename(to, '.partial')); });
      pipeline(src, fs.createWriteStream(to), (err) => (err ? reject(err) : resolve()));
    });
  }

  convert(job, item, to) {
    const args = ['-v', 'error', '-nostdin', '-y', '-i', item.path];
    if (job.kind === 'audio') {
      const { kbps } = AUDIO_FORMATS[job.format];
      // The cover the library shows (embedded, folder.jpg or fetched online) goes into the MP3.
      const cover = item.cover && fs.existsSync(item.cover) ? item.cover : null;
      if (cover) args.push('-i', cover);
      args.push('-map', '0:a:0');
      if (cover) args.push('-map', '1:v:0', '-c:v', 'mjpeg', '-vf', "scale='min(600,iw)':-2", '-disposition:v:0', 'attached_pic');
      args.push('-c:a', 'libmp3lame', '-b:a', `${kbps}k`);
      args.push('-map_metadata', '0', '-id3v2_version', '3');
      // Write the library's (possibly corrected) tags, not just what the file had.
      const tags = { title: item.title, artist: item.artist, album: item.album, album_artist: item.albumArtist, date: item.year, genre: item.genre, track: item.trackNo, disc: item.discNo };
      for (const [k, v] of Object.entries(tags)) if (v != null && v !== '') args.push('-metadata', `${k}=${v}`);
      args.push('-f', 'mp3');
    } else {
      const f = VIDEO_FORMATS[job.format];
      args.push('-map', '0:v:0', '-map', '0:a:0?');
      const copyVideo = job.format === 'mp4-original' && ['h264', 'hevc'].includes(item.vcodec);
      if (copyVideo) {
        args.push('-c:v', 'copy');
        if (item.vcodec === 'hevc') args.push('-tag:v', 'hvc1');
      } else {
        const vf = [f.height ? `scale=-2:'min(${f.height},ih)'` : null, 'format=yuv420p'].filter(Boolean).join(',');
        args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(f.crf), '-profile:v', 'high');
      }
      if (copyVideo && item.acodec === 'aac') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', `${f.abr}k`, '-ac', '2');
      args.push('-map_metadata', '0', '-metadata', `title=${item.title || ''}`, '-movflags', '+faststart', '-sn', '-f', 'mp4');
    }
    args.push('-progress', 'pipe:1', '-nostats', to);
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
      job.proc = proc;
      let err = '';
      proc.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
      proc.stdout.on('data', (d) => {
        const m = /out_time_us=(\d+)/.exec(String(d));
        if (m && item.duration) this.progress(job, Math.min(0.99, Number(m[1]) / 1e6 / item.duration), path.basename(to, '.partial'));
      });
      proc.on('close', (code) => {
        job.proc = null;
        if (code === 0) resolve();
        else reject(new Error(job.cancelled ? 'cancelled' : (err.trim().split('\n').pop() || `FFmpeg exited with ${code}`)));
      });
      proc.on('error', reject);
    });
  }
}
