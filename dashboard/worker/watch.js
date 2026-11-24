// Watch: the next 7 days of streaming premieres (new movies, new series, new seasons) on the
// family's services. Trakt says what premieres when; TMDB adds posters, cast, age ratings and, for
// movies, which service has it (JustWatch data); OMDb adds the IMDb rating.
//
// A free-plan Worker may make about 50 outside requests per run, so the week is built a step at a
// time from the existing 5-minute cron (stepWatch): first the three Trakt calendars, one per run,
// then details for a batch of titles per run until every title has them. A full rebuild starts once
// a day. Titles opened before their details arrive are fetched on demand.

const TRAKT = 'https://api.trakt.tv';
const TMDB = 'https://api.themoviedb.org/3';
const OMDB = 'https://www.omdbapi.com/';
const DAYS = 7;
const WEEK_KEY = 'watch:week';
const TITLE_TTL = 7 * 864e5;
const REBUILD_MS = 20 * 3600e3;
const MAX_FETCHES = 36; // per cron run, under the free plan's 50 subrequests

// Matched against Trakt network names (shows) and TMDB/JustWatch provider names (movies).
export const SERVICES = [
  { id: 'netflix', name: 'Netflix', color: '#E50914', re: /^netflix/i },
  { id: 'prime', name: 'Prime Video', color: '#00A8E1', re: /^(amazon )?prime video|^amazon$|amazon studios|^amazon prime/i },
  { id: 'disney', name: 'Disney+', color: '#113CCF', re: /^disney(\+| plus)$/i },
  { id: 'hulu', name: 'Hulu', color: '#1CE783', re: /^hulu/i },
  { id: 'max', name: 'Max', color: '#002BE7', re: /^(hbo )?max$|^hbo$/i },
  { id: 'apple', name: 'Apple TV+', color: '#111111', re: /^apple tv(\+| plus)?$/i },
  { id: 'paramount', name: 'Paramount+', color: '#0064FF', re: /^paramount(\+| plus)/i },
  { id: 'hotstar', name: 'Hotstar (India)', color: '#0F1E5A', re: /hotstar/i },
];
const FAMILY_CERTS = ['G', 'PG', 'PG-13', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', 'TV-14', 'U', 'UA', 'U/A 7+', 'U/A 13+'];

function serviceOf(name, allowed) {
  const s = SERVICES.find((x) => x.re.test(String(name || '').trim()));
  return s && allowed.indexOf(s.id) >= 0 ? s.id : null;
}
export function isFamily(cert) { return !!cert && FAMILY_CERTS.indexOf(cert) >= 0; }

// ------------------------------------------------------------------ outside calls
function budget(n) { return { left: n }; }
async function getJson(b, url, headers) {
  if (b.left <= 0) throw new Error('fetch budget used');
  b.left--;
  const r = await fetch(url, { headers: Object.assign({ 'user-agent': 'HomeHQ/1.0', accept: 'application/json' }, headers || {}), signal: AbortSignal.timeout(15e3) });
  if (!r.ok) throw new Error(url.split('?')[0].replace(/api_key=\w+/, '') + ' → ' + r.status);
  return r.json();
}
function trakt(env, b, path) {
  return getJson(b, TRAKT + path, { 'trakt-api-version': '2', 'trakt-api-key': env.TRAKT_CLIENT_ID });
}
function tmdb(env, b, path) {
  // A v4 read token (long, starts with "ey") goes in a header; a v3 key in the query string.
  const v4 = /^ey/.test(env.TMDB_API_KEY);
  return getJson(b, TMDB + path + (v4 ? '' : (path.indexOf('?') < 0 ? '?' : '&') + 'api_key=' + env.TMDB_API_KEY),
    v4 ? { authorization: 'Bearer ' + env.TMDB_API_KEY } : null);
}

export function watchConfigured(env) { return !!(env.TRAKT_CLIENT_ID && env.TMDB_API_KEY); }

// ------------------------------------------------------------------ the week list
function localYmd(tz, ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
function localTime(tz, iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
}

async function readWeek(env) {
  const row = await env.DB.prepare('SELECT value FROM cache WHERE key = ?').bind(WEEK_KEY).first();
  return row ? JSON.parse(row.value) : null;
}
function writeWeek(env, h, week) { return h.putCache(env, WEEK_KEY, week, 3 * 864e5); }

// One Trakt calendar per run: shows/new, shows/premieres, movies/streaming.
const STAGES = ['new', 'premieres', 'movies'];
async function fetchStage(env, h, stage, week, b) {
  const W = h.CFG.watch, start = week.from;
  if (stage === 'movies') {
    const list = await trakt(env, b, '/calendars/all/movies/streaming/' + start + '/' + DAYS + '?extended=full');
    list.forEach((m) => {
      if (!m.movie || !m.movie.ids || !m.movie.ids.tmdb) return;
      add(week, { type: 'movie', tmdb: m.movie.ids.tmdb, imdb: m.movie.ids.imdb || null, title: m.movie.title, year: m.movie.year,
        date: m.released, time: null, service: null, label: 'Movie', cert: m.movie.certification || null, overview: m.movie.overview || '' });
    });
    return;
  }
  const list = await trakt(env, b, '/calendars/all/shows/' + (stage === 'new' ? 'new' : 'premieres') + '/' + start + '/' + DAYS + '?extended=full');
  list.forEach((x) => {
    const s = x.show, e = x.episode;
    if (!s || !s.ids || !s.ids.tmdb || !e || e.season < 1) return; // season 0 = specials
    const service = serviceOf(s.network, W.services);
    if (!service) return;
    if (stage === 'premieres' && e.season < 2 && e.number === 1) return; // a brand-new show comes from "new"
    if (e.number !== 1) return;
    add(week, { type: 'tv', tmdb: s.ids.tmdb, imdb: s.ids.imdb || null, title: s.title, year: s.year,
      date: localYmd(h.CFG.tz, Date.parse(x.first_aired)), time: localTime(h.CFG.tz, x.first_aired), service,
      label: e.season <= 1 ? 'New series' : 'Season ' + e.season, season: e.season, cert: s.certification || null, overview: s.overview || '' });
  });
}
function add(week, it) {
  if (!it.date || it.date < week.from || it.date > week.to) return;
  it.key = it.type + ':' + it.tmdb;
  if (week.items.some((x) => x.key === it.key)) return;
  it.state = 'pending';
  week.items.push(it);
}

// ------------------------------------------------------------------ details
async function fetchDetails(env, h, type, id, b) {
  const W = h.CFG.watch;
  const extra = type === 'movie' ? 'credits,external_ids,release_dates,watch/providers' : 'credits,external_ids,content_ratings,watch/providers';
  const t = await tmdb(env, b, '/' + type + '/' + id + '?append_to_response=' + extra);
  const imdb = (t.external_ids && t.external_ids.imdb_id) || t.imdb_id || null;
  const cert = (region) => {
    if (type === 'movie') {
      const r = ((t.release_dates || {}).results || []).find((x) => x.iso_3166_1 === region);
      const c = r && r.release_dates.map((d) => d.certification).filter(Boolean)[0];
      return c || null;
    }
    const r = ((t.content_ratings || {}).results || []).find((x) => x.iso_3166_1 === region);
    return (r && r.rating) || null;
  };
  const providers = (region) => ((((t['watch/providers'] || {}).results || {})[region] || {}).flatrate || []).map((p) => p.provider_name);
  const usService = providers(W.region).map((n) => serviceOf(n, W.services)).filter((s) => s && s !== 'hotstar')[0] || null;
  const inService = W.services.indexOf('hotstar') >= 0 && providers(W.hotstarRegion).some((n) => /hotstar/i.test(n)) ? 'hotstar' : null;
  const crew = (t.credits && t.credits.crew) || [];
  const d = {
    type, tmdb: id, imdb, title: t.title || t.name, year: String(t.release_date || t.first_air_date || '').slice(0, 4),
    overview: t.overview || '', genres: (t.genres || []).map((g) => g.name).slice(0, 4),
    runtime: t.runtime || (t.episode_run_time && t.episode_run_time[0]) || null,
    seasons: t.number_of_seasons || null, episodes: t.number_of_episodes || null,
    poster: t.poster_path || null, backdrop: t.backdrop_path || null, tmdbScore: t.vote_average ? Math.round(t.vote_average * 10) / 10 : null,
    certUS: cert('US'), certIN: cert(W.hotstarRegion),
    cast: ((t.credits && t.credits.cast) || []).slice(0, 6).map((c) => ({ name: c.name, as: c.character || '' })),
    by: type === 'movie' ? crew.filter((c) => c.job === 'Director').map((c) => c.name).slice(0, 2)
      : (t.created_by || []).map((c) => c.name).slice(0, 2),
    service: usService || inService, imdbRating: null, rt: null,
  };
  if (imdb && env.OMDB_API_KEY && b.left > 0) {
    try {
      const o = await getJson(b, OMDB + '?apikey=' + env.OMDB_API_KEY + '&i=' + imdb);
      if (o && o.imdbRating && o.imdbRating !== 'N/A') d.imdbRating = +o.imdbRating;
      const rt = o && (o.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes');
      if (rt) d.rt = rt.Value;
    } catch (e) { /* the rating is optional */ }
  }
  await h.putCache(env, 'watch:t:' + type + ':' + id, d, TITLE_TTL);
  return d;
}
async function cachedDetails(env, type, id) {
  const row = await env.DB.prepare('SELECT value, expires FROM cache WHERE key = ?').bind('watch:t:' + type + ':' + id).first();
  return row && row.expires > Date.now() ? JSON.parse(row.value) : null;
}
function merge(it, d) {
  it.poster = d.poster; it.imdbRating = d.imdbRating; it.tmdbScore = d.tmdbScore;
  if (!it.imdb) it.imdb = d.imdb;
  if (it.type === 'movie') it.service = d.service;
  if (!it.cert) it.cert = it.service === 'hotstar' ? (d.certIN || d.certUS) : (d.certUS || d.certIN);
  it.state = it.service ? 'ready' : 'dropped';
}

// ------------------------------------------------------------------ cron step
// Called from the 5-minute cron. Returns a short log line.
export async function stepWatch(env, h) {
  if (!watchConfigured(env)) return 'watch: not configured';
  const b = budget(MAX_FETCHES), tz = h.CFG.tz;
  let week = await readWeek(env);
  const today = localYmd(tz, Date.now());
  if (!week || week.from !== today || Date.now() - week.started > REBUILD_MS) {
    week = { started: Date.now(), from: today, to: localYmd(tz, Date.now() + (DAYS - 1) * 864e5), stage: 0, items: [], errors: [] };
  }
  if (week.stage < STAGES.length) {
    try { await fetchStage(env, h, STAGES[week.stage], week, b); } catch (e) { week.errors.push(STAGES[week.stage] + ': ' + e.message); }
    week.stage++;
    await writeWeek(env, h, week);
    return 'watch: stage ' + STAGES[week.stage - 1] + ', ' + week.items.length + ' titles';
  }
  let done = 0;
  for (const it of week.items) {
    if (it.state !== 'pending' || b.left < 3) continue;
    try {
      merge(it, (await cachedDetails(env, it.type, it.tmdb)) || (await fetchDetails(env, h, it.type, it.tmdb, b)));
      done++;
    } catch (e) { it.state = 'failed'; week.errors.push(it.key + ': ' + e.message); }
  }
  if (done) await writeWeek(env, h, week);
  return 'watch: ' + done + ' detailed, ' + week.items.filter((x) => x.state === 'pending').length + ' pending';
}

// ------------------------------------------------------------------ API
export async function watchWeek(env, h) {
  const W = h.CFG.watch, tz = h.CFG.tz;
  const base = { configured: watchConfigured(env), services: SERVICES.filter((s) => W.services.indexOf(s.id) >= 0).map((s) => ({ id: s.id, name: s.name, color: s.color })) };
  if (!base.configured) return Object.assign(base, { items: [], days: [], building: false });
  const week = await readWeek(env);
  const days = [];
  for (let i = 0; i < DAYS; i++) days.push(localYmd(tz, Date.now() + i * 864e5));
  if (!week) return Object.assign(base, { items: [], days, building: true });
  const items = week.items.filter((x) => x.state === 'ready' && days.indexOf(x.date) >= 0)
    .map((x) => ({ key: x.key, type: x.type, tmdb: x.tmdb, title: x.title, date: x.date, time: x.time, service: x.service, label: x.label,
      cert: x.cert, family: isFamily(x.cert), poster: x.poster, imdbRating: x.imdbRating || null, tmdbScore: x.tmdbScore || null }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (b.imdbRating || b.tmdbScore || 0) - (a.imdbRating || a.tmdbScore || 0)));
  return Object.assign(base, { items, days, building: week.stage < STAGES.length || week.items.some((x) => x.state === 'pending'), updated: week.started });
}

export async function watchTitle(env, h, type, id) {
  if (!watchConfigured(env)) return null;
  const d = (await cachedDetails(env, type, id)) || (await fetchDetails(env, h, type, id, budget(3)));
  const week = await readWeek(env);
  const it = week && week.items.find((x) => x.key === type + ':' + id);
  return Object.assign({}, d, it ? { date: it.date, time: it.time, label: it.label, service: it.service, cert: it.cert } : { cert: d.certUS || d.certIN },
    { family: isFamily(it ? it.cert : d.certUS) });
}

// For the assistant: compact lines.
export async function watchSummary(env, h, day, service) {
  const w = await watchWeek(env, h);
  if (!w.configured) return { error: 'The Watch list is not set up yet.' };
  return w.items.filter((x) => (!day || x.date === day) && (!service || x.service === service))
    .slice(0, 25).map((x) => x.date + ' · ' + SERVICES.find((s) => s.id === x.service).name + ' · ' + x.title + ' (' + x.label + (x.cert ? ', ' + x.cert : '') + (x.imdbRating ? ', IMDb ' + x.imdbRating : '') + ')');
}

// Posters, through the Worker: small sizes only, cached at the edge for a month.
export async function watchImage(size, path) {
  if (!/^(w185|w500)$/.test(size) || !/^\/[A-Za-z0-9_-]{6,64}\.(jpg|png)$/.test(path)) return new Response('bad image', { status: 400 });
  const src = 'https://image.tmdb.org/t/p/' + size + path, cache = caches.default, key = new Request(src);
  let res = await cache.match(key);
  if (!res) {
    const up = await fetch(src);
    if (!up.ok) return new Response('not found', { status: 404 });
    res = new Response(up.body, { headers: { 'content-type': up.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=2592000, immutable', 'x-content-type-options': 'nosniff' } });
    await cache.put(key, res.clone());
  }
  return res;
}
