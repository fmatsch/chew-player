// Casting: one active session at a time, to an AirPlay, Google Cast or DLNA device.
// Decides per device whether a file can be sent as is or needs an FFmpeg stream, keeps the
// position in sync and reports status to the renderer.

import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Discovery } from './discovery.js';
import { CastServer, mimeOf } from './server.js';
import { AirPlayDevice } from './airplay.js';
import { decodeBplist } from './plist.js';
import { GoogleCastDevice, DlnaDevice } from './receivers.js';
import { videoArgs } from '../ffmpeg.js';

const ext = (p) => path.extname(p).slice(1).toLowerCase();

// What each protocol plays without help.
const DIRECT = {
  airplay: {
    video: (it) => ['mp4', 'm4v', 'mov'].includes(ext(it.path)) && ['h264', 'hevc'].includes(it.vcodec) && (!it.acodec || ['aac', 'ac3', 'eac3', 'mp3', 'alac'].includes(it.acodec)),
    audio: (t) => ['mp3', 'm4a', 'aac', 'wav', 'aif', 'aiff'].includes(ext(t.path)),
  },
  cast: {
    video: (it) => ['mp4', 'm4v', 'webm'].includes(ext(it.path)) && ['h264', 'vp8', 'vp9'].includes(it.vcodec) && (!it.acodec || ['aac', 'mp3', 'opus', 'vorbis'].includes(it.acodec)),
    audio: (t) => ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'webm'].includes(ext(t.path)) && !String(t.codec || '').toLowerCase().includes('alac'),
  },
  dlna: {
    video: (it) => ['mp4', 'm4v'].includes(ext(it.path)) && it.vcodec === 'h264' && (!it.acodec || it.acodec === 'aac'),
    audio: (t) => ['mp3', 'flac', 'wav', 'm4a'].includes(ext(t.path)) && !String(t.codec || '').toLowerCase().includes('alac'),
  },
};

export class CastManager extends EventEmitter {
  constructor({ dataDir, getVideo, getTrack, coverUrl }) {
    super();
    this.getVideo = getVideo;
    this.getTrack = getTrack;
    this.coverUrl = coverUrl;
    this.credsFile = path.join(dataDir, 'cast-pairings.json');
    this.manualFile = path.join(dataDir, 'cast-devices.json');
    this.discovery = new Discovery();
    this.server = new CastServer(os.tmpdir());
    this.session = null;
    this.discovery.on('changed', () => this.emit('devices', this.devices()));
  }

  start() {
    this.discovery.start();
    for (const d of this.manualDevices()) this.discovery.add(d);
  }

  manualDevices() { try { return JSON.parse(readFileSync(this.manualFile, 'utf8')); } catch { return []; } }

  // Fallback when discovery can't see a device (VLANs, mesh Wi-Fi, blocked multicast): connect by IP address.
  async addManual({ protocol, host }) {
    host = String(host).trim();
    if (!/^[\w.-]+$/.test(host)) throw new Error('Please enter an IP address like 192.168.1.20');
    let name = protocol === 'airplay' ? `Apple TV (${host})` : protocol === 'cast' ? `Google Cast (${host})` : host;
    if (protocol === 'airplay') {
      try {
        const res = await fetch(`http://${host}:7000/info`, { signal: AbortSignal.timeout(4000) });
        const info = decodeBplist(Buffer.from(await res.arrayBuffer()));
        if (info?.name) name = info.name;
      } catch { /* /info is optional */ }
    }
    const dev = { id: `${protocol}:manual:${host}`, protocol, name, host, port: protocol === 'airplay' ? 7000 : 8009, manual: true, video: true };
    const list = this.manualDevices().filter((d) => d.id !== dev.id);
    list.push(dev);
    writeFileSync(this.manualFile, JSON.stringify(list));
    this.discovery.add(dev);
    return { id: dev.id, name };
  }

  devices() {
    return this.discovery.list().map(({ id, protocol, name, model, video }) => ({ id, protocol, name, model, video: video !== false }));
  }

  refresh() { this.discovery.refresh(); }

  creds() { try { return JSON.parse(readFileSync(this.credsFile, 'utf8')); } catch { return {}; } }
  saveCreds(id, c) { const all = this.creds(); all[id] = c; writeFileSync(this.credsFile, JSON.stringify(all)); }

