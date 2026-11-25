/**
 * scanner-api: Cloudflare Worker behind the Explosive Move Scanner.
 *
 * Why a Worker: it keeps your Alpaca and Finnhub keys on the server (never in the browser) and does the
 * heavy lifting for relative volume, so the app stays small and fast.
 *
 * Routes (all except /api/health need the header  X-Access-Code: <your ACCESS_CODE>)
 *   GET /api/health
 *   GET /api/scan?symbols=AAPL,TSLA,MARA        up to 5 symbols per call
 *   GET /api/movers?list=gainers|losers|actives&top=20&minPrice=1&hideDerivatives=1
 *   GET /api/news?symbol=AAPL
 *
 * Secrets / settings (Workers & Pages -> this Worker -> Settings -> Variables and Secrets):
 *   ALPACA_KEY_ID, ALPACA_SECRET   (secrets)  free Alpaca account -> API keys
 *   FINNHUB_KEY                    (secret, optional) share counts + news
 *   ACCESS_CODE                    (secret)  any long passphrase; the app asks for it once per tab
 *   ALLOWED_ORIGIN                 (text)    e.g. https://your-scanner.pages.dev   (defaults to *)
 *   CACHE                          (KV binding, optional) makes cold scans much faster; falls back to memory
 *
 * About the data (this matters for accuracy):
 *   The free Alpaca plan can read full-market SIP bars once they are more than 15 minutes old. Those bars are
 *   identical to the paid plan's, so volume is consolidated (not the small IEX-only slice). The price you get
 *   is therefore ~16 minutes behind. RVOL is "time of day" RVOL: volume since 4:00 AM ET compared with the average
 *   volume of the previous 20 sessions over the SAME clock window. No straight-line guess about the day's shape.
 *   Movers / most-actives come from Alpaca's screener and are real time.
 */

const ALPACA = 'https://data.alpaca.markets';
const FINNHUB = 'https://finnhub.io/api/v1';
const DELAY_MIN = 16;        // free-plan SIP must be >15 min old
const LOOKBACK_DAYS = 20;    // sessions in the RVOL baseline
const MIN_BASELINE_DAYS = 10;
const WINDOW_START = 240;    // 04:00 ET, in minutes after midnight
const WINDOW_END = 1200;     // 20:00 ET
const BIN = 5;
const BINS = (WINDOW_END - WINDOW_START) / BIN; // 192 five-minute bins
const MAX_SYMBOLS_PER_CALL = 5;

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'error'; }
}

