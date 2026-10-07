// In-app video player: native playback when Chromium can decode the file, otherwise an FFmpeg
// stream (re-wrapped or transcoded to H.264/AAC in fragmented MP4) that restarts at the seek
// position. Subtitles come in as WebVTT, shifted to the same start offset.

import { $, coverUrl, toast } from './util.js';
import { icon, hydrateIcons, setIcon } from './icons.js';
import { fmtTime } from './table.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export class VideoPlayer {
  constructor({ chew, getItem, onClose, onOpen, onCast }) {
    this.chew = chew;
    this.getItem = getItem;
    this.onClose = onClose;
    this.onOpen = onOpen;
    this.onCast = onCast;
    this.stage = $('#vstage');
    this.video = $('#vplayer');
    this.item = null;
    this.queue = [];
    this.index = 0;
    this.offset = 0;       // start of an FFmpeg stream within the file
    this.mode = 'native';  // native | remux | transcode
    this.audioIndex = 0;
    this.subIndex = -1;
    this.remote = null;    // cast session status while casting
    this.bind();
  }

  get time() {
    if (this.remote) return this.remote.position || 0;
    return this.mode === 'native' ? this.video.currentTime || 0 : this.offset + (this.video.currentTime || 0);
  }

  get duration() {
    if (this.remote?.duration) return this.remote.duration;
    return this.item?.duration || (Number.isFinite(this.video.duration) ? this.video.duration : 0);
  }

  get playing() { return this.remote ? this.remote.state === 'playing' : !this.video.paused; }

  // ---------------------------------------------------------------- open / close

  open(item, { queue = [item], index = 0, resume = true } = {}) {
    this.queue = queue;
    this.index = index;
    this.onOpen?.();
    this.stage.hidden = false;
    document.body.classList.add('video-open');
    this.start(item, resume && item.position > 30 && !item.watched ? item.position : 0);
  }

  start(item, at = 0) {
    this.saveProgress();
    this.item = item;
    this.audioIndex = Math.max(0, item.audio?.findIndex((a) => a.default) ?? 0);
    const forced = item.subs?.findIndex((s) => s.forced);
    this.subIndex = forced >= 0 ? forced : -1;
    $('#v-title').textContent = item.type === 'episode' ? item.show : item.title;
    $('#v-sub').textContent = item.type === 'episode' ? `Season ${item.season} · Episode ${item.episode} · ${item.title}` : [item.year, item.genre].filter(Boolean).join(' · ');
    $('#v-next').hidden = this.index >= this.queue.length - 1;
    this.updateMediaSession();
    if (this.remote) { this.onCast?.('load', { item, at }); this.renderControls(); return; }
    this.load(item.playback === 'native' ? 'native' : item.playback, at, true);
  }

  load(mode, at, autoplay) {
    const it = this.item;
    this.mode = mode;
    this.video.querySelectorAll('track').forEach((t) => t.remove());
    if (mode === 'native') {
      this.offset = 0;
      this.video.src = `chew://video/${it.id}`;
      if (at) this.video.currentTime = at;
    } else {
      this.offset = at;
      this.video.src = `chew://vstream/${it.id}?t=${at.toFixed(2)}&a=${this.audioIndex}&mode=${mode}`;
    }
    this.applySubtitle();
    if (autoplay) this.video.play().catch(() => {});
    this.renderControls();
  }

  // The Mac's Now Playing menu, media keys and AirPlay receivers show the video, not the last song.
  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.item) return;
    const it = this.item;
    const art = it.poster || it.still;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it.title || '',
      artist: it.type === 'episode' ? `${it.show} · S${it.season}E${String(it.episode).padStart(2, '0')}` : [it.year, it.genre].filter(Boolean).join(' · '),
      artwork: art ? [{ src: coverUrl(art), sizes: '600x900' }] : [],
    });
  }

  // Hide the big view but keep playing on the TV (casting); attach() brings it back.
  detach() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.stage.hidden = true;
    document.body.classList.remove('video-open');
  }

  attach() {
    if (!this.item) return;
    this.stage.hidden = false;
    document.body.classList.add('video-open');
    this.renderControls();
  }

  close() {
    if (!this.item) return;
    this.saveProgress();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    if (this.remote) this.onCast?.('stop');
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.item = null;
    this.stage.hidden = true;
    document.body.classList.remove('video-open');
    this.onClose?.();
  }

  saveProgress() {
    if (this.item && this.time > 5) this.chew.video.progress(this.item.id, this.time, this.duration);
  }

  // ---------------------------------------------------------------- transport

  toggle() {
    if (this.remote) { this.onCast?.(this.playing ? 'pause' : 'play'); return; }
    if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause();
  }

  seek(t) {
    t = Math.max(0, Math.min(t, (this.duration || t + 1) - 0.5));
    if (this.remote) { this.onCast?.('seek', t); return; }
    if (this.mode === 'native') this.video.currentTime = t;
    else this.load(this.mode, t, !this.video.paused);
    this.renderTime();
  }

  next() {
    if (this.index >= this.queue.length - 1) return;
    this.index++;
    const item = this.getItem(this.queue[this.index].id) || this.queue[this.index];
    this.start(item, item.position > 30 && !item.watched ? item.position : 0);
  }

  setAudio(i) {
    this.audioIndex = i;
    const tracks = this.video.audioTracks;
    if (this.mode === 'native' && tracks && tracks.length === this.item.audio.length) {
      for (let k = 0; k < tracks.length; k++) tracks[k].enabled = k === i;
    } else {
      this.load(this.mode === 'native' ? 'remux' : this.mode, this.time, !this.video.paused);
    }
  }

  setSubtitle(i) {
    this.subIndex = i;
    this.applySubtitle();
    if (this.remote) this.onCast?.('load', { item: this.item, at: this.time });
  }

  applySubtitle() {
    this.video.querySelectorAll('track').forEach((t) => t.remove());
    if (this.subIndex < 0 || !this.item) return;
    const tr = document.createElement('track');
    tr.kind = 'subtitles';
    tr.default = true;
    tr.src = `chew://subs/${this.item.id}/${this.subIndex}?t=${this.offset.toFixed(2)}`;
    this.video.append(tr);
    tr.addEventListener('load', () => { tr.track.mode = 'showing'; this.liftCues(this.stage.classList.contains('show-ui')); });
    tr.track.mode = 'showing';
  }

  // ---------------------------------------------------------------- UI

  renderTime() {
    const d = this.duration;
    const t = this.time;
    $('#v-cur').textContent = fmtTime(t);
    $('#v-dur').textContent = fmtTime(d);
    const seek = $('#v-seek');
    if (!this.seeking) {
      seek.value = d ? Math.round((t / d) * 1000) : 0;
      seek.style.setProperty('--pct', `${seek.value / 10}%`);
    }
  }

  renderControls() {
    setIcon($('#v-play'), this.playing ? 'pause' : 'play');
    setIcon($('#v-bigplay'), this.playing ? 'pause' : 'play');
    this.stage.classList.toggle('paused', !this.playing);
    $('#v-subs').classList.toggle('on', this.subIndex >= 0);
    $('#v-subs').hidden = !this.item?.subs?.length;
    $('#v-audio').hidden = (this.item?.audio?.length || 0) < 2;
    const casting = !!this.remote;
    this.stage.classList.toggle('casting', casting);
    $('#v-cast').classList.toggle('on', casting);
    if (casting) {
      const art = this.item?.still || this.item?.poster;
      $('#v-castscreen').style.backgroundImage = art ? `url('${coverUrl(art)}')` : '';
      $('#v-castlabel').textContent = this.remote.state === 'connecting' ? `Connecting to ${this.remote.deviceName}…` : `Playing on ${this.remote.deviceName}`;
    }
    this.renderTime();
  }

  showControls() {
    this.stage.classList.add('show-ui');
    this.liftCues(true);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => { if (this.playing) { this.stage.classList.remove('show-ui'); this.liftCues(false); } }, 2600);
  }

  // Move subtitles above the control bar while it is visible.
  liftCues(up) {
    for (const track of this.video.textTracks) {
      for (const cue of track.cues || []) cue.line = up ? -5 : 'auto';
    }
  }

  async menu(kind) {
    const it = this.item;
    let items = [];
    if (kind === 'subs') items = [{ id: '-1', label: 'Off', checked: this.subIndex < 0 }, { type: 'separator' }, ...it.subs.map((s, i) => ({ id: String(i), label: s.label, checked: i === this.subIndex }))];
    if (kind === 'audio') items = it.audio.map((a, i) => ({ id: String(i), label: a.label, checked: i === this.audioIndex }));
    if (kind === 'speed') items = SPEEDS.map((s) => ({ id: String(s), label: s === 1 ? 'Normal' : `${s}×`, checked: this.video.playbackRate === s }));
    const choice = await this.chew.contextMenu(items);
    if (choice == null) return;
    if (kind === 'subs') this.setSubtitle(Number(choice));
    if (kind === 'audio') this.setAudio(Number(choice));
    if (kind === 'speed') this.video.playbackRate = Number(choice);
    this.renderControls();
  }

  setVolume(v) {
    this.video.volume = Math.max(0, Math.min(1, v));
    this.video.muted = false;
    const vol = $('#v-volume');
    vol.value = Math.round(this.video.volume * 100);
    vol.style.setProperty('--pct', `${vol.value}%`);
    setIcon($('#v-mute'), this.video.volume === 0 ? 'mute' : 'volume');
    clearTimeout(this.volTimer);
    this.volTimer = setTimeout(() => this.chew.setSetting('videoVolume', this.video.volume), 400);
  }

  // Native decoding failed: fall back to re-wrapping, then to a full transcode.
  onError() {
    if (!this.item || !this.video.getAttribute('src')) return;
    const at = this.time;
    if (this.mode === 'native' && ['h264', 'hevc', 'vp9', 'av1', 'vp8'].includes(this.item.vcodec)) return this.load('remux', at, true);
    if (this.mode !== 'transcode') return this.load('transcode', at, true);
    toast(`Can't play “${this.item.title}”`);
  }

  bind() {
    const v = this.video;
    v.addEventListener('timeupdate', () => this.renderTime());
    v.addEventListener('play', () => { this.renderControls(); this.showControls(); });
    v.addEventListener('pause', () => { this.renderControls(); this.stage.classList.add('show-ui'); this.saveProgress(); });
    v.addEventListener('error', () => this.onError());
    v.addEventListener('ended', () => {
      if (!this.item) return;
      this.chew.video.progress(this.item.id, this.duration, this.duration);
      if (this.index < this.queue.length - 1) { toast('Playing next'); this.next(); } else this.close();
    });
    setInterval(() => { if (this.item && this.playing) this.saveProgress(); }, 15000);

    const seek = $('#v-seek');
    seek.addEventListener('input', () => {
      this.seeking = true;
      seek.style.setProperty('--pct', `${seek.value / 10}%`);
      $('#v-cur').textContent = fmtTime((seek.value / 1000) * this.duration);
    });
    seek.addEventListener('change', () => { this.seeking = false; this.seek((seek.value / 1000) * this.duration); });
    $('#v-volume').addEventListener('input', (e) => this.setVolume(e.target.value / 100));

    this.stage.addEventListener('mousemove', () => this.showControls());
    this.stage.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) {
        if (e.target === v || e.target.closest('#v-castscreen')) this.toggle();
        return;
      }
      switch (b.id) {
        case 'v-back': this.close(); break;
        case 'v-play': case 'v-bigplay': this.toggle(); break;
        case 'v-rew': this.seek(this.time - 10); break;
        case 'v-fwd': this.seek(this.time + 10); break;
        case 'v-next': this.next(); break;
        case 'v-mute': this.setVolume(v.volume > 0 ? 0 : 0.8); break;
        case 'v-subs': this.menu('subs'); break;
        case 'v-audio': this.menu('audio'); break;
        case 'v-speed': this.menu('speed'); break;
        case 'v-cast': this.onCast?.('menu'); break;
        case 'v-pip': if (document.pictureInPictureElement) document.exitPictureInPicture(); else v.requestPictureInPicture().catch(() => toast('Picture in Picture is not available')); break;
        case 'v-full': this.toggleFullscreen(); break;
        default: break;
      }
    });
    v.addEventListener('dblclick', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => setIcon($('#v-full'), document.fullscreenElement ? 'shrink' : 'expand'));
    document.addEventListener('keydown', (e) => {
      if (this.stage.hidden || e.target.closest('input, textarea, select') || !$('#modal').hidden) return;
      const k = e.key;
      if (k === ' ' || k === 'k') { e.preventDefault(); this.toggle(); } else if (k === 'ArrowLeft') this.seek(this.time - (e.shiftKey ? 30 : 10));
      else if (k === 'ArrowRight') this.seek(this.time + (e.shiftKey ? 30 : 10));
      else if (k === 'ArrowUp') { e.preventDefault(); this.setVolume(v.volume + 0.05); } else if (k === 'ArrowDown') { e.preventDefault(); this.setVolume(v.volume - 0.05); } else if (k === 'f') this.toggleFullscreen();
      else if (k === 'm') this.setVolume(v.volume > 0 ? 0 : 0.8);
      else if (k === 'n' && e.shiftKey) this.next();
      else if (k === 'c' && this.item?.subs?.length) this.setSubtitle(this.subIndex + 1 >= this.item.subs.length ? -1 : this.subIndex + 1);
      else if (k === 'Escape') { if (document.fullscreenElement) document.exitFullscreen(); else this.close(); } else return;
      e.stopImmediatePropagation();
      this.showControls();
    }, true);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.stage.requestFullscreen().catch(() => {});
  }

  // Remote (casting) status updates from the cast manager.
  setRemote(status) {
    const wasRemote = !!this.remote;
    this.remote = status;
    if (status) { if (!this.video.paused) this.video.pause(); }
    // While the TV plays, the AirPlay helper owns the Mac's Now Playing info — a second writer
    // (this app) would make macOS send extra updates to the Apple TV.
    if ('mediaSession' in navigator) {
      if (status && !wasRemote) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
      else if (!status && wasRemote) this.updateMediaSession();
    }
    this.renderControls();
  }
}

