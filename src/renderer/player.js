// Playback engine: queue, shuffle/repeat and the <audio> element.
// Tracks Chromium can't decode are streamed through FFmpeg (chew://transcode),
// where seeking means restarting the stream at an offset.

export class Player extends EventTarget {
  constructor({ getTrack, ffmpeg }) {
    super();
    this.getTrack = getTrack;
    this.ffmpeg = ffmpeg;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];      // track ids
    this.order = [];      // indices into queue, in play order
    this.pos = -1;        // position in order
    this.shuffle = false;
    this.repeat = 'off';  // off | all | one
    this.offset = 0;      // start offset of a transcoded stream
    this.transcoding = false;
    this.track = null;

    const a = this.audio;
    a.addEventListener('timeupdate', () => this.emit('time'));
    a.addEventListener('play', () => this.emit('state'));
    a.addEventListener('pause', () => this.emit('state'));
    a.addEventListener('loadedmetadata', () => this.emit('time'));
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('error', () => this.onError());
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get playing() { return !this.audio.paused && !!this.track; }
  get currentTime() { return (this.transcoding ? this.offset : 0) + (this.audio.currentTime || 0); }
  get duration() {
    const d = this.track?.duration;
    if (d) return d;
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }
  get currentId() { return this.pos >= 0 ? this.queue[this.order[this.pos]] : null; }

  upcoming() { return this.order.slice(this.pos + 1).map((i) => this.queue[i]); }

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

  playNext(ids) {
    if (this.pos < 0) return this.playList(ids, 0);
    const base = this.queue.length;
    this.queue.push(...ids);
    this.order.splice(this.pos + 1, 0, ...ids.map((_, i) => base + i));
    this.emit('queue');
  }

  enqueue(ids) {
    if (this.pos < 0) return this.playList(ids, 0);
    const base = this.queue.length;
    this.queue.push(...ids);
    this.order.push(...ids.map((_, i) => base + i));
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
    this.emit('queue');
  }

  load(autoplay, offset = 0, forceTranscode = false) {
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
    if (autoplay) this.audio.play().catch(() => {});
    this.emit('track', track);
    this.emit('time');
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
    if (this.pos < this.order.length - 1) this.next(); else this.stop();
  }

  onEnded() {
    if (this.repeat === 'one') { this.load(true); return; }
    this.next(true);
  }

  toggle() {
    if (!this.track) {
      if (this.queue.length) { if (this.pos < 0) this.pos = 0; this.load(true); }
      return;
    }
    if (this.audio.paused) this.audio.play().catch(() => {}); else this.audio.pause();
  }

  play() { if (this.track) this.audio.play().catch(() => {}); else this.toggle(); }
  pause() { this.audio.pause(); }

  next(auto = false) {
    if (!this.order.length) return;
    if (this.pos < this.order.length - 1) { this.pos++; this.load(true); return; }
    if (this.repeat === 'all' || (!auto && this.repeat !== 'off')) {
      if (this.shuffle) { this.pos = -1; this.buildOrder(false); }
      this.pos = 0;
      this.load(true);
      return;
    }
    if (auto) { this.audio.pause(); this.pos = this.order.length - 1; this.seek(0); this.emit('state'); }
  }

  prev() {
    if (this.currentTime > 3 || this.pos <= 0) { this.seek(0); return; }
    this.pos--;
    this.load(true);
  }

  seek(seconds) {
    if (!this.track) return;
    const t = Math.max(0, Math.min(seconds, this.duration || seconds));
    if (this.transcoding) this.load(!this.audio.paused, t, true);
    else this.audio.currentTime = t;
    this.emit('time');
  }

  stop() {
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
    this.emit('queue');
  }

  setVolume(v) { this.audio.volume = Math.max(0, Math.min(1, v)); }
}