// ---------------------------------------------------------------- time (US Eastern)

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function etParts(date) {
  const p = Object.fromEntries(etFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, dateKey: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

// Fast Eastern-time conversion for thousands of bars: one Intl call per UTC date, then plain arithmetic.
// (Trading bars never straddle a daylight-saving change, which happens while the market is closed.)
const offsetCache = new Map();
function etOffsetMs(utcDateKey) {
  let o = offsetCache.get(utcDateKey);
  if (o === undefined) {
    o = (etParts(new Date(`${utcDateKey}T12:00:00Z`)).minutes - 720) * 60000;
    offsetCache.set(utcDateKey, o);
  }
  return o;
}
function etFast(iso) {
  const shifted = new Date(Date.parse(iso) + etOffsetMs(iso.slice(0, 10)));
  return { dateKey: shifted.toISOString().slice(0, 10), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isWeekend(dateKey) {
  const wd = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
}
function lastWeekdayOnOrBefore(dateKey) {
  let k = dateKey;
  while (isWeekend(k)) k = addDays(k, -1);
  return k;
}

/**
 * Which session are we measuring, and how far into it (by the delayed clock)?
 * Before 4:00 AM ET, on weekends: the last weekday, full day. Holidays are handled by the caller stepping back.
 */
function resolveSession(now) {
  const delayed = new Date(now.getTime() - DELAY_MIN * 60000);
  const p = etParts(delayed);
  if (isWeekend(p.dateKey)) return { key: lastWeekdayOnOrBefore(p.dateKey), cutoffMin: WINDOW_END, delayed };
  if (p.minutes < WINDOW_START) return { key: lastWeekdayOnOrBefore(addDays(p.dateKey, -1)), cutoffMin: WINDOW_END, delayed };
  return { key: p.dateKey, cutoffMin: Math.min(p.minutes, WINDOW_END), delayed };
}
const binsFor = (cutoffMin) => Math.max(0, Math.min(BINS, Math.floor((cutoffMin - WINDOW_START) / BIN)));

// ---------------------------------------------------------------- volume profile + RVOL (pure)

/** dateKey -> 192 five-minute volume bins (04:00-20:00 ET) */
function dayBins(bars) {
  const days = new Map();
  for (const b of bars) {
    const { dateKey, minutes } = etFast(b.t);
    if (minutes < WINDOW_START || minutes >= WINDOW_END) continue;
    let arr = days.get(dateKey);
    if (!arr) { arr = new Array(BINS).fill(0); days.set(dateKey, arr); }
    arr[Math.floor((minutes - WINDOW_START) / BIN)] += b.v;
  }
  return days;
}

/** Average cumulative volume by time of day over the previous sessions (never includes the session itself). */
function buildProfile(bars5, sessionKey) {
  const days = dayBins(bars5);
  const keys = [...days.keys()].filter((k) => k < sessionKey).sort().slice(-LOOKBACK_DAYS);
  const cum = new Array(BINS).fill(0);
  for (const k of keys) {
    let run = 0;
    const arr = days.get(k);
    for (let i = 0; i < BINS; i++) { run += arr[i]; cum[i] += run; }
  }
  return { days: keys.length, cum: keys.length ? cum.map((v) => v / keys.length) : [] };
}

function volumeSoFar(bars5, sessionKey, nBins) {
  const arr = dayBins(bars5).get(sessionKey);
  if (!arr) return 0;
  let s = 0;
  for (let i = 0; i < nBins; i++) s += arr[i];
  return s;
}

function timeOfDayRvol(profile, today, nBins) {
  if (nBins <= 0 || !profile || profile.days < MIN_BASELINE_DAYS) return null;
  const baseline = profile.cum[nBins - 1];
  if (!baseline) return null;
  return { ratio: today / baseline, today, baseline, days: profile.days, mode: 'time-of-day' };
}

// ---------------------------------------------------------------- cache (KV if bound, else this isolate's memory)

const memCache = new Map();
async function cacheGet(env, key) {
  if (env.CACHE) { try { return await env.CACHE.get(key, 'json'); } catch { return null; } }
  const hit = memCache.get(key);
  return hit && hit.exp > Date.now() ? hit.v : null;
}
async function cachePut(env, key, value, ttlSec) {
  if (env.CACHE) { try { await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSec) }); } catch { /* cache is best-effort */ } return; }
  memCache.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
}

// ---------------------------------------------------------------- Alpaca

async function alpacaGet(env, path, params) {
  if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET) throw new HttpError(500, 'Alpaca keys are not set on the Worker.', 'config');
  const url = new URL(ALPACA + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  let resp;
  try {
    resp = await fetch(url, { headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET, Accept: 'application/json' } });
  } catch {
    throw new HttpError(502, 'Could not reach Alpaca.', 'upstream');
  }
  if (resp.status === 401) throw new HttpError(502, 'Alpaca rejected the API keys. Check ALPACA_KEY_ID and ALPACA_SECRET.', 'alpaca_auth');
  if (resp.status === 403) throw new HttpError(502, 'Alpaca says this data is not available to your account.', 'alpaca_forbidden');
  if (resp.status === 429) throw new HttpError(429, 'Alpaca rate limit reached. Wait a minute and try again.', 'rate');
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).message || ''; } catch { /* ignore */ }
    throw new HttpError(502, `Alpaca error ${resp.status}${detail ? `: ${detail}` : ''}`, 'upstream');
  }
  return resp.json();
}

