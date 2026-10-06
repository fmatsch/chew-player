// Online lookups against MusicBrainz (tags) and the Cover Art Archive (artwork).
// Both are free, open databases; MusicBrainz asks for max. 1 request/second
// and a descriptive User-Agent, which we honour.

const MB = 'https://musicbrainz.org/ws/2';
const CAA = 'https://coverartarchive.org';

let userAgent = 'ChewPlayer/0.1 ( https://github.com/fmatsch/chew-player )';
export const setUserAgent = (version) => {
  userAgent = `ChewPlayer/${version} ( https://github.com/fmatsch/chew-player )`;
};

let queue = Promise.resolve();
let last = 0;
// Serialise all MusicBrainz requests with >= 1.1 s spacing.
function throttled(fn) {
  const run = queue.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

async function mbGet(endpoint, query, attempt = 0) {
  const url = query == null ? `${MB}/${endpoint}?fmt=json` : `${MB}/${endpoint}?query=${encodeURIComponent(query)}&fmt=json&limit=50`;
  const res = await throttled(() => fetch(url, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
  }));
  if (res.status === 503 || res.status === 429) {
    // Back off and retry a few times before giving up.
    if (attempt >= 3) throw new Error('MusicBrainz is rate limiting, try again later');
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    return mbGet(endpoint, query, attempt + 1);
  }
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
  return res.json();
}

const groupYears = new Map();
// The release group's first-release-date is the album's original year, independent of reissues.
async function releaseGroupYear(id) {
  if (!id) return null;
  if (!groupYears.has(id)) {
    try { groupYears.set(id, yearOf((await mbGet(`release-group/${id}`, null))['first-release-date'])); } catch { return null; }
  }
  return groupYears.get(id);
}

const esc = (s) => String(s).replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');

