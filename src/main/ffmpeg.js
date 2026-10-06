import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cached;

// Locate an FFmpeg binary: the bundled ffmpeg-static first, then common system locations.
export function ffmpegPath() {
  if (cached !== undefined) return cached;
  const candidates = [];
  try {
    const bundled = require('ffmpeg-static');
    if (bundled) candidates.push(bundled.replace('app.asar', 'app.asar.unpacked'));
  } catch { /* not installed */ }
  candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  cached = candidates.find((p) => existsSync(p)) || null;
  return cached;
}

// Run FFmpeg and expose its stdout as a web ReadableStream (killed when the consumer goes away).
export function pipeStream(args) {
  const bin = ffmpegPath();
  if (!bin) throw new Error('FFmpeg not found');
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let done = false;
  const stop = () => { if (!done) { done = true; proc.kill('SIGKILL'); } };
  return new ReadableStream({
    start(controller) {
      proc.stdout.on('data', (chunk) => {
        if (done) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize <= 0) proc.stdout.pause();
        } catch {
          stop(); // the player went away (seek, track change) — stop decoding
        }
      });
      proc.stdout.on('end', () => { if (!done) { done = true; try { controller.close(); } catch { /* cancelled */ } } });
      proc.on('error', (err) => { if (!done) { done = true; try { controller.error(err); } catch { /* cancelled */ } } });
    },
    pull() { if (!done) proc.stdout.resume(); },
    cancel() { stop(); },
  }, { highWaterMark: 1 << 20, size: (chunk) => chunk.byteLength });
}

// Decode any audio file FFmpeg understands into a FLAC stream Chromium can play.
export function transcodeStream(file, startSeconds = 0, sampleRate = 0) {
  const args = ['-v', 'error', '-nostdin'];
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', file, '-vn', '-map', '0:a:0');
  if (sampleRate > 192000 || sampleRate === 0) args.push('-ar', sampleRate === 0 ? '48000' : '96000');
  args.push('-sample_fmt', 's16', '-c:a', 'flac', '-compression_level', '0', '-f', 'flac', 'pipe:1');
  return pipeStream(args);
}

// Video arguments shared by the in-app stream and casting.
//   mode 'remux': keep the video as is, convert audio to AAC · 'transcode': encode H.264 (max 1080p)
//   burn: optional subtitle to draw into the picture { file, index } (used when casting)
export function videoArgs(item, { start = 0, audio = 0, mode = 'remux', burn = null, maxHeight = 1080 } = {}) {
  const args = ['-v', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', item.path, '-map', '0:v:0');
  if (item.audio?.length) args.push('-map', `0:a:${Math.min(audio, item.audio.length - 1)}?`);
  const filters = [];
  if (mode === 'transcode' || burn) {
    if (burn) {
      const f = burn.file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      // Subtitle timing must follow the seek offset.
      filters.push(`setpts=PTS+${start}/TB`, `subtitles='${f}'${burn.index != null ? `:si=${burn.index}` : ''}`, 'setpts=PTS-STARTPTS');
    }
    filters.push(`scale=-2:'min(${maxHeight},ih)'`, 'format=yuv420p');
    args.push('-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-g', '50');
  } else {
    args.push('-c:v', 'copy');
    if (item.vcodec === 'hevc') args.push('-tag:v', 'hvc1');
  }
  const chosen = item.audio?.[audio];
  if (chosen && chosen.codec === 'aac' && !burn && mode !== 'transcode') args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push('-sn', '-dn');
  return args;
}

// Fragmented MP4 that Chromium's <video> can play progressively.
export function videoStream(item, opts) {
  const args = videoArgs(item, opts);
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return pipeStream(args);
}

// Subtitles (embedded text track or sidecar file) as WebVTT, shifted to the stream's start offset.
export function subtitleStream(item, n, start = 0) {
  const sub = item.subs?.[n];
  if (!sub) throw new Error('No such subtitle');
  const args = ['-v', 'error', '-nostdin'];
  if (start > 0) args.push('-ss', String(start));
  if (sub.kind === 'external') {
    if (!isUtf8(sub.path)) args.push('-sub_charenc', 'CP1252');
    args.push('-i', sub.path, '-map', '0:s:0');
  } else {
    args.push('-i', item.path, '-map', `0:s:${sub.index}`);
  }
  args.push('-f', 'webvtt', 'pipe:1');
  return pipeStream(args);
}

function isUtf8(file) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    return true;
  } catch {
    return false;
  }
}

// Used for files music-metadata can't parse: read the duration from FFmpeg's banner.
export function probeDuration(file) {
  const bin = ffmpegPath();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-i', file], { timeout: 15000 }, (_err, _out, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr || '');
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : null);
    });
  });
}
