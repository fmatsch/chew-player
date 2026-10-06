import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { ffmpegPath } from './ffmpeg.js';

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'asf', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'ts',
  'vob', '3gp', 'ogv', 'divx', 'rmvb', 'rm', 'f4v',
]);
export const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa', 'sub']);

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'microdvd']);
const NATIVE_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const NATIVE_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm']);

const LANGS = {
  eng: 'English', ger: 'German', deu: 'German', fre: 'French', fra: 'French', spa: 'Spanish', ita: 'Italian', jpn: 'Japanese',
  por: 'Portuguese', rus: 'Russian', chi: 'Chinese', zho: 'Chinese', kor: 'Korean', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish',
  dan: 'Danish', nor: 'Norwegian', fin: 'Finnish', pol: 'Polish', tur: 'Turkish', ara: 'Arabic', hin: 'Hindi', cze: 'Czech', ces: 'Czech',
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', ja: 'Japanese', pt: 'Portuguese', ru: 'Russian', nl: 'Dutch',
};
export const langName = (code) => (code ? LANGS[code.toLowerCase()] || code.toUpperCase() : '');

// Read container/stream info from FFmpeg's banner (no ffprobe needed).
export function probeVideo(file) {
  const bin = ffmpegPath();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, ['-hide_banner', '-i', file], { timeout: 30000, maxBuffer: 4 << 20 }, (_err, _out, stderr) => {
      const text = stderr || '';
      const info = { duration: null, width: null, height: null, vcodec: null, acodec: null, audio: [], subs: [], container: null };
      const c = /Input #0, ([^,\n]+)/.exec(text);
      if (c) info.container = c[1];
      const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (d) info.duration = (+d[1]) * 3600 + (+d[2]) * 60 + (+d[3]);
      const lines = text.split('\n');
      let current = null;
      for (const line of lines) {
        const m = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([\w-]+)\))?: (Video|Audio|Subtitle): ([\w-]+)(.*)$/.exec(line);
        if (m) {
          const [, , lang, type, codec, rest] = m;
          current = null;
          if (type === 'Video') {
            if (/attached pic/.test(rest) || info.vcodec) continue;
            info.vcodec = codec;
            const r = /(\d{2,5})x(\d{2,5})/.exec(rest);
            if (r) { info.width = +r[1]; info.height = +r[2]; }
          } else if (type === 'Audio') {
            const ch = /(mono|stereo|[0-9.]+\(\w+\)|[0-9.]+ channels|5\.1|7\.1)/.exec(rest);
            current = { index: info.audio.length, codec, lang: lang && lang !== 'und' ? lang : null, channels: ch ? ch[1].replace(/\(.*\)/, '') : null, default: /\(default\)/.test(rest), title: null };
            info.audio.push(current);
          } else {
            current = { index: info.subs.length, codec, lang: lang && lang !== 'und' ? lang : null, text: TEXT_SUBS.has(codec), forced: /\(forced\)/.test(rest), default: /\(default\)/.test(rest), title: null };
            info.subs.push(current);
          }
          continue;
        }
        const t = /^\s+title\s*:\s*(.+)$/.exec(line);
        if (t && current) current.title = t[1].trim();
        if (/^\s*Stream #|^\S/.test(line) && !m) current = null;
      }
      info.acodec = (info.audio.find((a) => a.default) || info.audio[0])?.codec || null;
      resolve(info.vcodec || info.audio.length ? info : null);
    });
  });
}

// native: Chromium plays the file directly · remux: copy video, convert audio, re-wrap as MP4 · transcode: full H.264 encode
export function videoPlayback(file, info) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!info?.vcodec) return 'transcode';
  const audioOk = !info.audio.length || NATIVE_AUDIO.has(info.acodec);
  if (NATIVE_CONTAINERS.has(ext) && NATIVE_VIDEO.has(info.vcodec) && audioOk) return 'native';
  if (NATIVE_VIDEO.has(info.vcodec)) return 'remux';
  return 'transcode';
}