/** Multi-symbol bars with pagination. The limit applies to the total across symbols, so follow next_page_token. */
async function alpacaBars(env, symbols, { timeframe, start, end }) {
  const out = {};
  let token = null;
  for (let page = 0; page < 15; page++) {
    const data = await alpacaGet(env, '/v2/stocks/bars', {
      symbols: symbols.join(','), timeframe, start, end, limit: 10000, adjustment: 'split', feed: 'sip', sort: 'asc', page_token: token,
    });
    for (const [sym, arr] of Object.entries(data.bars || {})) (out[sym] = out[sym] || []).push(...arr);
    token = data.next_page_token;
    if (!token) break;
  }
  return out;
}

// ---------------------------------------------------------------- Finnhub (share count + news)

async function finnhubGet(env, path, params) {
  const url = new URL(FINNHUB + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('token', env.FINNHUB_KEY);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`finnhub ${resp.status}`);
  return resp.json();
}

async function getProfile(env, symbol) {
  const key = `fh:profile:${symbol}`;
  const cached = await cacheGet(env, key);
  if (cached) return cached;
  if (!env.FINNHUB_KEY) return { name: symbol, sharesOut: null, problem: 'Finnhub key not set on the Worker, so share count is unavailable.' };
  try {
    const p = await finnhubGet(env, '/stock/profile2', { symbol });
    const out = { name: p?.name || symbol, sharesOut: typeof p?.shareOutstanding === 'number' && p.shareOutstanding > 0 ? p.shareOutstanding * 1e6 : null };
    await cachePut(env, key, out, 7 * 86400);
    return out;
  } catch {
    return { name: symbol, sharesOut: null, problem: 'Share count lookup failed.' };
  }
}

// ---------------------------------------------------------------- scan

