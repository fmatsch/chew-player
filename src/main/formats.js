import path from 'node:path';

// Every extension we pick up while scanning folders. Anything Chromium can't
// decode natively is piped through FFmpeg at playback time.
export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'mp2', 'mp1', 'm4a', 'm4b', 'mp4', 'aac', 'flac', 'ogg', 'oga', 'opus',
  'spx', 'wav', 'wave', 'aif', 'aiff', 'aifc', 'caf', 'wma', 'asf', 'ape', 'wv',
  'mpc', 'mp+', 'tta', 'dsf', 'dff', 'ac3', 'eac3', 'dts', 'mka', 'webm', 'au',
  'snd', 'amr', 'alac', 'tak', 'ofr', 'shn', 'mod', 'xm', 's3m', 'it',
]);

export const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

const NATIVE_EXTENSIONS = new Set(['mp3', 'flac', 'ogg', 'oga', 'opus', 'wav', 'wave', 'webm']);
const MP4_EXTENSIONS = new Set(['m4a', 'm4b', 'mp4', 'aac']);

export const extOf = (file) => path.extname(file).slice(1).toLowerCase();

export const isAudioFile = (file) => AUDIO_EXTENSIONS.has(extOf(file));

// Best guess whether Chromium's built-in decoders can play this track.
// The renderer falls back to the FFmpeg stream if a "native" track fails anyway.
export function playbackMode(file, codec = '') {
  const ext = extOf(file);
  const c = codec.toLowerCase();
  if (NATIVE_EXTENSIONS.has(ext)) return 'native';
  if (MP4_EXTENSIONS.has(ext) && !c.includes('alac')) return 'native';
  return 'transcode';
}
