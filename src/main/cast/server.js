// Local-network media server for casting. TVs can't read chew:// URLs, so they fetch files over
// plain HTTP from this machine. Every URL carries a random per-run token; only files the library
// registered for the current cast session are served.
//
//   /<token>/f/<key>            the original file, with byte ranges (direct play)
//   /<token>/hls/<sid>/<file>   an HLS stream FFmpeg is writing for files the TV can't play directly
//   /<token>/ts/<sid>           a live MPEG-TS stream (DLNA renderers)

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ffmpegPath } from '../ffmpeg.js';

const TYPES = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg',
  aif: 'audio/aiff', aiff: 'audio/aiff', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  m3u8: 'application/vnd.apple.mpegurl', m4s: 'video/iso.segment', vtt: 'text/vtt',
};
export const mimeOf = (file) => TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Range, Accept-Encoding',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

// DLNA renderers look for these headers before they agree to play.
const DLNA = { 'transferMode.dlna.org': 'Streaming', 'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000' };

export class CastServer {
  constructor(tmpRoot) {
    this.token = crypto.randomBytes(12).toString('hex');
    this.files = new Map();     // key → absolute path
    this.sessions = new Map();  // sid → { dir, proc } | { args }
    this.tmpRoot = path.join(tmpRoot, 'chew-cast');
  }

  async start() {
    if (this.server) return;
    await fsp.rm(this.tmpRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(this.tmpRoot, { recursive: true });
    this.server = http.createServer((req, res) => this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
    await new Promise((resolve) => this.server.listen(0, '0.0.0.0', resolve));
    this.port = this.server.address().port;
  }

  // Pick the address of the network interface that shares a subnet with the TV.
  baseUrl(forHost) {
    const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    const toInt = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
    let pick = ifaces[0];
    if (forHost && /^\d+\.\d+\.\d+\.\d+$/.test(forHost)) {
      const h = toInt(forHost);
      pick = ifaces.find((i) => ((toInt(i.address) & toInt(i.netmask)) >>> 0) === ((h & toInt(i.netmask)) >>> 0)) || pick;
    }
    return `http://${pick?.address || '127.0.0.1'}:${this.port}/${this.token}`;
  }

  fileUrl(file, forHost) {
    const key = crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
    this.files.set(key, file);
    return `${this.baseUrl(forHost)}/f/${key}${path.extname(file).toLowerCase()}`;
  }

  // Start FFmpeg writing an HLS stream; resolves once the first segments exist.
  async startHls(args, forHost) {
    const sid = crypto.randomBytes(6).toString('hex');
    const dir = path.join(this.tmpRoot, sid);
    await fsp.mkdir(dir, { recursive: true });
    const full = [...args, '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments+temp_file', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(dir, 'seg%05d.m4s'), path.join(dir, 'index.m3u8')];
    const proc = spawn(ffmpegPath(), full, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const session = { dir, proc, done: false };
    proc.on('close', () => { session.done = true; });
    this.sessions.set(sid, session);
    const playlist = path.join(dir, 'index.m3u8');
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const text = await fsp.readFile(playlist, 'utf8').catch(() => '');
      if ((text.match(/#EXTINF/g) || []).length >= 2 || (session.done && text.includes('#EXTINF'))) {
        return { sid, url: `${this.baseUrl(forHost)}/hls/${sid}/index.m3u8` };
      }
      if (session.done) break;
    }
    this.stopSession(sid);
    throw new Error(`Couldn't prepare the stream${err ? `: ${err.trim().split('\n').pop()}` : ''}`);
  }

  // DLNA: FFmpeg runs per request and streams MPEG-TS straight to the TV.
  liveTs(args, forHost) {
    const sid = crypto.randomBytes(6).toString('hex');
    this.sessions.set(sid, { args });
    return { sid, url: `${this.baseUrl(forHost)}/ts/${sid}.ts` };
  }

  stopSession(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    try { s.proc?.kill('SIGKILL'); } catch { /* gone */ }
    for (const p of s.live || []) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    if (s.dir) fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }

  stopAll() { for (const sid of [...this.sessions.keys()]) this.stopSession(sid); }

  async handle(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const parts = decodeURIComponent(new URL(req.url, 'http://x').pathname).split('/').filter(Boolean);
    if (parts[0] !== this.token) { res.writeHead(404); res.end(); return; }
    const [, kind, a, b] = parts;

    if (kind === 'f') {
      const file = this.files.get(a.replace(/\.[^.]+$/, ''));
      if (!file) { res.writeHead(404); res.end(); return; }
      return this.sendFile(req, res, file);
    }
    if (kind === 'hls') {
      const s = this.sessions.get(a);
      if (!s?.dir || !/^[\w.]+$/.test(b)) { res.writeHead(404, CORS); res.end(); return; }
      const file = path.join(s.dir, b);
      // Segments may still be in the making; wait briefly instead of failing the TV's request.
      for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 200));
      if (!fs.existsSync(file)) { res.writeHead(404, CORS); res.end(); return; }
      res.setHeader('Cache-Control', 'no-cache');
      return this.sendFile(req, res, file);
    }
    if (kind === 'ts') {
      const s = this.sessions.get(a.replace(/\.ts$/, ''));
      if (!s?.args) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'video/mp2t', ...DLNA, ...CORS });
      if (req.method === 'HEAD') { res.end(); return; }
      const proc = spawn(ffmpegPath(), [...s.args, '-f', 'mpegts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      (s.live ||= []).push(proc);
      proc.stdout.pipe(res);
      res.on('close', () => proc.kill('SIGKILL'));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  async sendFile(req, res, file) {
    const { size } = await fsp.stat(file);
    const headers = { 'Content-Type': mimeOf(file), 'Accept-Ranges': 'bytes', ...CORS, ...DLNA };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let start = 0;
    let end = size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, size - Number(m[2]));
      else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1 });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': size });
    }
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
  }

  close() {
    this.stopAll();
    this.server?.close();
    this.server = null;
  }
}