async function scanSymbols(env, symbols, now) {
  let session = resolveSession(now);
  const delayedIso = session.delayed.toISOString();
  const endFor = (key) => {
    const dayEnd = new Date(`${addDays(key, 1)}T08:00:00Z`);
    return (dayEnd < session.delayed ? dayEnd : session.delayed).toISOString();
  };

  // 1) Today's (session's) 5-minute bars. If nothing traded (holiday), step back to the previous weekday.
  let todayBars = {};
  let found = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    todayBars = await alpacaBars(env, symbols, { timeframe: '5Min', start: `${session.key}T08:00:00Z`, end: endFor(session.key) });
    if (Object.values(todayBars).some((a) => a.length)) { found = true; break; }
    session = { key: lastWeekdayOnOrBefore(addDays(session.key, -1)), cutoffMin: WINDOW_END, delayed: session.delayed };
  }
  if (!found) throw new HttpError(502, 'Alpaca returned no recent trades for these symbols. Check the tickers.', 'no_data');
  const nBins = binsFor(session.cutoffMin);

  // 2) Per-symbol baseline profile (cached for the session day) and completed daily bars (cached).
  const profiles = {}, dailies = {};
  const needProfile = [], needDaily = [];
  for (const s of symbols) {
    profiles[s] = await cacheGet(env, `sc:prof:${s}:${session.key}`);
    dailies[s] = await cacheGet(env, `sc:daily:${s}:${session.key}`);
    if (!profiles[s]) needProfile.push(s);
    if (!dailies[s]) needDaily.push(s);
  }
  if (needProfile.length) {
    const hist = await alpacaBars(env, needProfile, { timeframe: '5Min', start: `${addDays(session.key, -32)}T00:00:00Z`, end: endFor(session.key) });
    for (const s of needProfile) {
      profiles[s] = buildProfile(hist[s] || [], session.key);
      await cachePut(env, `sc:prof:${s}:${session.key}`, profiles[s], 20 * 3600);
    }
  }
  if (needDaily.length) {
    const d = await alpacaBars(env, needDaily, { timeframe: '1Day', start: `${addDays(session.key, -210)}T00:00:00Z`, end: delayedIso });
    for (const s of needDaily) {
      dailies[s] = (d[s] || []).filter((b) => b.t.slice(0, 10) < session.key).slice(-130).map((b) => ({ t: b.t, c: b.c, v: b.v }));
      await cachePut(env, `sc:daily:${s}:${session.key}`, dailies[s], 20 * 3600);
    }
  }

  // 3) Compose one snapshot per symbol.
  const snapshots = [];
  for (const s of symbols) {
    const problems = [];
    const bars5 = (todayBars[s] || []).filter((b) => { const e = etFast(b.t); return e.dateKey === session.key && e.minutes >= WINDOW_START && e.minutes < session.cutoffMin; });
    const profileInfo = await getProfile(env, s);
    if (profileInfo.problem) problems.push(profileInfo.problem);
    if (!bars5.length) {
      snapshots.push({ symbol: s, error: `No trades found for ${s} in this session. Check the ticker.` });
      continue;
    }
    const last = bars5[bars5.length - 1];
    const daily = dailies[s] || [];
    const prevClose = daily.length ? daily[daily.length - 1].c : null;
    if (!daily.length) problems.push('No daily history, so PMO is unavailable.');
    const volToday = volumeSoFar(bars5, session.key, nBins);
    const rvol = timeOfDayRvol(profiles[s], volToday, nBins);
    if (!rvol) problems.push(`Not enough history for relative volume (needs ${MIN_BASELINE_DAYS}+ prior sessions with trades).`);
    snapshots.push({
      symbol: s,
      name: profileInfo.name,
      price: last.c,
      prevClose,
      changePct: prevClose ? ((last.c - prevClose) / prevClose) * 100 : null,
      bars: [...daily, { t: last.t, c: last.c, v: volToday }],
      rvol,
      sharesOut: profileInfo.sharesOut,
      asOf: new Date(Math.min(Date.parse(last.t) + BIN * 60000, session.delayed.getTime())).toISOString(),
      source: 'alpaca-sip-delayed',
      problems,
    });
  }
  return { snapshots, meta: { session: session.key, cutoffMin: session.cutoffMin, delayMin: DELAY_MIN, windowStartMin: WINDOW_START } };
}

// ---------------------------------------------------------------- movers / most active

// Warrants, rights and units are almost never what you want in a scan. Guessed from the ticker shape.
const isDerivative = (sym) => /^[A-Z]{4}(W|R|U)$/.test(sym) || /[.\-](W|WS|WT|R|RT|U)$/.test(sym);