  status(extra = {}) {
    const s = this.session;
    const st = s ? {
      active: true, deviceId: s.device.id, deviceName: s.device.name, protocol: s.device.protocol, kind: s.kind, id: s.id,
      state: s.state, position: s.offset + (s.remotePos || 0), duration: s.duration || 0, ...extra,
    } : { active: false, ...extra };
    this.emit('status', st);
    return st;
  }

  // ---------------------------------------------------------------- play

  async play({ deviceId, kind, id, start = 0, audio = 0, subtitle = -1 }) {
    const device = this.discovery.devices.get(deviceId);
    if (!device) throw new Error('That device is no longer available');
    await this.server.start();

    // Reuse the connection when switching items on the same device.
    let client = this.session?.device.id === deviceId ? this.session.client : null;
    if (this.session && !client) await this.stop();
    this.stopStreams();
    clearInterval(this.poll);

    const item = kind === 'video' ? this.getVideo(id) : this.getTrack(id);
    if (!item) throw new Error('Nothing to play');
    this.session = { device, client, kind, id, offset: 0, state: 'connecting', duration: item.duration || 0, opts: { audio, subtitle } };
    this.status();

    try {
      if (!client) {
        client = this.connect(device);
        this.session.client = client;
        await client.open();
      }
      const media = await this.prepare(device, kind, item, start, audio, subtitle);
      this.session.offset = media.offset;
      await client.load(media);
      this.session.state = 'buffering';
      this.status();
      this.startPolling();
    } catch (e) {
      if (e.needsPin) {
        this.session = null;
        return this.status({ state: 'pin-required', deviceId, deviceName: device.name, pending: { deviceId, kind, id, start, audio, subtitle } });
      }
      this.session?.client?.close();
      this.session = null;
      this.status({ state: 'error', message: e.message, deviceName: device.name });
      return null;
    }
    return this.status();
  }

  connect(device) {
    if (device.protocol === 'airplay') return new AirPlayClient(device, this.creds()[device.id]);
    if (device.protocol === 'cast') return new GoogleCastDevice(device);
    return new DlnaDevice(device);
  }

  async prepare(device, kind, item, start, audio, subtitle) {
    const host = device.host;
    const meta = kind === 'video'
      ? { title: item.title, subtitle: item.type === 'episode' ? `${item.show} · S${item.season}E${item.episode}` : item.year ? String(item.year) : '', image: this.imageUrl(item.poster || item.still, host) }
      : { title: item.title, subtitle: [item.artist, item.album].filter(Boolean).join(' — '), image: this.imageUrl(item.cover, host) };
    const proto = device.protocol;

    if (kind === 'audio') {
      if (DIRECT[proto].audio(item)) return { ...meta, kind, url: this.server.fileUrl(item.path, host), contentType: mimeOf(item.path), start, offset: 0 };
      // Convert to AAC on the fly as a short HLS stream (works on all receivers that do HLS; DLNA gets MPEG-TS).
      const args = ['-v', 'error', '-nostdin', ...(start > 0 ? ['-ss', String(start)] : []), '-i', item.path, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '256k'];
      if (proto === 'dlna') { const ts = this.server.liveTs(args, host); this.session.sid = ts.sid; return { ...meta, kind, url: ts.url, contentType: 'video/mp2t', offset: start }; }
      const hls = await this.server.startHls(args, host);
      this.session.sid = hls.sid;
      return { ...meta, kind, url: hls.url, contentType: 'application/x-mpegURL', hls: true, offset: start };
    }

    // Video: subtitles are burned into the picture, since TVs can't load our subtitle tracks.
    const sub = item.subs?.[subtitle];
    const burn = sub ? (sub.kind === 'external' ? { file: sub.path } : { file: item.path, index: sub.index }) : null;
    if (!burn && (audio === 0 || (item.audio?.length || 0) < 2) && DIRECT[proto].video(item)) {
      return { ...meta, kind, url: this.server.fileUrl(item.path, host), contentType: mimeOf(item.path) === 'video/quicktime' ? 'video/mp4' : mimeOf(item.path), start, offset: 0 };
    }
    const copyable = proto === 'airplay' ? ['h264', 'hevc'] : ['h264'];
    const mode = !burn && copyable.includes(item.vcodec) ? 'remux' : 'transcode';
    const args = videoArgs(item, { start, audio, mode, burn });
    if (proto === 'dlna') {
      const ts = this.server.liveTs(args, host);
      this.session.sid = ts.sid;
      return { ...meta, kind, url: ts.url, contentType: 'video/mp2t', offset: start };
    }
    const hls = await this.server.startHls(args, host);
    this.session.sid = hls.sid;
    return { ...meta, kind, url: hls.url, contentType: 'application/x-mpegURL', hls: true, offset: start };
  }