export const stageHtml = () => `
  <video id="vplayer" crossorigin="anonymous" playsinline></video>
  <div class="v-castscreen" id="v-castscreen"><div class="v-castlabel">${icon('cast')}<span id="v-castlabel"></span></div></div>
  <div class="v-top drag">
    <button class="v-btn" id="v-back" title="Back to library (Esc)">${icon('back')}</button>
    <div class="v-titles"><div id="v-title"></div><div id="v-sub"></div></div>
  </div>
  <button class="v-bigplay" id="v-bigplay">${icon('play')}</button>
  <div class="v-bottom">
    <div class="v-seek"><span id="v-cur">0:00</span><input type="range" id="v-seek" min="0" max="1000" value="0"><span id="v-dur">0:00</span></div>
    <div class="v-bar">
      <button class="v-btn" id="v-play" title="Play/Pause (Space)">${icon('play')}</button>
      <button class="v-btn" id="v-rew" title="Back 10 s (←)">${icon('rew')}</button>
      <button class="v-btn" id="v-fwd" title="Forward 10 s (→)">${icon('fwd')}</button>
      <button class="v-btn" id="v-next" title="Next (Shift+N)">${icon('next')}</button>
      <button class="v-btn" id="v-mute" title="Mute (M)">${icon('volume')}</button>
      <input type="range" id="v-volume" min="0" max="100" value="80">
      <div class="v-spacer"></div>
      <button class="v-btn" id="v-subs" title="Subtitles (C)">${icon('subs')}</button>
      <button class="v-btn" id="v-audio" title="Audio track">${icon('speaker')}</button>
      <button class="v-btn" id="v-speed" title="Playback speed">${icon('speed')}</button>
      <button class="v-btn" id="v-cast" title="Play on TV (AirPlay, Google Cast, DLNA)">${icon('cast')}</button>
      <button class="v-btn" id="v-pip" title="Picture in Picture">${icon('pip')}</button>
      <button class="v-btn" id="v-full" title="Full screen (F)">${icon('expand')}</button>
    </div>
  </div>`;

