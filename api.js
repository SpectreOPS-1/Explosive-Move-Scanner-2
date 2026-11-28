// Talks to the scanner-api Worker (Alpaca SIP data + Finnhub). The Worker holds the keys; the browser holds only an access code.
import { ProviderError } from './errors.js';

export function createApiProvider({ baseUrl, accessCode }) {
  const base = String(baseUrl).trim().replace(/\/+$/, '');

  async function get(path, params, signal) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, String(v));
    let resp;
    try {
      resp = await fetch(url, { headers: { 'X-Access-Code': accessCode }, signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ProviderError('Could not reach the scanner API. Check the URL, and that the Worker is deployed and allows this site (ALLOWED_ORIGIN).', 'network');
    }
    let body = null;
    try { body = await resp.json(); } catch { /* non-JSON error page */ }
    if (!resp.ok) {
      const code = resp.status === 401 || body?.code === 'alpaca_auth' ? 'auth' : resp.status === 429 ? 'rate' : 'http';
      throw new ProviderError(body?.error || `Scanner API error ${resp.status}.`, code);
    }
    return body;
  }

  return {
    id: 'api',
    name: 'Alpaca + Finnhub',
    live: true,
    batchSize: 5,

    /** Returns { snapshots: [...], meta } where a failed symbol is { symbol, error }. */
    async fetchBatch(symbols, { signal } = {}) {
      return get('/api/scan', { symbols: symbols.join(',') }, signal);
    },

    async fetchMovers({ list, top = 20, minPrice = 1, hideDerivatives = true }, { signal } = {}) {
      return get('/api/movers', { list, top, minPrice, hideDerivatives: hideDerivatives ? 1 : 0 }, signal);
    },

    /**
     * Stocks that set a 200-day low in the last `withinDays` days AND trade at `minRvol` or higher right now.
     * Starts from today's most active names + biggest movers, narrows by the 200-day-low test (cheap, daily bars),
     * then measures time-of-day RVOL only on the survivors.
     */
    async fetchLowRvol({ minRvol = 2, withinDays = 30, top = 20, minPrice = 1, hideDerivatives = true }, { signal, onProgress } = {}) {
      onProgress?.("Collecting today's most active names…");
      const uni = await get('/api/universe', { hideDerivatives: hideDerivatives ? 1 : 0 }, signal);
      const universe = uni.symbols || [];
      const hits = [];
      for (let i = 0; i < universe.length; i += 100) {
        onProgress?.(`Checking 200-day lows… ${Math.min(i + 100, universe.length)} of ${universe.length}`);
        const r = await get('/api/lows', { symbols: universe.slice(i, i + 100).join(','), within: withinDays, minPrice }, signal);
        hits.push(...r.hits);
      }
      // Most recent lows first; cap the RVOL stage so one click stays quick.
      hits.sort((a, b) => a.sessionsAgo - b.sessionsAgo || a.pctAboveLow - b.pctAboveLow);
      const CAP = 60;
      const candidates = hits.slice(0, CAP);
      const byLow = new Map(candidates.map((h) => [h.symbol, h]));
      const passed = [];
      for (let i = 0; i < candidates.length; i += 5) {
        onProgress?.(`Measuring relative volume… ${Math.min(i + 5, candidates.length)} of ${candidates.length}`);
        const { snapshots } = await get('/api/scan', { symbols: candidates.slice(i, i + 5).map((h) => h.symbol).join(',') }, signal);
        for (const sn of snapshots) {
          if (sn.error || !sn.rvol || sn.rvol.ratio < minRvol) continue;
          const low = byLow.get(sn.symbol);
          passed.push({
            symbol: sn.symbol, price: sn.price, changePct: sn.changePct, volume: null, trades: null,
            rvol: sn.rvol.ratio, lowDate: low.lastHitDate, lowSessionsAgo: low.sessionsAgo, pctAboveLow: low.pctAboveLow,
          });
        }
      }
      passed.sort((a, b) => b.rvol - a.rvol);
      return {
        list: 'lows', items: passed.slice(0, top), lastUpdated: uni.lastUpdated || null,
        filters: { minRvol, withinDays, minPrice, hideDerivatives, top },
        stats: { universe: universe.length, lowHits: hits.length, measured: candidates.length, passed: passed.length, capped: hits.length > CAP },
      };
    },

    /** Replays the last year of daily bars for a random sample of US stocks and counts outcomes after each setup. */
    async fetchBacktest({ sample = 300 } = {}, { signal, onProgress } = {}) {
      onProgress?.('Choosing a random sample of US-listed stocks…');
      const uni = await get('/api/bt/universe', { n: sample }, signal);
      const total = {};
      let used = 0, params = null;
      const chunk = 40;
      for (let i = 0; i < uni.symbols.length; i += chunk) {
        onProgress?.(`Replaying history… ${Math.min(i + chunk, uni.symbols.length)} of ${uni.symbols.length} stocks`);
        const r = await get('/api/bt/run', { symbols: uni.symbols.slice(i, i + chunk).join(',') }, signal);
        used += r.symbolsUsed;
        for (const [name, c] of Object.entries(r.cohorts)) {
          const t = total[name] || (total[name] = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? new Array(v.length).fill(0) : 0])));
          for (const [k, v] of Object.entries(c)) {
            if (Array.isArray(v)) v.forEach((x, j) => { t[k][j] += x; });
            else t[k] += v;
          }
        }
        params = r.params;
      }
      return { cohorts: total, symbolsUsed: used, symbolsRequested: uni.symbols.length, listed: uni.listed, params };
    },

    async fetchNews(symbol, { signal } = {}) {
      const d = await get('/api/news', { symbol }, signal);
      return d.items || [];
    },
  };
}

