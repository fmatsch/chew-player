// Smart playlists: rule-based, live-updating lists for music and video.
//
// smart = {
//   match: 'all' | 'any',
//   rules: [{ field, op, value, value2?, unit? }],
//   limit: { count, by } | null,
// }

import { $, esc, collator } from './util.js';
import { icon, hydrateIcons } from './icons.js';

const DAY = 86400000;
const UNITS = { days: DAY, weeks: 7 * DAY, months: 30 * DAY };

export const FIELDS = {
  audio: {
    title: { label: 'Title', type: 'text' },
    artist: { label: 'Artist', type: 'text' },
    albumArtist: { label: 'Album Artist', type: 'text' },
    album: { label: 'Album', type: 'text' },
    genre: { label: 'Genre', type: 'text' },
    year: { label: 'Year', type: 'number' },
    rating: { label: 'Rating', type: 'number', hint: '0–5 stars' },
    plays: { label: 'Plays', type: 'number' },
    lastPlayed: { label: 'Last Played', type: 'date' },
    added: { label: 'Date Added', type: 'date' },
    duration: { label: 'Time (minutes)', type: 'number', scale: 60 },
    format: { label: 'Format', type: 'text' },
    lossless: { label: 'Lossless', type: 'bool' },
    path: { label: 'File Path', type: 'text' },
  },
  video: {
    title: { label: 'Title', type: 'text' },
    show: { label: 'TV Show', type: 'text' },
    genre: { label: 'Genre', type: 'text' },
    year: { label: 'Year', type: 'number' },
    type: { label: 'Type', type: 'enum', options: [['movie', 'Movie'], ['episode', 'TV Episode']] },
    season: { label: 'Season', type: 'number' },
    watched: { label: 'Watched', type: 'bool' },
    inProgress: { label: 'In Progress', type: 'bool' },
    plays: { label: 'Plays', type: 'number' },
    lastPlayed: { label: 'Last Played', type: 'date' },
    added: { label: 'Date Added', type: 'date' },
    duration: { label: 'Duration (minutes)', type: 'number', scale: 60 },
    height: { label: 'Resolution (lines)', type: 'number', hint: 'e.g. 1080, 2160' },
    format: { label: 'Format', type: 'text' },
    path: { label: 'File Path', type: 'text' },
  },
};

const OPS = {
  text: [['contains', 'contains'], ['notContains', 'does not contain'], ['is', 'is'], ['isNot', 'is not'], ['starts', 'starts with'], ['ends', 'ends with']],
  number: [['eq', 'is'], ['ne', 'is not'], ['gt', 'is greater than'], ['lt', 'is less than'], ['range', 'is in the range']],
  date: [['inLast', 'is in the last'], ['notInLast', 'is not in the last'], ['before', 'is before'], ['after', 'is after'], ['never', 'is never']],
  bool: [['true', 'is true'], ['false', 'is false']],
  enum: [['is', 'is'], ['isNot', 'is not']],
};

export const LIMIT_BY = [
  ['random', 'random'], ['title', 'title'], ['mostPlayed', 'most played'], ['leastPlayed', 'least played'],
  ['newest', 'most recently added'], ['oldest', 'least recently added'],
  ['recentPlayed', 'most recently played'], ['leastRecentPlayed', 'least recently played'],
  ['highestRated', 'highest rating'], ['lowestRated', 'lowest rating'],
];

export const defaultRule = (kind) => (kind === 'video'
  ? { field: 'watched', op: 'false', value: '' }
  : { field: 'rating', op: 'gt', value: '3' });

// ---------------------------------------------------------------- evaluation

function test(item, rule, schema, now) {
  const f = schema[rule.field];
  if (!f) return true;
  const raw = item[rule.field];
  switch (f.type) {
    case 'text': {
      const v = String(raw ?? '').toLowerCase();
      const q = String(rule.value ?? '').toLowerCase();
      return {
        contains: v.includes(q), notContains: !v.includes(q), is: v === q, isNot: v !== q, starts: v.startsWith(q), ends: v.endsWith(q),
      }[rule.op] ?? true;
    }
    case 'number': {
      const v = (Number(raw) || 0) / (f.scale || 1);
      const a = Number(rule.value);
      const b = Number(rule.value2);
      return { eq: v === a, ne: v !== a, gt: v > a, lt: v < a, range: v >= Math.min(a, b) && v <= Math.max(a, b) }[rule.op] ?? true;
    }
    case 'date': {
      const v = Number(raw) || 0;
      if (rule.op === 'never') return !v;
      if (rule.op === 'inLast' || rule.op === 'notInLast') {
        const span = (Number(rule.value) || 0) * (UNITS[rule.unit] || DAY);
        const inside = v > 0 && now - v <= span;
        return rule.op === 'inLast' ? inside : !inside;
      }
      const d = Date.parse(rule.value);
      if (Number.isNaN(d)) return true;
      return rule.op === 'before' ? v > 0 && v < d : v >= d + DAY;
    }
    case 'bool': return rule.op === 'true' ? !!raw : !raw;
    case 'enum': return rule.op === 'is' ? raw === rule.value : raw !== rule.value;
    default: return true;
  }
}

