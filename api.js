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

    async fetchNews(symbol, { signal } = {}) {
      const d = await get('/api/news', { symbol }, signal);
      return d.items || [];
    },
  };
}