async function getMovers(env, { list, top, minPrice, hideDerivatives }) {
  const cacheKey = `mv:${list}:${top}:${minPrice}:${hideDerivatives}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) return cached;

  let items = [], lastUpdated = null;
  if (list === 'actives') {
    const data = await alpacaGet(env, '/v1beta1/screener/stocks/most-actives', { by: 'volume', top: 100 });
    lastUpdated = data.last_updated || null;
    const base = (data.most_actives || []).filter((m) => !hideDerivatives || !isDerivative(m.symbol));
    const snaps = {};
    for (let i = 0; i < base.length; i += 100) {
      const chunk = base.slice(i, i + 100).map((m) => m.symbol);
      const raw = await alpacaGet(env, '/v2/stocks/snapshots', { symbols: chunk.join(','), feed: 'iex' });
      Object.assign(snaps, raw.snapshots || raw);
    }
    items = base.map((m) => {
      const sn = snaps[m.symbol] || {};
      const price = sn.latestTrade?.p ?? sn.dailyBar?.c ?? null;
      const prev = sn.prevDailyBar?.c ?? null;
      return { symbol: m.symbol, price, changePct: price != null && prev ? ((price - prev) / prev) * 100 : null, volume: m.volume ?? null, trades: m.trade_count ?? null };
    });
  } else {
    const data = await alpacaGet(env, '/v1beta1/screener/stocks/movers', { top: 50 });
    lastUpdated = data.last_updated || null;
    items = (data[list] || [])
      .filter((m) => !hideDerivatives || !isDerivative(m.symbol))
      .map((m) => ({ symbol: m.symbol, price: m.price ?? null, changePct: m.percent_change ?? null, volume: null, trades: null }));
  }
  // A name whose price we could not confirm is dropped whenever a minimum price is set.
  items = items.filter((m) => (m.price != null ? m.price >= minPrice : minPrice === 0)).slice(0, top);
  const out = { list, items, lastUpdated, filters: { minPrice, hideDerivatives, top } };
  await cachePut(env, cacheKey, out, 60);
  return out;
}

// ---------------------------------------------------------------- HTTP

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Access-Code, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health') {
        return json({ ok: true, alpaca: !!(env.ALPACA_KEY_ID && env.ALPACA_SECRET), finnhub: !!env.FINNHUB_KEY, accessCode: !!env.ACCESS_CODE, kv: !!env.CACHE });
      }
      if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
      if (!env.ACCESS_CODE) throw new HttpError(500, 'ACCESS_CODE is not set on the Worker.', 'config');
      if (!timingSafeEqual(request.headers.get('X-Access-Code') || '', env.ACCESS_CODE)) throw new HttpError(401, 'Wrong or missing access code.', 'auth');

      const now = env.TEST_NOW ? new Date(env.TEST_NOW) : new Date(); // TEST_NOW is only ever set by the test suite

      if (url.pathname === '/api/scan') {
        const symbols = [...new Set((url.searchParams.get('symbols') || '').toUpperCase().split(/[\s,]+/).filter(Boolean))];
        if (!symbols.length) throw new HttpError(400, 'No symbols given.');
        if (symbols.length > MAX_SYMBOLS_PER_CALL) throw new HttpError(400, `At most ${MAX_SYMBOLS_PER_CALL} symbols per call.`);
        if (symbols.some((s) => !SYMBOL_RE.test(s))) throw new HttpError(400, 'One of the tickers is not valid.');
        return json(await scanSymbols(env, symbols, now));
      }

      if (url.pathname === '/api/movers') {
        const list = url.searchParams.get('list') || 'gainers';
        if (!['gainers', 'losers', 'actives'].includes(list)) throw new HttpError(400, 'list must be gainers, losers or actives.');
        const top = Math.min(20, Math.max(1, parseInt(url.searchParams.get('top') || '20', 10) || 20));
        const mp = Number(url.searchParams.get('minPrice') ?? 1);
        const minPrice = Number.isFinite(mp) && mp >= 0 ? mp : 1;
        const hideDerivatives = url.searchParams.get('hideDerivatives') !== '0';
        return json(await getMovers(env, { list, top, minPrice, hideDerivatives }));
      }

      if (url.pathname === '/api/news') {
        const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
        if (!SYMBOL_RE.test(symbol)) throw new HttpError(400, 'Invalid ticker.');
        if (!env.FINNHUB_KEY) return json({ items: [], note: 'Finnhub key not set on the Worker, so news is unavailable.' });
        const key = `news:${symbol}`;
        let items = await cacheGet(env, key);
        if (!items) {
          const iso = (d) => d.toISOString().slice(0, 10);
          const raw = await finnhubGet(env, '/company-news', { symbol, from: iso(new Date(now.getTime() - 5 * 86400000)), to: iso(now) });
          items = (Array.isArray(raw) ? raw : []).slice(0, 5).map((n) => ({ headline: n.headline, url: n.url, source: n.source, datetime: n.datetime }));
          await cachePut(env, key, items, 600);
        }
        return json({ items });
      }

      throw new HttpError(404, 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      return json({ error: 'Unexpected error in the scanner API.', code: 'internal' }, 500);
    }
  },
};