const LIMIT_SORT = {
  title: (a, b) => collator.compare(a.title || '', b.title || ''),
  mostPlayed: (a, b) => (b.plays || 0) - (a.plays || 0),
  leastPlayed: (a, b) => (a.plays || 0) - (b.plays || 0),
  newest: (a, b) => (b.added || 0) - (a.added || 0),
  oldest: (a, b) => (a.added || 0) - (b.added || 0),
  recentPlayed: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0),
  leastRecentPlayed: (a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0),
  highestRated: (a, b) => (b.rating || 0) - (a.rating || 0),
  lowestRated: (a, b) => (a.rating || 0) - (b.rating || 0),
};

// Random picks stay stable for a playlist until the library changes, so the list doesn't reshuffle on every render.
const randomCache = new Map();

export function evaluate(playlist, items, kind) {
  const smart = playlist.smart;
  const schema = FIELDS[kind];
  const now = Date.now();
  const rules = smart.rules || [];
  let list = items.filter((it) => (!rules.length ? true
    : smart.match === 'any' ? rules.some((r) => test(it, r, schema, now)) : rules.every((r) => test(it, r, schema, now))));
  const lim = smart.limit;
  if (lim && lim.count > 0) {
    if (lim.by === 'random') {
      const key = `${playlist.id}:${JSON.stringify(smart)}:${items.length}`;
      let picked = randomCache.get(key);
      if (!picked) {
        const shuffled = [...list];
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
        picked = shuffled.slice(0, lim.count).map((t) => t.id);
        randomCache.set(key, picked);
      }
      const byId = new Map(list.map((t) => [t.id, t]));
      list = picked.map((id) => byId.get(id)).filter(Boolean);
    } else {
      list = [...list].sort(LIMIT_SORT[lim.by] || LIMIT_SORT.title).slice(0, lim.count);
    }
  }
  return list;
}

// Human-readable one-liner for the playlist header.
export function describe(smart, kind) {
  const schema = FIELDS[kind];
  const parts = (smart.rules || []).map((r) => {
    const f = schema[r.field];
    if (!f) return '';
    const op = (OPS[f.type].find(([k]) => k === r.op) || [])[1] || '';
    let v = r.value;
    if (f.type === 'bool' || r.op === 'never') v = '';
    if (f.type === 'enum') v = (f.options.find(([k]) => k === r.value) || [])[1] || r.value;
    if (r.op === 'range') v = `${r.value}–${r.value2}`;
    if (r.op === 'inLast' || r.op === 'notInLast') v = `${r.value} ${r.unit || 'days'}`;
    return `${f.label.replace(/ \(.*\)$/, '')} ${op}${v !== '' && v != null ? ` ${v}` : ''}`;
  }).filter(Boolean);
  let text = parts.length ? parts.join(smart.match === 'any' ? ' or ' : ' and ') : 'All items';
  if (smart.limit?.count) text += ` · limited to ${smart.limit.count}, by ${(LIMIT_BY.find(([k]) => k === smart.limit.by) || [])[1]}`;
  return text;
}

// ---------------------------------------------------------------- editor