  imageUrl(file, host) { return file ? this.server.fileUrl(file, host) : null; }

  stopStreams() {
    if (this.session?.sid) this.server.stopSession(this.session.sid);
  }

  startPolling() {
    clearInterval(this.poll);
    this.poll = setInterval(async () => {
      const s = this.session;
      if (!s || this.polling) return;
      this.polling = true;
      try {
        const st = await s.client.status();
        if (this.session !== s) return;
        s.remotePos = st.position;
        if (!s.direct && st.duration && !s.duration) s.duration = st.duration;
        if (st.state === 'playing') s.played = true;
        // Some receivers report "idle" once a file ends; treat that as the end once it has played.
        const ended = st.state === 'ended' || (st.state === 'idle' && s.played);
        s.state = ended ? 'ended' : st.state;
        s.failures = 0;
        this.status();
        if (ended) { clearInterval(this.poll); this.stopStreams(); }
      } catch (e) {
        if (++s.failures > 5) { this.status({ state: 'error', message: `Lost connection to ${s.device.name}` }); this.disconnect(); }
      } finally {
        this.polling = false;
      }
    }, 1000);
  }

  // ---------------------------------------------------------------- control

  async control(action, value) {
    const s = this.session;
    if (!s) return;
    try {
      if (action === 'play') { await s.client.play(); s.state = 'playing'; }
      if (action === 'pause') { await s.client.pause(); s.state = 'paused'; }
      if (action === 'seek') {
        // Direct files seek on the device; FFmpeg streams restart at the new position.
        if (s.sid) return this.play({ deviceId: s.device.id, kind: s.kind, id: s.id, start: value, ...s.opts });
        await s.client.seek(value);
        s.remotePos = value;
      }
      if (action === 'stop') return this.stop();
      this.status();
    } catch (e) {
      this.status({ state: 'error', message: e.message });
    }
  }

  async stop() {
    const s = this.session;
    clearInterval(this.poll);
    this.stopStreams();
    this.session = null;
    if (s) {
      await s.client?.stop?.().catch(() => {});
      s.client?.close?.();
    }
    this.status();
  }

  disconnect() {
    clearInterval(this.poll);
    this.stopStreams();
    this.session?.client?.close?.();
    this.session = null;
  }

  // ---------------------------------------------------------------- AirPlay pairing

  async pairStart(deviceId) {
    const device = this.discovery.devices.get(deviceId);
    this.pairing = new AirPlayDevice(device);
    await this.pairing.startPinPairing();
  }

  async pairFinish(deviceId, pin) {
    const creds = await this.pairing.finishPinPairing(pin);
    this.saveCreds(deviceId, creds);
    this.pairing = null;
  }

  close() {
    this.disconnect();
    this.server.close();
    this.discovery.stop();
  }
}

// AirPlay behind the same interface as the other receivers.
class AirPlayClient {
  constructor(device, creds) {
    this.dev = new AirPlayDevice({ host: device.host, port: device.port }, creds || null);
  }

  open() { return this.dev.open(); }
  load({ url, start = 0, duration }) { this.loaded = Date.now(); return this.dev.play(url, start, duration); }

  async status() {
    const s = await this.dev.status();
    let state = s.rate > 0 ? 'playing' : s.ready ? 'paused' : 'buffering';
    if (s.ready) this.seenReady = true;
    // After playback finishes the Apple TV returns an empty status.
    if (!s.ready && !s.duration && this.seenReady && Date.now() - this.loaded > 4000) state = 'ended';
    return { state, position: s.position, duration: s.duration };
  }

  play() { return this.dev.rate(1); }
  pause() { return this.dev.rate(0); }
  seek(t) { return this.dev.seek(t); }
  stop() { return this.dev.stop(); }
  close() { this.dev.close(); }
}
