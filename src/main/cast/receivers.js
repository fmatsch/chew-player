// Google Cast and DLNA clients with a common interface:
//   load({ url, contentType, title, subtitle, image, start, kind, hls })
//   status() → { position, duration, state: 'playing' | 'paused' | 'buffering' | 'idle' | 'ended' }
//   play() · pause() · seek(seconds) · stop() · close()

import { createRequire } from 'node:module';
import { soapCall, tag } from './discovery.js';

const require = createRequire(import.meta.url);
const { Client, DefaultMediaReceiver } = require('castv2-client');

const cb = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

// ---------------------------------------------------------------- Google Cast

export class GoogleCastDevice {
  constructor(device) {
    this.device = device;
  }

  async open() {
    this.client = new Client();
    this.client.on('error', () => { this.closed = true; });
    await new Promise((resolve, reject) => {
      this.client.on('error', reject);
      this.client.connect({ host: this.device.host, port: this.device.port || 8009 }, resolve);
    });
    this.player = await cb((done) => this.client.launch(DefaultMediaReceiver, done));
    this.player.on('status', (s) => { if (s) this.last = s; });
  }

  async load({ url, contentType, title, subtitle, image, start = 0, kind, hls }) {
    const media = {
      contentId: url,
      contentType,
      streamType: 'BUFFERED',
      metadata: {
        type: 0,
        metadataType: kind === 'audio' ? 3 : 1,
        title,
        ...(kind === 'audio' ? { artist: subtitle } : { subtitle }),
        images: image ? [{ url: image }] : [],
      },
      // The default receiver needs to know the HLS segments are fragmented MP4.
      ...(hls ? { hlsSegmentFormat: 'fmp4', hlsVideoSegmentFormat: 'fmp4' } : {}),
    };
    this.last = await cb((done) => this.player.load(media, { autoplay: true, currentTime: start }, done));
  }

  async status() {
    const s = await cb((done) => this.player.getStatus(done)).catch(() => this.last);
    if (!s) return { state: 'ended', position: 0, duration: 0 };
    this.last = s;
    const map = { PLAYING: 'playing', PAUSED: 'paused', BUFFERING: 'buffering', IDLE: 'idle' };
    let state = map[s.playerState] || 'idle';
    if (s.playerState === 'IDLE' && s.idleReason === 'FINISHED') state = 'ended';
    if (s.playerState === 'IDLE' && s.idleReason === 'ERROR') state = 'error';
    return { state, position: s.currentTime || 0, duration: s.media?.duration || 0 };
  }

  play() { return cb((done) => this.player.play(done)); }
  pause() { return cb((done) => this.player.pause(done)); }
  seek(t) { return cb((done) => this.player.seek(t, done)); }
  async stop() { try { await cb((done) => this.player.stop(done)); } catch { /* already stopped */ } }
  close() { try { this.client?.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- DLNA / UPnP

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const xmlEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hms = (t) => {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const secs = (v) => {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(v || '');
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
};

export class DlnaDevice {
  constructor(device) {
    this.device = device;
  }

  async open() { /* stateless */ }

  call(action, args = {}) { return soapCall(this.device.controlURL, AVT, action, { InstanceID: 0, ...args }); }

  async load({ url, contentType, title, subtitle, image, kind, start = 0 }) {
    const cls = kind === 'audio' ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem.movie';
    const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">`
      + `<item id="0" parentID="-1" restricted="1"><dc:title>${xmlEscape(title)}</dc:title>`
      + (subtitle ? `<upnp:artist>${xmlEscape(subtitle)}</upnp:artist>` : '')
      + (image ? `<upnp:albumArtURI>${xmlEscape(image)}</upnp:albumArtURI>` : '')
      + `<upnp:class>${cls}</upnp:class><res protocolInfo="http-get:*:${contentType}:*">${xmlEscape(url)}</res></item></DIDL-Lite>`;
    await this.call('Stop').catch(() => {});
    await this.call('SetAVTransportURI', { CurrentURI: xmlEscape(url), CurrentURIMetaData: xmlEscape(didl) });
    await this.call('Play', { Speed: 1 });
    if (start > 1) setTimeout(() => this.seek(start).catch(() => {}), 1500);
    this.started = Date.now();
  }

  async status() {
    const [pos, info] = await Promise.all([this.call('GetPositionInfo'), this.call('GetTransportInfo')]);
    const st = tag(info, 'CurrentTransportState');
    let state = { PLAYING: 'playing', PAUSED_PLAYBACK: 'paused', TRANSITIONING: 'buffering', STOPPED: 'idle', NO_MEDIA_PRESENT: 'idle' }[st] || 'idle';
    // A renderer that stops on its own after playing for a while has reached the end.
    if (state === 'idle' && this.wasPlaying && Date.now() - this.started > 5000) state = 'ended';
    if (state === 'playing') this.wasPlaying = true;
    return { state, position: secs(tag(pos, 'RelTime')), duration: secs(tag(pos, 'TrackDuration')) };
  }

  play() { return this.call('Play', { Speed: 1 }); }
  pause() { return this.call('Pause'); }
  seek(t) { return this.call('Seek', { Unit: 'REL_TIME', Target: hms(t) }); }
  async stop() { this.wasPlaying = false; await this.call('Stop').catch(() => {}); }
  close() {}
}
