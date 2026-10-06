// Online info for videos — free APIs that need no key:
//   • TV shows: TVMaze (show info, posters, episode titles/summaries/stills)
//   • Movies:   Wikidata + Wikipedia (year, genre, director, poster, plot summary)

const UA = 'ChewPlayer ( https://github.com/fmatsch/chew-player )';

function limiter(gapMs) {
  let queue = Promise.resolve();
  let last = 0;
  return (fn) => {
    const run = queue.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    queue = run.catch(() => {});
    return run;
  };
}
const tvmazeQueue = limiter(600);   // TVMaze allows ~20 calls / 10 s

async function getJson(url, queue) {
  return queue(async () => {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('Rate limited, try again later');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

const norm = (s = '') => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const stripHtml = (s) => (s ? s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : null);
const yearOf = (d) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);

export async function lookupShow(name) {
  const show = await getJson(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(name)}&embed=episodes`, tvmazeQueue);
  if (!show) return null;
  // TVMaze always returns its best guess; only accept it when the names really match.
  const a = norm(name).replace(/^the /, '');
  const b = norm(show.name).replace(/^the /, '').replace(/ \d{4}$/, '');
  if (a !== b && !(b.startsWith(a) && a.length / b.length > 0.6) && !(a.startsWith(b) && b.length / a.length > 0.6)) return null;
  const episodes = {};
  for (const e of show._embedded?.episodes || []) {
    episodes[`${e.season}:${e.number}`] = { name: e.name, airdate: e.airdate, summary: stripHtml(e.summary), image: e.image?.medium || null };
  }
  return {
    tvmazeId: show.id,
    name: show.name,
    year: yearOf(show.premiered),
    genres: show.genres || [],
    summary: stripHtml(show.summary),
    image: show.image?.original || show.image?.medium || null,
    episodes,
  };
}

const FILM_TYPES = new Set([
  'Q11424', 'Q24869', 'Q506240', 'Q202866', 'Q93204', 'Q24862', 'Q226730', 'Q17123180', 'Q229390', 'Q1054574', 'Q130232',
  'Q20650540', 'Q645928', 'Q319221', 'Q2484376', 'Q959790', 'Q2297927', 'Q10590726', 'Q1361932', 'Q459290', 'Q28968511',
]);
const wikiQueue = limiter(250);
const wd = (params) => getJson(`https://www.wikidata.org/w/api.php?format=json&origin=*&${params}`, wikiQueue);

const claimIds = (e, p) => (e.claims?.[p] || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
const claimYear = (e) => {
  const years = (e.claims?.P577 || []).map((c) => /([+-]\d{4})/.exec(c.mainsnak?.datavalue?.value?.time || '')?.[1]).filter(Boolean).map(Number);
  return years.length ? Math.min(...years) : null;
};

// Movies via Wikidata (identity, year, genre, director) + Wikipedia (poster and plot summary).
export async function lookupMovie(title, year, lang = 'en') {
  // Full-text search restricted to items that are films (a plain label search drowns "Heat" in other meanings).
  const filmFilter = 'haswbstatement:P31=Q11424|P31=Q24869|P31=Q202866|P31=Q506240|P31=Q93204|P31=Q24862';
  const search = await wd(`action=query&list=search&srlimit=12&srsearch=${encodeURIComponent(`${title} ${filmFilter}`)}`);
  let ids = (search?.query?.search || []).map((r) => r.title).filter((t) => /^Q\d+$/.test(t));
  if (!ids.length) {
    const fallback = await wd(`action=wbsearchentities&type=item&limit=12&language=en&uselang=en&search=${encodeURIComponent(title)}`);
    ids = (fallback?.search || []).map((r) => r.id);
  }
  if (!ids.length) return null;
  const ents = await wd(`action=wbgetentities&props=claims|labels|sitelinks&languages=en|${lang}&ids=${ids.join('|')}`);
  const want = norm(title);
  let best = null;
  ids.forEach((id, rank) => {
    const e = ents?.entities?.[id];
    if (!e || !claimIds(e, 'P31').some((t) => FILM_TYPES.has(t))) return;
    const label = e.labels?.en?.value || e.labels?.[lang]?.value || '';
    const y = claimYear(e);
    let s = 20 - rank;
    if (norm(label) === want || norm(e.labels?.[lang]?.value || '') === want) s += 50;
    if (year && y) s += y === year ? 60 : Math.abs(y - year) === 1 ? 30 : -50;
    if (!best || s > best.s) best = { s, e, y, label };
  });
  if (!best || best.s < 40) return null;
  const { e } = best;

  const genreIds = claimIds(e, 'P136').slice(0, 3);
  const directorIds = claimIds(e, 'P57').slice(0, 2);
  const labels = {};
  if (genreIds.length || directorIds.length) {
    const l = await wd(`action=wbgetentities&props=labels&languages=en&ids=${[...genreIds, ...directorIds].join('|')}`);
    for (const [id, x] of Object.entries(l?.entities || {})) labels[id] = x.labels?.en?.value;
  }
  const site = e.sitelinks?.[`${lang}wiki`] ? lang : 'en';
  const page = e.sitelinks?.[`${site}wiki`]?.title;
  let summary = null;
  if (page) {
    const w = await getJson(`https://${site}.wikipedia.org/w/api.php?format=json&origin=*&action=query&prop=extracts&exintro=1&explaintext=1&exsentences=4&redirects=1&titles=${encodeURIComponent(page)}`, wikiQueue);
    summary = Object.values(w?.query?.pages || {})[0]?.extract || null;
  }
  // Posters are usually non-free uploads on English Wikipedia, which the page-image API hides;
  // the article's `page_image` property still names the infobox image.
  let image = null;
  const enPage = e.sitelinks?.enwiki?.title;
  if (enPage) {
    const props = await getJson(`https://en.wikipedia.org/w/api.php?format=json&origin=*&action=query&prop=pageprops&ppprop=page_image&redirects=1&titles=${encodeURIComponent(enPage)}`, wikiQueue);
    const file = Object.values(props?.query?.pages || {})[0]?.pageprops?.page_image;
    if (file) {
      const info = await getJson(`https://en.wikipedia.org/w/api.php?format=json&origin=*&action=query&prop=imageinfo&iiprop=url&iiurlwidth=600&titles=${encodeURIComponent(`File:${file}`)}`, wikiQueue);
      const ii = Object.values(info?.query?.pages || {})[0]?.imageinfo?.[0];
      image = ii?.thumburl || ii?.url || null;
    }
  }
  const genre = genreIds.map((g) => labels[g]).filter(Boolean)
    .map((g) => g.replace(/ film$/, '').replace(/^./, (c) => c.toUpperCase()))[0] || null;
  return {
    title: e.labels?.[lang]?.value || best.label,
    year: best.y,
    genre,
    summary,
    director: directorIds.map((d) => labels[d]).filter(Boolean).join(', ') || null,
    image,
    wikidataId: e.id,
  };
}

export async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return null;
  return { data: Buffer.from(await res.arrayBuffer()), type };
}
