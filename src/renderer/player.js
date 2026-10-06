// Playback engine: queue, shuffle/repeat, gapless transitions, ReplayGain and output device.
//
// Everything runs through one Web Audio graph:
//
//   <audio> element ─┐
//                    ├─► ReplayGain (gain) ─► volume (gain) ─► output device
//   AudioBuffer src ─┘
//
// A track starts on the <audio> element (instant start, cheap seeking; exotic formats are
// streamed through FFmpeg via chew://transcode). Meanwhile the *next* track is decoded into an
// AudioBuffer and scheduled on the audio clock to start exactly when the current one ends —
// that's the gapless hand-off. From then on playback continues from buffers, sample-accurately.

const MAX_PRELOAD_SECONDS = 20 * 60;   // don't decode huge files (memory) — they fall back to a normal transition
const HANDOFF_WINDOW = 0.5;             // schedule the next track this many seconds before the end

export class Player extends EventTarget {
  constructor({ getTrack, ffmpeg }) {
    super();
    this.getTrack = getTrack;
    this.ffmpeg = ffmpeg;

    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.rgNode = this.ctx.createGain();
    this.volNode = this.ctx.createGain();
    this.rgNode.connect(this.volNode).connect(this.ctx.destination);

    this.audio = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'auto';
    this.ctx.createMediaElementSource(this.audio).connect(this.rgNode);

    this.queue = [];      // track ids
    this.order = [];      // indices into queue, in play order
    this.pos = -1;        // position in order
    this.shuffle = false;
    this.repeat = 'off';  // off | all | one
    this.gapless = true;
    this.replayGain = 'auto'; // off | track | album | auto (album in order, track when shuffling)
    this.volume = 1;

    this.mode = 'element';  // element | buffer
    this.offset = 0;        // start offset of a transcoded stream
    this.transcoding = false;
    this.track = null;
    this.buf = null;        // buffer mode: { buffer, source, startCtx, offset, playing }
    this.preload = null;       // preloaded next track: { id, pos, buffer }
    this.handoff = null;    // scheduled gapless transition

    const a = this.audio;
    const el = (fn) => () => { if (this.mode === 'element') fn(); };
    a.addEventListener('timeupdate', el(() => this.emit('time')));
    a.addEventListener('loadedmetadata', el(() => this.emit('time')));
    a.addEventListener('play', el(() => this.emit('state')));
    a.addEventListener('pause', el(() => this.emit('state')));
    a.addEventListener('ended', el(() => { if (!this.handoff) this.onEnded(); }));
    a.addEventListener('error', el(() => this.onError()));

    setInterval(() => this.tick(), 100);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ---------------------------------------------------------------- state

  get playing() {
    if (!this.track) return false;
    return this.mode === 'buffer' ? !!this.buf?.playing : !this.audio.paused;
  }

  get currentTime() {
    if (this.mode === 'buffer' && this.buf) {
      if (!this.buf.playing) return this.buf.offset;
      const t = this.ctx.currentTime - this.buf.startCtx + this.buf.offset;
      return Math.max(0, Math.min(t, this.buf.buffer.duration));
    }
    return (this.transcoding ? this.offset : 0) + (this.audio.currentTime || 0);
  }

  get duration() {
    if (this.mode === 'buffer' && this.buf) return this.buf.buffer.duration;
    const d = this.track?.duration;
    if (d) return d;
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  get currentId() { return this.pos >= 0 ? this.queue[this.order[this.pos]] : null; }

  snapshot() {
    return { queue: this.queue, order: this.order, pos: this.pos, time: this.currentTime };
  }

  // ---------------------------------------------------------------- queue

  buildOrder(keepCurrent = true) {
    const current = keepCurrent && this.pos >= 0 ? this.order[this.pos] : null;
    const idx = this.queue.map((_, i) => i);
    if (this.shuffle) {
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      if (current != null) { idx.splice(idx.indexOf(current), 1); idx.unshift(current); }
    }
    this.order = idx;
    this.pos = current != null ? this.order.indexOf(current) : -1;
  }

  // Replace the queue with `ids` and start at `start` (or a random track when shuffling with no start).
  playList(ids, start = 0, { shuffle } = {}) {
    if (!ids.length) return;
    if (shuffle != null) this.shuffle = shuffle;
    this.queue = [...ids];
    this.pos = -1;
    this.buildOrder(false);
    if (this.shuffle) {
      if (start != null && start > 0) {
        this.order.splice(this.order.indexOf(start), 1);
        this.order.unshift(start);
      }
      this.pos = 0;
    } else {
      this.pos = Math.max(0, Math.min(start || 0, ids.length - 1));
    }
    this.load(true);
    this.emit('queue');
  }

  // Bring back a saved session: same queue and position, paused.
  restore({ queue, order, pos, time }) {
    if (!Array.isArray(queue) || !queue.length || !Array.isArray(order)) return false;
    const valid = order.length === queue.length && order.every((i) => i >= 0 && i < queue.length);
    this.queue = [...queue];
    if (valid) this.order = [...order]; else this.buildOrder(false);
    this.pos = Math.max(0, Math.min(pos ?? 0, this.order.length - 1));
    if (!this.getTrack(this.currentId)) return false;
    this.load(false, Math.max(0, time || 0));
    this.emit('queue');
    return true;
  }

  playNext(ids) {
    if (this.pos < 0) return this.playList(ids, 0);
    const base = this.queue.length;
    this.queue.push(...ids);
    this.order.splice(this.pos + 1, 0, ...ids.map((_, i) => base + i));
    this.invalidateNext();
    this.emit('queue');
  }

  enqueue(ids) {
    if (this.pos < 0) return this.playList(ids, 0);
    const base = this.queue.length;
    this.queue.push(...ids);
    this.order.push(...ids.map((_, i) => base + i));
    this.invalidateNext();
    this.emit('queue');
  }

  jumpTo(orderPos) {
    if (orderPos < 0 || orderPos >= this.order.length) return;
    this.pos = orderPos;
    this.load(true);
  }

  removeUpcoming(orderPositions) {
    const drop = new Set(orderPositions.filter((p) => p > this.pos));
    this.order = this.order.filter((_, p) => !drop.has(p));
    this.invalidateNext();
    this.emit('queue');
  }

  // Order position that plays after the current one, honouring repeat; null at the end.
  peekNext() {
    if (this.pos < 0) return null;
    if (this.repeat === 'one') return this.pos;
    if (this.pos < this.order.length - 1) return this.pos + 1;
    if (this.repeat === 'all' && !this.shuffle) return 0;
    return null;
  }

  // ---------------------------------------------------------------- loading

  load(autoplay, offset = 0, forceTranscode = false) {
    this.cancelHandoff();
    this.stopBuffer();
    this.mode = 'element';
    const id = this.currentId;
    const track = id && this.getTrack(id);
    if (!track) { this.stop(); return; }
    this.track = track;
    this.transcoding = forceTranscode || (track.playback === 'transcode' && this.ffmpeg);
    this.offset = this.transcoding ? offset : 0;
    this.audio.src = this.transcoding
      ? `chew://transcode/${track.id}?t=${offset.toFixed(2)}`
      : `chew://media/${track.id}`;
    if (!this.transcoding && offset) this.audio.currentTime = offset;
    this.applyGain();
    if (autoplay) { this.resumeCtx(); this.audio.play().catch(() => {}); }
    this.preload = null;
    this.schedulePrepare(1500);
    this.emit('track', track);
    this.emit('time');
    this.emit('state');
  }

  onError() {
    if (!this.track || !this.audio.src) return;
    if (!this.transcoding && this.ffmpeg) {
      // Native decoding failed — retry through FFmpeg from where we were.
      this.track.playback = 'transcode';
      this.load(true, this.audio.currentTime || 0, true);
      return;
    }
    this.emit('error', this.track);
    if (this.pos < this.order.length - 1) this.goNext(); else this.stop();
  }

  onEnded() {
    if (this.repeat === 'one') { this.load(true); return; }
    this.goNext(true);
  }

  // ---------------------------------------------------------------- transport

  resumeCtx() { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

  toggle() {
    if (!this.track) {
      if (this.queue.length) { if (this.pos < 0) this.pos = 0; this.load(true); }
      return;
    }
    if (this.playing) this.pause(); else this.play();
  }

  play() {
    if (!this.track) { this.toggle(); return; }
    this.resumeCtx();
    if (this.mode === 'buffer') {
      if (!this.buf.playing) this.startBuffer(this.buf.buffer, this.buf.offset);
      this.emit('state');
    } else {
      this.audio.play().catch(() => {});
    }
  }

  pause() {
    this.cancelHandoff();
    if (this.mode === 'buffer') {
      if (!this.buf?.playing) return;
      const t = this.currentTime;
      this.stopSource(this.buf.source);
      Object.assign(this.buf, { source: null, playing: false, offset: t });
      this.emit('state');
    } else {
      this.audio.pause();
    }
  }

  next(auto = false) { this.goNext(auto); }

  goNext(auto = false) {
    if (!this.order.length) return;
    if (this.pos < this.order.length - 1) { this.pos++; this.load(true); return; }
    if (this.repeat === 'all' || (!auto && this.repeat !== 'off')) {
      if (this.shuffle) { this.pos = -1; this.buildOrder(false); }
      this.pos = 0;
      this.load(true);
      return;
    }
    if (auto) {
      // End of the queue: stay on the last track, rewound and paused.
      this.pause();
      this.pos = this.order.length - 1;
      this.seek(0);
      this.emit('state');
    }
  }

  prev() {
    if (this.currentTime > 3 || this.pos <= 0) { this.seek(0); return; }
    this.pos--;
    this.load(true);
  }

  seek(seconds) {
    if (!this.track) return;
    this.cancelHandoff();
    const t = Math.max(0, Math.min(seconds, this.duration || seconds));
    if (this.mode === 'buffer') {
      if (this.buf.playing) { this.stopSource(this.buf.source); this.startBuffer(this.buf.buffer, t); } else this.buf.offset = t;
    } else if (this.transcoding) {
      this.load(!this.audio.paused, t, true);
    } else {
      this.audio.currentTime = t;
    }
    this.emit('time');
  }

  stop() {
    this.cancelHandoff();
    this.stopBuffer();
    this.mode = 'element';
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.track = null;
    this.emit('track', null);
    this.emit('state');
  }

  setShuffle(on) {
    this.shuffle = on;
    this.buildOrder(true);
    this.applyGain();
    this.invalidateNext();
    this.emit('queue');
  }

  setRepeat(mode) {
    this.repeat = mode;
    this.invalidateNext();
  }

  setGapless(on) {
    this.gapless = on;
    this.invalidateNext();
  }

  setReplayGain(mode) {
    this.replayGain = mode;
    this.cancelHandoff();
    this.applyGain();
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    // Perceptual curve: the slider feels linear instead of jumping at the low end.
    this.volNode.gain.setTargetAtTime(this.volume ** 2, this.ctx.currentTime, 0.015);
  }

  async setOutputDevice(deviceId) {
    if (typeof this.ctx.setSinkId !== 'function') return false;
    try {
      await this.ctx.setSinkId(!deviceId || deviceId === 'default' ? '' : deviceId);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- ReplayGain

  gainFor(t) {
    const mode = this.replayGain === 'auto' ? (this.shuffle ? 'track' : 'album') : this.replayGain;
    if (!t || mode === 'off') return 1;
    const album = mode === 'album';
    const dB = album ? (t.albumGain ?? t.trackGain) : (t.trackGain ?? t.albumGain);
    if (dB == null) return 1;
    const peak = album ? (t.albumPeak ?? t.trackPeak) : (t.trackPeak ?? t.albumPeak);
    let g = 10 ** (dB / 20);
    if (peak > 0) g = Math.min(g, 1 / peak); // never push the loudest sample into clipping
    return g;
  }

  applyGain() {
    const now = this.ctx.currentTime;
    this.rgNode.gain.cancelScheduledValues(now);
    this.rgNode.gain.setValueAtTime(this.gainFor(this.track), now);
  }

  // ---------------------------------------------------------------- buffers & gapless

  startBuffer(buffer, offset = 0, when = this.ctx.currentTime) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.rgNode);
    src.start(when, offset);
    this.buf = { buffer, source: src, startCtx: when, offset, playing: true };
    this.watchSource(src);
    return src;
  }

  watchSource(src) {
    src.onended = () => {
      if (this.handoff || this.mode !== 'buffer' || this.buf?.source !== src || !this.buf.playing) return;
      this.buf.playing = false;
      this.onEnded();
    };
  }

  stopSource(src) {
    if (!src) return;
    src.onended = null;
    try { src.stop(); } catch { /* not started */ }
    src.disconnect();
  }

  stopBuffer() {
    if (this.buf) this.stopSource(this.buf.source);
    this.buf = null;
  }

  invalidateNext() {
    this.cancelHandoff();
    this.preload = null;
    this.schedulePrepare(300);
  }

  schedulePrepare(delay) {
    clearTimeout(this.prepTimer);
    this.prepTimer = setTimeout(() => this.prepareNext(), delay);
  }

  // Decode the upcoming track in the background so it can start sample-accurately.
  async prepareNext() {
    if (!this.gapless || !this.track) { this.preload = null; return; }
    const np = this.peekNext();
    if (np == null) { this.preload = null; return; }
    const id = this.queue[this.order[np]];
    if (this.preload && this.preload.id === id && this.preload.pos === np) return;
    const t = this.getTrack(id);
    if (!t || (t.duration && t.duration > MAX_PRELOAD_SECONDS)) { this.preload = null; return; }
    const entry = { id, pos: np, buffer: null };
    this.preload = entry;
    const url = t.playback === 'transcode' && this.ffmpeg ? `chew://transcode/${id}?t=0` : `chew://media/${id}`;
    try {
      const data = await (await fetch(url)).arrayBuffer();
      if (this.preload !== entry) return;
      const buffer = await this.ctx.decodeAudioData(data);
      if (this.preload === entry) entry.buffer = buffer;
    } catch {
      if (this.preload === entry) entry.failed = true; // falls back to a normal transition
    }
  }

  tick() {
    if (this.mode === 'buffer' && this.buf?.playing) this.emit('time');
    this.maybeHandoff();
  }

  maybeHandoff() {
    if (!this.gapless || this.handoff || !this.preload?.buffer || !this.playing) return;
    let remaining;
    if (this.mode === 'element') {
      if (this.transcoding || !Number.isFinite(this.audio.duration)) return; // stream end isn't known precisely
      remaining = this.audio.duration - this.audio.currentTime;
    } else {
      remaining = this.buf.buffer.duration - this.currentTime;
    }
    if (remaining > HANDOFF_WINDOW) return;

    const at = this.ctx.currentTime + Math.max(0, remaining);
    const nx = this.preload;
    const src = this.ctx.createBufferSource();
    src.buffer = nx.buffer;
    src.connect(this.rgNode);
    src.start(at);
    this.rgNode.gain.setValueAtTime(this.gainFor(this.getTrack(nx.id)), at);
    const wait = Math.max(0, (at - this.ctx.currentTime) * 1000);
    this.handoff = { src, at, nx, timer: setTimeout(() => this.commitHandoff(), wait) };
  }

  cancelHandoff() {
    const h = this.handoff;
    if (!h) return;
    this.handoff = null;
    clearTimeout(h.timer);
    this.stopSource(h.src);
    this.applyGain();
  }

  // The scheduled track has started: make it the current one.
  commitHandoff() {
    const h = this.handoff;
    if (!h) return;
    this.handoff = null;
    if (this.mode === 'element') {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    } else {
      this.stopSource(this.buf?.source);
    }
    this.mode = 'buffer';
    this.transcoding = false;
    this.offset = 0;
    this.pos = h.nx.pos;
    this.buf = { buffer: h.nx.buffer, source: h.src, startCtx: h.at, offset: 0, playing: true };
    this.watchSource(h.src);
    this.track = this.getTrack(h.nx.id);
    this.preload = null;
    this.schedulePrepare(500);
    this.emit('track', this.track);
    this.emit('state');
    this.emit('time');
  }
}
