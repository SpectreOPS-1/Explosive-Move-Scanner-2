// Demo data provider: deterministic, synthetic, clearly NOT market data.
// Same symbol -> same history every time, so the demo is repeatable.
import { isMarketOpen, etDateKey, relativeVolume } from './indicators.js';

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Hand-picked personalities so the demo shows a spread of results.
const PROFILES = {
  MARA: { kind: 'explosive', price: 17.4, shares: 280e6 },
  RIOT: { kind: 'explosive', price: 11.2, shares: 330e6 },
  SOFI: { kind: 'steady', price: 14.8, shares: 1.05e9 },
  PLTR: { kind: 'steady', price: 38.5, shares: 2.2e9 },
  AAPL: { kind: 'quiet', price: 212.4, shares: 15e9 },
  TSLA: { kind: 'volatile', price: 248.9, shares: 3.2e9 },
  NIO: { kind: 'fading', price: 5.1, shares: 2e9 },
  F: { kind: 'quiet', price: 11.9, shares: 3.9e9 },
  SNAP: { kind: 'fading', price: 9.3, shares: 1.6e9 },
  HOOD: { kind: 'steady', price: 27.6, shares: 880e6 },
  RIVN: { kind: 'volatile', price: 13.7, shares: 1e9 },
  LCID: { kind: 'explosive', price: 3.4, shares: 55e6 },
};
const KINDS = ['explosive', 'steady', 'quiet', 'volatile', 'fading'];

/** Most recent weekday key, skipping today while the session is still open (so the last bar is complete). */
function lastCompletedDay(now) {
  const d = new Date(now);
  if (isMarketOpen(now)) d.setUTCDate(d.getUTCDate() - 1);
  for (let i = 0; i < 7; i++) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(d);
    if (wd !== 'Sat' && wd !== 'Sun') break;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d;
}

function buildBars(symbol, now) {
  const profile = PROFILES[symbol] || (() => {
    const r = rng(hash(symbol));
    return { kind: KINDS[Math.floor(r() * KINDS.length)], price: 4 + r() * 90, shares: (20 + r() * 900) * 1e6 };
  })();
  const r = rng(hash(symbol) ^ 0x9e3779b9);
  const N = 130;
  const drift = { explosive: 0.0006, steady: 0.0008, quiet: 0.0002, volatile: 0, fading: -0.0012 }[profile.kind];
  const vol = { explosive: 0.02, steady: 0.014, quiet: 0.008, volatile: 0.03, fading: 0.016 }[profile.kind];
  const baseVolume = Math.max(400000, Math.min(60e6, profile.shares * 0.012));

  // Walk backwards from the target price so the series ends where the profile says.
  const rets = [];
  for (let i = 0; i < N - 1; i++) rets.push(drift + (r() - 0.5) * 2 * vol);
  if (profile.kind === 'explosive') { // the last ~8 sessions accelerate
    for (let i = 0; i < 8; i++) rets[N - 2 - i] = 0.012 + i * 0.0035 + (r() - 0.3) * 0.01;
  }
  const closes = [profile.price];
  for (let i = N - 2; i >= 0; i--) closes.unshift(closes[0] / (1 + rets[i]));

  const lastDay = lastCompletedDay(now);
  const bars = [];
  let day = new Date(lastDay);
  const days = [];
  while (days.length < N) { // collect N weekdays going back
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(day);
    if (wd !== 'Sat' && wd !== 'Sun') days.unshift(new Date(day));
    day.setUTCDate(day.getUTCDate() - 1);
  }
  for (let i = 0; i < N; i++) {
    const c = closes[i];
    const prev = closes[Math.max(0, i - 1)];
    let v = baseVolume * (0.6 + r() * 0.8);
    if (profile.kind === 'explosive' && i >= N - 4) v *= 1.8 + (i - (N - 4)) * 0.9; // volume surge into the move
    if (profile.kind === 'volatile' && i === N - 1) v *= 2.1;
    if (profile.kind === 'fading') v *= 0.8;
    const o = prev;
    bars.push({
      t: Math.floor(Date.UTC(days[i].getUTCFullYear(), days[i].getUTCMonth(), days[i].getUTCDate(), 21, 0, 0) / 1000),
      o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: Math.round(v),
    });
  }
  return { bars, profile };
}

