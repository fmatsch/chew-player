import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

// Decode any file FFmpeg understands into a FLAC stream Chromium can play.
export function transcodeStream(file, startSeconds = 0, sampleRate = 0) {
  const bin = ffmpegPath();
  if (!bin) throw new Error('FFmpeg not found');
  const args = ['-v', 'error', '-nostdin'];
  if (startSeconds > 0) args.push('-ss', String(startSeconds));
  args.push('-i', file, '-vn', '-map', '0:a:0');
  if (sampleRate > 192000 || sampleRate === 0) args.push('-ar', sampleRate === 0 ? '48000' : '96000');
  args.push('-sample_fmt', 's16', '-c:a', 'flac', '-compression_level', '0', '-f', 'flac', 'pipe:1');
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });

  return new ReadableStream({
    start(controller) {
      proc.stdout.on('data', (chunk) => {
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize <= 0) proc.stdout.pause();
      });
      proc.stdout.on('end', () => controller.close());
      proc.on('error', (err) => controller.error(err));
    },
    pull() { proc.stdout.resume(); },
    cancel() { proc.kill('SIGKILL'); },
  }, { highWaterMark: 1 << 20, size: (chunk) => chunk.byteLength });
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