// Grab a frame as a JPEG thumbnail.
export function grabFrame(file, at, out) {
  const bin = ffmpegPath();
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    const p = spawn(bin, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', out], { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    p.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

const STRONG = String.raw`2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?|bluray|blu-ray|bdrip|brrip|bdremux|remux|web-?dl|webrip|hdtv|dvdrip|hdrip|x264|x265|h\.?264|h\.?265|hevc|xvid|divx|ac3|eac3|dts|dd5\.?1|atmos|truehd|10bit`;
// Language/edition words only count as release tags when they sit among the technical ones ("German.DL.1080p").
const WEAK = String.raw`german|english|french|multi|dubbed|subbed|dl|ml|proper|repack|extended|unrated|uncut|internal|limited|imax|web|aac|avc|dvd`;
const JUNK = new RegExp(String.raw`(?:\b(?:${WEAK})\b[\s.-]*)*\b(?:${STRONG})\b.*$|(?:\b(?:${WEAK})\b[\s.-]*)+$`, 'i');

const clean = (s) => s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').replace(/[\s\-–[(]+$/, '').trim();

// Movies: "Title (2010)" / "Title.2010.1080p…"; episodes: "Show.S01E02.Title" / "Show 1x02" / "Show/Season 1/02 Title".
export function guessVideo(file, root) {
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const dir = path.dirname(file);
  const parent = path.basename(dir);
  const isSeasonDir = /^(season|staffel|series|saison|temporada)\s*\d+$/i.test(parent) || /^s\d{1,2}$/i.test(parent);
  const showFromDirs = () => {
    const d = isSeasonDir ? path.dirname(dir) : dir;
    if (root && path.resolve(d) === path.resolve(root)) return null;
    return clean(path.basename(d).replace(/[([]\s*(19|20)\d{2}\s*[)\]]/, ''));
  };

  const name = base.replace(/[._]+/g, ' ');
  let m = /^(.*?)\s*[-[(]?\s*s(\d{1,2})\s*[ex.]?\s*e?(\d{1,3})(?:\s*-?\s*e\d{1,3})?\s*[\])]?(.*)$/i.exec(name)
    || /^(.*?)\s+(\d{1,2})x(\d{2,3})(.*)$/i.exec(name);
  if (m && /\d/.test(m[2])) {
    const show = clean(m[1]) || showFromDirs() || 'Unknown Show';
    const epTitle = clean(m[4].replace(/^[\s\-–.]+/, '').replace(JUNK, ''));
    return { type: 'episode', show, season: +m[2], episode: +m[3], epTitle: epTitle || null };
  }
  if (isSeasonDir) {
    const n = /^(?:e|ep|episode|folge)?\s*(\d{1,3})\b[\s\-–.]*(.*)$/i.exec(name);
    if (n) {
      const season = +(/\d+/.exec(parent)[0]);
      return { type: 'episode', show: showFromDirs() || 'Unknown Show', season, episode: +n[1], epTitle: clean(n[2].replace(JUNK, '')) || null };
    }
  }

  const movie = (s) => {
    const y = /^(.*?)[\s([]*((?:19|20)\d{2})[)\]]?(?:\s|$)/.exec(s);
    if (y && clean(y[1])) return { title: clean(y[1]), year: +y[2] };
    return { title: clean(s.replace(JUNK, '')) || null, year: null };
  };
  let g = movie(name);
  // Generic file names ("movie.mkv", "video_ts") → use the folder name, e.g. "Heat (1995)/movie.mkv".
  const dirGuess = parent && (!root || path.resolve(dir) !== path.resolve(root)) ? movie(parent.replace(/[._]+/g, ' ')) : null;
  if (dirGuess?.title && (!g.title || /^(movie|film|video|vts.*|main|feature|title\s*\d*)$/i.test(g.title) || (!g.year && dirGuess.year))) {
    g = { title: g.year && !dirGuess.year ? g.title : dirGuess.title, year: dirGuess.year || g.year };
  }
  return { type: 'movie', title: g.title || base, year: g.year };
}