const norm = (s = '') => s.toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// "Nevermind (30th Anniversary Super Deluxe)" → "Nevermind"
const cleanAlbum = (t) => t && t.replace(/\s*[([][^)\]]*\b(deluxe|anniversary|remaster(ed)?|edition|expanded|bonus|reissue|collector'?s)\b[^)\]]*[)\]]\s*$/i, '').trim();

const yearOf = (date) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

const artistCredit = (credit = []) => credit.map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('');

// Higher is better: official studio albums beat singles, compilations, live bootlegs and remixes.
function releaseScore(r, wantedAlbum, wantedArtist) {
  let s = 0;
  const credit = norm(artistCredit(r['artist-credit']));
  if (wantedArtist && credit === norm(wantedArtist)) s += 25;
  if (credit === 'various artists') s -= 30;
  if (wantedAlbum && norm(r.title) === norm(wantedAlbum)) s += 60;
  if (r.status === 'Official') s += 20; else s -= 20;
  const rg = r['release-group'] || {};
  if (rg['primary-type'] === 'Album') s += 15;
  else if (rg['primary-type'] === 'EP') s += 5;
  if (!rg['secondary-types']?.length) s += 15; // not a compilation/live/remix release
  if (r.date) s += 2;
  return s;
}

function pickRelease(releases = [], wantedAlbum, wantedArtist) {
  if (!releases.length) return null;
  return [...releases].sort((a, b) => releaseScore(b, wantedAlbum, wantedArtist) - releaseScore(a, wantedAlbum, wantedArtist)
    || (yearOf(a.date) || 9999) - (yearOf(b.date) || 9999))[0];
}

// Find the best matching recording for a track. Returns null when nothing convincing comes back.
export async function lookupRecording({ title, artist, album }) {
  if (!title || !artist) return null;
  const base = `recording:"${esc(title)}" AND artist:"${esc(artist)}"`;
  const wantedTitle = title.trim().toLowerCase();
  const wantedNorm = norm(title);
  const usable = (data) => (data.recordings || []).filter((r) => r.score >= 80 && norm(r.title) === wantedNorm);

  let candidates = [];
  if (album) candidates = usable(await mbGet('recording', `${base} AND release:"${esc(album)}"`));
  if (!candidates.length) candidates = usable(await mbGet('recording', `${base} AND status:official AND primarytype:album`));
  if (!candidates.length) candidates = usable(await mbGet('recording', base));
  if (!candidates.length) return null;

  // How often each release group shows up: the canonical album has many editions, a deluxe bonus track has few.
  const groupCount = new Map();
  for (const rec of candidates) {
    for (const rg of new Set((rec.releases || []).map((r) => r['release-group']?.id).filter(Boolean))) {
      groupCount.set(rg, (groupCount.get(rg) || 0) + 1);
    }
  }
  // Score every (recording, release) pair and keep the best one.
  let best = null;
  for (const rec of candidates) {
    let recScore = rec.score / 10;
    if (rec.title.trim().toLowerCase() === wantedTitle) recScore += 30; // "Song" beats "Song (remix)"
    if (/\b(live|demo|remix|mix|edit|instrumental|acoustic|karaoke|rehearsal|session)\b/i.test(rec.disambiguation || '')) recScore -= 40;
    else if (rec.disambiguation) recScore -= 10;
    for (const rel of rec.releases?.length ? rec.releases : [null]) {
      const s = recScore + (rel ? releaseScore(rel, album, artist) + Math.min(groupCount.get(rel['release-group']?.id) || 0, 10) * 2 : -50);
      const year = yearOf(rel?.date) || yearOf(rec['first-release-date']) || 9999;
      if (!best || s > best.s || (s === best.s && year < best.year)) best = { s, rec, rel, year };
    }
  }
  const { rec, rel: release } = best;
  // Original year: earliest release in the chosen release group among all candidates.
  const rgId = release?.['release-group']?.id;
  let year = null;
  for (const r of candidates) {
    const inGroup = (r.releases || []).some((rl) => release && (rl['release-group']?.id === rgId || norm(rl.title) === norm(release.title)));
    if (!inGroup) continue;
    for (const y of [yearOf(r['first-release-date']), ...(r.releases || []).filter((rl) => rl['release-group']?.id === rgId).map((rl) => yearOf(rl.date))]) {
      if (y && (!year || y < year)) year = y;
    }
  }
  const groupYear = await releaseGroupYear(rgId);
  if (groupYear) year = groupYear;
  const medium = release?.media?.[0];
  // Track numbers from reissues with bonus discs/tracks are unreliable, so only trust the original edition.
  const trackNo = yearOf(release?.date) === year && medium?.track?.[0]?.number ? parseInt(medium.track[0].number, 10) || null : null;
  return {
    recordingId: rec.id,
    title: rec.title,
    artist: artistCredit(rec['artist-credit']) || artist,
    album: cleanAlbum(release?.['release-group']?.title || release?.title) || null,
    albumArtist: release ? artistCredit(release['artist-credit']) || null : null,
    year: year || yearOf(rec['first-release-date']) || yearOf(release?.date),
    trackNo,
    releaseId: release?.id || null,
    releaseGroupId: rgId || null,
  };
}

export async function lookupRelease({ album, artist }) {
  if (!album || !artist) return null;
  const data = await mbGet('release', `release:"${esc(album)}" AND artist:"${esc(artist)}"`);
  const wanted = norm(album);
  const hits = (data.releases || []).filter((r) => r.score >= 85 && norm(r.title) === wanted);
  const best = pickRelease(hits, album, artist);
  return best ? { releaseId: best.id, releaseGroupId: best['release-group']?.id || null, year: yearOf(best.date) } : null;
}

async function caaFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent }, redirect: 'follow' });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return null;
  return { data: Buffer.from(await res.arrayBuffer()), type };
}

// Front cover from the Cover Art Archive.
export async function fetchCover({ releaseId, releaseGroupId }) {
  // The release group's cover is the canonical album art; the exact release is the fallback.
  if (releaseGroupId) {
    const img = await caaFetch(`${CAA}/release-group/${releaseGroupId}/front-500`);
    if (img) return img;
  }
  return releaseId ? caaFetch(`${CAA}/release/${releaseId}/front-500`) : null;
}