function ruleRow(rule, kind) {
  const schema = FIELDS[kind];
  const f = schema[rule.field] || Object.values(schema)[0];
  const ops = OPS[f.type];
  const op = ops.some(([k]) => k === rule.op) ? rule.op : ops[0][0];
  let value = '';
  if (f.type === 'text' || (f.type === 'number' && op !== 'range')) {
    value = `<input class="rv" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(rule.value ?? '')}" placeholder="${esc(f.hint || '')}">`;
  } else if (f.type === 'number') {
    value = `<input class="rv" type="number" value="${esc(rule.value ?? '')}"><span class="to">to</span><input class="rv2" type="number" value="${esc(rule.value2 ?? '')}">`;
  } else if (f.type === 'date' && (op === 'inLast' || op === 'notInLast')) {
    value = `<input class="rv" type="number" min="1" value="${esc(rule.value || 30)}"><select class="ru">${['days', 'weeks', 'months'].map((u) => `<option ${rule.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select>`;
  } else if (f.type === 'date' && op !== 'never') {
    value = `<input class="rv" type="date" value="${esc(rule.value ?? '')}">`;
  } else if (f.type === 'enum') {
    value = `<select class="rv">${f.options.map(([k, l]) => `<option value="${k}" ${rule.value === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  }
  return `<div class="rule">
    <select class="rf">${Object.entries(schema).map(([k, d]) => `<option value="${k}" ${k === rule.field ? 'selected' : ''}>${d.label}</option>`).join('')}</select>
    <select class="ro">${ops.map(([k, l]) => `<option value="${k}" ${k === op ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <span class="rvals">${value}</span>
    <button class="icon-btn small" data-r="remove" title="Remove rule">−</button>
    <button class="icon-btn small" data-r="add" title="Add rule">${icon('plus')}</button>
  </div>`;
}

// Opens the rule editor. Resolves with { name, smart } or null when cancelled.
export function editSmart({ name = 'Smart Playlist', smart = null, kind = 'audio', countFor }) {
  const state = smart ? JSON.parse(JSON.stringify(smart)) : { match: 'all', rules: [defaultRule(kind)], limit: null };
  const modal = $('#modal');
  return new Promise((resolve) => {
    const readRules = () => {
      state.rules = [...modal.querySelectorAll('.rule')].map((row) => {
        const r = { field: row.querySelector('.rf').value, op: row.querySelector('.ro').value, value: row.querySelector('.rv')?.value ?? '' };
        if (row.querySelector('.rv2')) r.value2 = row.querySelector('.rv2').value;
        if (row.querySelector('.ru')) r.unit = row.querySelector('.ru').value;
        return r;
      });
      state.match = modal.querySelector('#sm-match').value;
      const on = modal.querySelector('#sm-limit-on').checked;
      state.limit = on ? { count: Math.max(1, parseInt(modal.querySelector('#sm-limit-count').value, 10) || 25), by: modal.querySelector('#sm-limit-by').value } : null;
    };
    const updateCount = () => {
      readRules();
      const n = countFor({ id: 'preview', smart: state });
      modal.querySelector('#sm-count').textContent = `${n.toLocaleString()} ${kind === 'video' ? (n === 1 ? 'video' : 'videos') : (n === 1 ? 'song' : 'songs')} match`;
    };
    const draw = () => {
      modal.innerHTML = `<div class="modal wide">
        <h2>${smart ? 'Edit Smart Playlist' : 'New Smart Playlist'}</h2>
        <div class="sub">Updates automatically as your library changes.</div>
        <label class="field"><span>Name</span><input id="sm-name" value="${esc(name)}"></label>
        <div class="match">Match <select id="sm-match"><option value="all" ${state.match !== 'any' ? 'selected' : ''}>all</option><option value="any" ${state.match === 'any' ? 'selected' : ''}>any</option></select> of the following rules:</div>
        <div class="rules">${(state.rules.length ? state.rules : [defaultRule(kind)]).map((r) => ruleRow(r, kind)).join('')}</div>
        <div class="limit">
          <label><input type="checkbox" id="sm-limit-on" ${state.limit ? 'checked' : ''}> Limit to</label>
          <input id="sm-limit-count" type="number" min="1" value="${state.limit?.count || 25}">
          <span>${kind === 'video' ? 'videos' : 'songs'} selected by</span>
          <select id="sm-limit-by">${LIMIT_BY.map(([k, l]) => `<option value="${k}" ${state.limit?.by === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
        <div class="modal-actions">
          <div class="hint" id="sm-count"></div>
          <div><button class="btn ghost" data-m="cancel">Cancel</button><button class="btn" data-m="save">${smart ? 'Save' : 'Create'}</button></div>
        </div>
      </div>`;
      hydrateIcons(modal);
      updateCount();
    };
    const close = (result) => { modal.hidden = true; modal.innerHTML = ''; modal.onclick = modal.onchange = modal.oninput = modal.onkeydown = null; resolve(result); };
    draw();
    modal.hidden = false;
    modal.querySelector('#sm-name').select();
    modal.onchange = (e) => {
      if (e.target.matches('.rf, .ro')) {
        readRules();
        const row = e.target.closest('.rule');
        const i = [...modal.querySelectorAll('.rule')].indexOf(row);
        if (e.target.matches('.rf')) {
          const f = FIELDS[kind][state.rules[i].field];
          state.rules[i] = { field: state.rules[i].field, op: OPS[f.type][0][0], value: f.type === 'enum' ? f.options[0][0] : '' };
        }
        const nameNow = modal.querySelector('#sm-name').value;
        draw();
        modal.querySelector('#sm-name').value = nameNow;
        return;
      }
      updateCount();
    };
    modal.oninput = () => updateCount();
    modal.onclick = (e) => {
      if (e.target === modal) return close(null);
      const r = e.target.closest('[data-r]')?.dataset.r;
      if (r) {
        readRules();
        const i = [...modal.querySelectorAll('.rule')].indexOf(e.target.closest('.rule'));
        if (r === 'add') state.rules.splice(i + 1, 0, defaultRule(kind));
        if (r === 'remove') state.rules.splice(i, 1);
        const nameNow = modal.querySelector('#sm-name').value;
        draw();
        modal.querySelector('#sm-name').value = nameNow;
        return;
      }
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (m === 'cancel') close(null);
      if (m === 'save') { readRules(); close({ name: modal.querySelector('#sm-name').value.trim() || 'Smart Playlist', smart: state }); }
    };
    modal.onkeydown = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); readRules(); close({ name: modal.querySelector('#sm-name').value.trim() || 'Smart Playlist', smart: state }); }
    };
  });
}