export function createDemoProvider() {
  return {
    id: 'demo',
    name: 'Demo data',
    live: false,
    minIntervalMs: 60,
    async fetchSymbol(symbol) {
      const now = new Date();
      const { bars, profile } = buildBars(symbol, now);
      const last = bars[bars.length - 1];
      const prev = bars[bars.length - 2];
      return {
        symbol,
        name: `${symbol} (demo)`,
        price: Number(last.c.toFixed(2)),
        prevClose: prev.c,
        changePct: ((last.c - prev.c) / prev.c) * 100,
        bars,
        sharesOut: profile.shares,
        asOf: etDateKey(last.t),
        source: 'demo',
        problems: [],
      };
    },
    batchSize: 5,
    async fetchBatch(symbols) {
      return { snapshots: await Promise.all(symbols.map((x) => this.fetchSymbol(x))), meta: { demo: true } };
    },
    async fetchMovers({ list = 'gainers', top = 20, minPrice = 1 } = {}) {
      const rows = [];
      for (const symbol of Object.keys(PROFILES)) {
        const { bars } = buildBars(symbol, new Date());
        const last = bars[bars.length - 1], prev = bars[bars.length - 2];
        rows.push({ symbol, price: Number(last.c.toFixed(2)), changePct: ((last.c - prev.c) / prev.c) * 100, volume: last.v, trades: null });
      }
      const key = list === 'actives' ? (r) => r.volume : list === 'losers' ? (r) => -r.changePct : (r) => r.changePct;
      const items = rows.filter((r) => r.price >= minPrice).sort((a, b) => key(b) - key(a)).slice(0, top);
      return { list, items, lastUpdated: new Date().toISOString(), filters: { minPrice, hideDerivatives: true, top }, demo: true };
    },
    async fetchLowRvol({ minRvol = 2, top = 20, minPrice = 1 } = {}) {
      // Demo data has no long history, so the 200-day-low test cannot be shown; this lists demo names at the RVOL bar.
      const items = [];
      for (const symbol of Object.keys(PROFILES)) {
        const { bars } = buildBars(symbol, new Date());
        const last = bars[bars.length - 1], prev = bars[bars.length - 2];
        const rv = relativeVolume(bars, { timeAdjust: false });
        if (rv.ratio != null && rv.ratio >= minRvol && last.c >= minPrice) {
          items.push({ symbol, price: Number(last.c.toFixed(2)), changePct: ((last.c - prev.c) / prev.c) * 100, volume: null, trades: null, rvol: rv.ratio, lowDate: null, lowSessionsAgo: null, pctAboveLow: null });
        }
      }
      items.sort((a, b) => b.rvol - a.rvol);
      return { list: 'lows', items: items.slice(0, top), lastUpdated: new Date().toISOString(), filters: {}, demo: true, stats: { universe: Object.keys(PROFILES).length, lowHits: null, measured: null, passed: items.length } };
    },
    async fetchGainerLows(opts = {}) {
      const d = await this.fetchMovers({ ...opts, list: 'gainers' });
      return { ...d, list: 'gainerlows', stats: { gainers: d.items.length, lowHits: null } };
    },
    async fetchBacktest() {
      const err = new Error('The backtest needs live market history. Connect your Worker first (Data source box).');
      err.code = 'demo';
      throw err;
    },
    async fetchNews(symbol) {
      return [
        { headline: `Demo headline: ${symbol} volume picks up (not real news)`, url: `https://finance.yahoo.com/quote/${symbol}`, source: 'Demo', datetime: Math.floor(Date.now() / 1000) },
      ];
    },
  };
}

