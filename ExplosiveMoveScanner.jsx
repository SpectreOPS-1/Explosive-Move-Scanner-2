import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshCw, ExternalLink, Info, ChevronDown, ChevronRight, Download, Square,
  AlertTriangle, ArrowUp, ArrowDown, Eye, EyeOff, Flame, Plus, Replace,
} from 'lucide-react';
import { createProvider } from './index.js';
import { analyze, applyFilters, parseSymbols, toCsv, MAX_SYMBOLS } from './scan.js';
import { isMarketOpen } from './indicators.js';

const DEFAULT_WATCHLIST = 'MARA, RIOT, SOFI, PLTR, AAPL, TSLA, NIO, F, SNAP, HOOD, RIVN, LCID';
const DEFAULT_FILTERS = { maxPrice: '', minRvol: '', minPmo: '', minScore: '', pmoRisingOnly: false, greenOnly: false };
const PRESETS = [
  { label: 'Explosive setup', filters: { ...DEFAULT_FILTERS, minRvol: '2', minPmo: '0', minScore: '70', pmoRisingOnly: true } },
  { label: 'Cheap movers', filters: { ...DEFAULT_FILTERS, maxPrice: '20', minRvol: '1.5', greenOnly: true } },
  { label: 'Clear filters', filters: DEFAULT_FILTERS },
];

// ---- small safe-storage helpers (storage can be blocked: the app must still work) ----
const read = (store, key, fallback) => {
  try { const v = window[store].getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
};
const write = (store, key, value) => { try { window[store].setItem(key, JSON.stringify(value)); } catch { /* ignore */ } };

// ---- formatting ----
const fmtPrice = (v) => (v == null ? '—' : `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`);
const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtShares = (v) => (v == null ? '—' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : `${(v / 1e6).toFixed(1)}M`);
const fmtVolume = (v) => (v == null ? '—' : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(v));

function Sparkline({ values }) {
  if (!values || values.length < 2) return <span className="text-slate-600">—</span>;
  const w = 90, h = 26;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Last ${values.length} closes, ${up ? 'rising' : 'falling'}`}>
      <polyline fill="none" stroke={up ? '#34d399' : '#f87171'} strokeWidth="1.6" points={pts} />
    </svg>
  );
}

function ScoreCell({ row }) {
  if (row.score == null) return <span className="text-slate-500">n/a</span>;
  const tone = row.score >= 70 ? 'bg-emerald-500' : row.score >= 40 ? 'bg-amber-500' : 'bg-slate-500';
  return (
    <div className="flex items-center gap-2" title={row.partial ? 'Partial score: some inputs were unavailable' : undefined}>
      <div className="w-16 h-2 rounded bg-slate-700 overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${row.score}%` }} /></div>
      <span className="tabular-nums w-10">{row.partial ? '~' : ''}{row.score}</span>
    </div>
  );
}

function SortHeader({ label, k, sort, setSort, className = '' }) {
  const active = sort.key === k;
  return (
    <th className={`px-3 py-2 text-left font-semibold ${className}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-white" onClick={() => setSort({ key: k, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}>
        {label}{active && (sort.dir === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}
      </button>
    </th>
  );
}

export default function ExplosiveMoveScanner() {
  const [apiUrl, setApiUrl] = useState(() => read('localStorage', 'ems.apiUrl', ''));
  const [accessCode, setAccessCode] = useState(() => read('sessionStorage', 'ems.code', ''));
  const [movers, setMovers] = useState({ list: 'gainers', minPrice: '1', minRvol: '2', hideDerivatives: true, loading: false, error: null, data: null, progress: '' });
  const [showKey, setShowKey] = useState(false);
  const [watchlist, setWatchlist] = useState(() => read('localStorage', 'ems.watchlist', DEFAULT_WATCHLIST));
  const [filters, setFilters] = useState(() => ({ ...DEFAULT_FILTERS, ...read('localStorage', 'ems.filters', {}) }));
  const timeAdjust = true; // demo-data fallback only; live RVOL is always time-of-day
  const [snaps, setSnaps] = useState([]);
  const [errors, setErrors] = useState([]);
  const [fatal, setFatal] = useState(null);
  const [notice, setNotice] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [lastScan, setLastScan] = useState(null);
  const [sort, setSort] = useState({ key: 'score', dir: 'desc' });
  const [expanded, setExpanded] = useState(null);
  const [news, setNews] = useState({});
  const abortRef = useRef(null);

  const provider = useMemo(() => createProvider({ apiUrl, accessCode }), [apiUrl, accessCode]);
  const live = provider.live;

  useEffect(() => write('localStorage', 'ems.apiUrl', apiUrl), [apiUrl]);
  useEffect(() => write('sessionStorage', 'ems.code', accessCode), [accessCode]);
  useEffect(() => write('localStorage', 'ems.watchlist', watchlist), [watchlist]);
  useEffect(() => write('localStorage', 'ems.filters', filters), [filters]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Results are derived, so filters, sorting and the RVOL toggle respond instantly with no new API calls.
  const rows = useMemo(() => snaps.map((s) => analyze(s, { timeAdjust })), [snaps]);
  const { kept, unknown } = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const sorted = useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const val = (r) => (sort.key === 'symbol' ? r.symbol : r[sort.key]);
    return [...kept].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;   // unknowns always sink to the bottom
      if (y == null) return -1;
      return (x > y ? 1 : x < y ? -1 : 0) * dir;
    });
  }, [kept, sort]);

  const problemSummary = useMemo(() => {
    const counts = new Map();
    rows.forEach((r) => r.problems.forEach((p) => counts.set(p, (counts.get(p) || 0) + 1)));
    return [...counts.entries()];
  }, [rows]);

  const runScan = useCallback(async () => {
    const { valid, rejected } = parseSymbols(watchlist);
    setFatal(null); setNotice(null);
    if (!valid.length) { setFatal('Add at least one ticker to the watchlist first.'); return; }
    const list = valid.slice(0, MAX_SYMBOLS);
    const notes = [];
    if (valid.length > MAX_SYMBOLS) notes.push(`Only the first ${MAX_SYMBOLS} tickers are scanned.`);
    if (rejected.length) notes.push(`Skipped invalid tickers: ${rejected.join(', ')}.`);
    if (notes.length) setNotice(notes.join(' '));

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScanning(true); setSnaps([]); setErrors([]); setExpanded(null);
    setProgress({ done: 0, total: list.length });

    const got = [], errs = [];
    const size = provider.batchSize || 5;
    try {
      for (let i = 0; i < list.length; i += size) {
        if (ctrl.signal.aborted) break;
        const chunk = list.slice(i, i + size);
        try {
          const { snapshots } = await provider.fetchBatch(chunk, { signal: ctrl.signal });
          for (const sn of snapshots) {
            if (sn.error) errs.push({ symbol: sn.symbol, message: sn.error });
            else got.push(sn);
          }
          setSnaps([...got]); setErrors([...errs]);
        } catch (e) {
          if (e.name === 'AbortError') break;
          if (['auth', 'network', 'rate'].includes(e.code)) { setFatal(e.message); break; }
          chunk.forEach((sym) => errs.push({ symbol: sym, message: e.message })); setErrors([...errs]);
        }
        setProgress((p) => ({ ...p, done: Math.min(p.total, p.done + chunk.length) }));
      }
    } finally {
      if (abortRef.current === ctrl) { setScanning(false); setLastScan(new Date()); }
    }
  }, [watchlist, provider]);

  const stopScan = () => abortRef.current?.abort();

  const loadMovers = async (patch = {}) => {
    const m = { ...movers, ...patch };
    setMovers({ ...m, loading: true, error: null });
    try {
      const mp = Number(m.minPrice);
      const minPrice = Number.isFinite(mp) && m.minPrice !== '' ? mp : 1;
      let data;
      if (m.list === 'lows') {
        const rv = Number(m.minRvol);
        data = await provider.fetchLowRvol(
          { minRvol: Number.isFinite(rv) && m.minRvol !== '' ? rv : 2, withinDays: 30, top: 20, minPrice, hideDerivatives: m.hideDerivatives },
          { onProgress: (progress) => setMovers((cur) => ({ ...cur, progress })) },
        );
      } else {
        data = await provider.fetchMovers({ list: m.list, top: 20, minPrice, hideDerivatives: m.hideDerivatives });
      }
      setMovers({ ...m, loading: false, error: null, data, progress: '' });
    } catch (e) {
      setMovers({ ...m, loading: false, error: e.message, progress: '' });
    }
  };
  const moverSymbols = movers.data?.items?.map((i) => i.symbol) || [];
  const useMovers = (mode) => {
    const current = parseSymbols(watchlist).valid;
    const merged = mode === 'replace' ? moverSymbols : [...new Set([...current, ...moverSymbols])];
    const capped = merged.slice(0, MAX_SYMBOLS);
    setWatchlist(capped.join(', '));
    setNotice(merged.length > MAX_SYMBOLS ? `Watchlist holds ${MAX_SYMBOLS} tickers at most; extra movers were left out.` : null);
  };

  // Fetch headlines only when a row is opened.
  useEffect(() => {
    if (!expanded || news[expanded]) return;
    let cancelled = false;
    setNews((n) => ({ ...n, [expanded]: { loading: true } }));
    provider.fetchNews(expanded).then(
      (items) => !cancelled && setNews((n) => ({ ...n, [expanded]: { items } })),
      (e) => !cancelled && setNews((n) => ({ ...n, [expanded]: { error: e.message } })),
    );
    return () => { cancelled = true; };
  }, [expanded, provider]); // eslint-disable-line react-hooks/exhaustive-deps

  const downloadCsv = () => {
    const blob = new Blob([toCsv(sorted)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scan-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const inputCls = 'w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-600 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <header>
          <h1 className="text-3xl font-bold">Explosive Move Scanner</h1>
          <p className="text-slate-400">Momentum (PMO 13/8/5), relative volume and a small share count, scored 0 to 100.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className={`px-2 py-0.5 rounded-full font-semibold ${live ? 'bg-emerald-900 text-emerald-300' : 'bg-amber-900 text-amber-200'}`}>
              {live ? 'LIVE · Alpaca + Finnhub (about 16 min delayed)' : 'DEMO · synthetic data, not real prices'}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300">US market {isMarketOpen() ? 'open' : 'closed'}</span>
            <span className="flex items-center gap-1 text-slate-400"><Info className="w-4 h-4" />
              {rows.length} scanned · {sorted.length} shown{unknown ? ` · ${unknown} hidden (missing data)` : ''}{lastScan ? ` · last scan ${lastScan.toLocaleTimeString()}` : ''}
            </span>
          </div>
        </header>

        {fatal && <div role="alert" className="flex gap-2 rounded border border-red-700 bg-red-950 px-4 py-3 text-red-200"><AlertTriangle className="w-5 h-5 shrink-0" />{fatal}</div>}
        {notice && <div className="rounded border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-slate-300">{notice}</div>}
        {problemSummary.map(([msg, n]) => (
          <div key={msg} className="flex gap-2 rounded border border-amber-700 bg-amber-950 px-4 py-2 text-sm text-amber-200">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /><span>{msg} <span className="text-amber-400">({n} symbol{n > 1 ? 's' : ''}; shown as — and left out of the score)</span></span>
          </div>
        ))}

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Data source</h2>
            <label className="block text-sm text-slate-400" htmlFor="url">Scanner API URL (leave empty for demo mode)</label>
            <input id="url" type="url" autoComplete="off" spellCheck="false" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="https://scanner-api.your-name.workers.dev" className={inputCls} />
            <label className="block text-sm text-slate-400" htmlFor="code">Access code</label>
            <div className="flex gap-2">
              <input id="code" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck="false" value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="The ACCESS_CODE you set on the Worker" className={inputCls} />
              <button type="button" onClick={() => setShowKey((x) => !x)} className="px-3 rounded bg-slate-800 border border-slate-600" aria-label={showKey ? 'Hide code' : 'Show code'}>{showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
            </div>
            <p className="text-xs text-slate-500">Your Alpaca and Finnhub keys live only on the Worker, never in this page. The access code is kept for this tab only.</p>
            <p className="text-xs text-slate-500">RVOL = volume since 4:00 AM ET ÷ the average of the same clock window over the previous 20 sessions, using full-market data, so there is no time-of-day distortion and no partial-exchange noise.</p>
          </div>

          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Watchlist</h2>
            <label className="block text-sm text-slate-400" htmlFor="wl">Tickers to scan, separated by commas, spaces or new lines (max {MAX_SYMBOLS})</label>
            <textarea id="wl" rows={3} value={watchlist} onChange={(e) => setWatchlist(e.target.value)} className={inputCls + ' font-mono text-sm'} />
          </div>
        </section>

        <section className="space-y-3" aria-labelledby="movers-h">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="movers-h" className="text-lg font-semibold mr-2 flex items-center gap-2"><Flame className="w-5 h-5 text-orange-400" />Today's top movers</h2>
            {[['gainers', 'Top gainers'], ['actives', 'Most active'], ['lows', '200-day lows + RVOL']].map(([k, label]) => (
              <button key={k} type="button" aria-pressed={movers.list === k} onClick={() => loadMovers({ list: k })} className={`px-3 py-1 text-sm rounded-full border ${movers.list === k ? 'bg-blue-600 border-blue-500' : 'bg-slate-800 border-slate-600 hover:border-blue-500'}`}>{label}</button>
            ))}
            <button type="button" onClick={() => loadMovers()} disabled={movers.loading} className="px-3 py-1 text-sm rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 flex items-center gap-1"><RefreshCw className={`w-3.5 h-3.5 ${movers.loading ? 'animate-spin' : ''}`} />{movers.data ? 'Refresh' : 'Fetch top 20'}</button>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-slate-300">
            <label className="flex items-center gap-2">Min price ($)
              <input type="number" step="any" inputMode="decimal" value={movers.minPrice} onChange={(e) => setMovers((m) => ({ ...m, minPrice: e.target.value }))} className={inputCls + ' !w-20'} />
            </label>
            {movers.list === 'lows' && (
              <label className="flex items-center gap-2">RVOL at least (x)
                <input type="number" step="any" inputMode="decimal" value={movers.minRvol} onChange={(e) => setMovers((m) => ({ ...m, minRvol: e.target.value }))} className={inputCls + ' !w-20'} />
              </label>
            )}
            <label className="flex items-center gap-2"><input type="checkbox" checked={movers.hideDerivatives} onChange={(e) => setMovers((m) => ({ ...m, hideDerivatives: e.target.checked }))} />Hide warrants, rights and units</label>
            <span className="text-xs text-slate-500">Press Refresh after changing these.</span>
          </div>
          {movers.error && <div role="alert" className="flex gap-2 rounded border border-red-700 bg-red-950 px-4 py-2 text-sm text-red-200"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{movers.error}</div>}
          {movers.loading && movers.progress && <p role="status" aria-live="polite" className="text-sm text-slate-300">{movers.progress}</p>}
          {movers.list === 'lows' && movers.data?.list === 'lows' && !movers.loading && (
            <p className="text-xs text-slate-400">
              {movers.data.demo
                ? 'Demo mode: the 200-day-low test needs live data, so this just lists demo names above the RVOL bar.'
                : `Checked ${movers.data.stats.universe} active names · ${movers.data.stats.lowHits} set a 200-day low in the last 30 days · ${movers.data.stats.passed} also have RVOL of ${movers.data.filters.minRvol}x or more${movers.data.stats.capped ? ' (RVOL was measured on the 60 freshest lows only)' : ''}.`}
            </p>
          )}
          {movers.data && !movers.data.items.length && !movers.loading && <p className="text-sm text-slate-400">{movers.data.list === 'lows' ? 'No stocks meet both tests right now. That is a normal result, not an error.' : 'No movers match these filters right now.'}</p>}
          {movers.data?.items?.length > 0 && (
            <>
              <ul className="flex flex-wrap gap-2" aria-label="Fetched movers">
                {movers.data.items.map((i) => (
                  <li key={i.symbol} className="px-2.5 py-1 rounded bg-slate-800 border border-slate-700 text-sm">
                    <span className="font-semibold">{i.symbol}</span>{' '}
                    <span className="text-slate-400 tabular-nums">{fmtPrice(i.price)}</span>{' '}
                    <span className={`tabular-nums ${i.changePct == null ? 'text-slate-500' : i.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(i.changePct)}</span>
                    {i.volume != null && <span className="text-slate-500"> · {fmtVolume(i.volume)}</span>}
                    {i.rvol != null && <span className="text-emerald-300 tabular-nums"> · {i.rvol.toFixed(1)}x RVOL</span>}
                    {i.lowSessionsAgo != null && <span className="text-slate-500"> · low {i.lowSessionsAgo === 0 ? 'today' : `${i.lowSessionsAgo} sessions ago`}</span>}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => useMovers('replace')} className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 flex items-center gap-1.5"><Replace className="w-4 h-4" />Replace watchlist</button>
                <button type="button" onClick={() => useMovers('add')} className="px-3 py-1.5 text-sm rounded bg-slate-700 hover:bg-slate-600 flex items-center gap-1.5"><Plus className="w-4 h-4" />Add to watchlist</button>
                <button type="button" onClick={() => { useMovers('replace'); setTimeout(() => document.getElementById('scan-btn')?.click(), 0); }} className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 flex items-center gap-1.5"><RefreshCw className="w-4 h-4" />Scan these now</button>
                <span className="text-xs text-slate-500">{movers.data.demo ? 'Demo list' : 'Live list'}{movers.data.lastUpdated ? ` · updated ${new Date(movers.data.lastUpdated).toLocaleTimeString()}` : ''}</span>
              </div>
            </>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold mr-2">Filters</h2>
            {PRESETS.map((p) => <button key={p.label} type="button" onClick={() => setFilters(p.filters)} className="px-3 py-1 text-sm rounded-full bg-slate-800 border border-slate-600 hover:border-blue-500">{p.label}</button>)}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[['maxPrice', 'Max price ($)'], ['minRvol', 'Min RVOL (x)'], ['minPmo', 'Min PMO'], ['minScore', 'Min score']].map(([k, label]) => (
              <label key={k} className="text-sm text-slate-400">{label}
                <input type="number" step="any" inputMode="decimal" value={filters[k]} onChange={setF(k)} placeholder="any" className={inputCls + ' mt-1'} />
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-6 text-sm text-slate-300">
            <label className="flex items-center gap-2"><input type="checkbox" checked={filters.pmoRisingOnly} onChange={setF('pmoRisingOnly')} />PMO above its signal line</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={filters.greenOnly} onChange={setF('greenOnly')} />Up on the day only</label>
          </div>
          <p className="text-xs text-slate-500">Filters apply instantly to the last scan. A blank box means no filter, and 0 is a real value.</p>
        </section>

        <section className="flex flex-wrap items-center gap-3">
          {scanning ? (
            <button type="button" onClick={stopScan} className="px-4 py-2 rounded bg-red-700 hover:bg-red-600 flex items-center gap-2"><Square className="w-4 h-4" />Stop scan</button>
          ) : (
            <button id="scan-btn" type="button" onClick={runScan} className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 flex items-center gap-2"><RefreshCw className="w-4 h-4" />{rows.length ? 'Rescan watchlist' : 'Scan watchlist'}</button>
          )}
          <button type="button" onClick={downloadCsv} disabled={!sorted.length} className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 flex items-center gap-2"><Download className="w-4 h-4" />Export CSV</button>
          {scanning && (
            <div className="flex-1 min-w-[200px]" role="status" aria-live="polite">
              <div className="h-2 rounded bg-slate-700 overflow-hidden"><div className="h-full bg-blue-500 transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
              <p className="text-xs text-slate-400 mt-1">{progress.done} of {progress.total} tickers</p>
            </div>
          )}
        </section>

        {errors.length > 0 && (
          <div className="rounded border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-slate-300">
            <p className="font-semibold mb-1">Skipped ({errors.length}):</p>
            <ul className="list-disc pl-5">{errors.map((e) => <li key={e.symbol}><span className="font-mono">{e.symbol}</span>: {e.message}</li>)}</ul>
          </div>
        )}

        <section className="bg-slate-800 rounded-lg shadow overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-700 text-slate-200">
              <tr>
                <th className="w-8" />
                <SortHeader label="Ticker" k="symbol" sort={sort} setSort={setSort} />
                <SortHeader label="Price" k="price" sort={sort} setSort={setSort} />
                <SortHeader label="Change" k="changePct" sort={sort} setSort={setSort} />
                <SortHeader label="RVOL" k="rvol" sort={sort} setSort={setSort} />
                <SortHeader label="PMO" k="pmo" sort={sort} setSort={setSort} />
                <SortHeader label="Shares out" k="sharesOut" sort={sort} setSort={setSort} />
                <SortHeader label="Score" k="score" sort={sort} setSort={setSort} />
                <th className="px-3 py-2 text-left font-semibold">Trend (60d)</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const open = expanded === r.symbol;
                const n = news[r.symbol];
                return (
                  <React.Fragment key={r.symbol}>
                    <tr className="border-t border-slate-700 hover:bg-slate-700/40 cursor-pointer" onClick={() => setExpanded(open ? null : r.symbol)}>
                      <td className="pl-3"><button type="button" aria-label={`${open ? 'Hide' : 'Show'} details for ${r.symbol}`} aria-expanded={open}>{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></td>
                      <td className="px-3 py-2"><div className="font-semibold">{r.symbol}</div><div className="text-xs text-slate-400 max-w-[180px] truncate">{r.name}</div></td>
                      <td className="px-3 py-2 tabular-nums">{fmtPrice(r.price)}</td>
                      <td className={`px-3 py-2 tabular-nums ${r.changePct == null ? '' : r.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtPct(r.changePct)}</td>
                      <td className={`px-3 py-2 tabular-nums ${r.rvol >= 2 ? 'text-emerald-400 font-semibold' : ''}`} title={r.rvolMode === 'time-of-day' ? `Volume so far vs the average of the same clock window over ${r.baselineDays} prior sessions` : undefined}>{r.rvol == null ? '—' : `${r.rvol.toFixed(2)}x`}</td>
                      <td className={`px-3 py-2 tabular-nums ${r.pmo == null ? '' : r.pmo > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{r.pmo == null ? '—' : <>{r.pmo.toFixed(2)} {r.pmoRising ? <ArrowUp className="inline w-3 h-3" aria-label="above signal" /> : <ArrowDown className="inline w-3 h-3" aria-label="below signal" />}</>}</td>
                      <td className="px-3 py-2 tabular-nums">{fmtShares(r.sharesOut)}</td>
                      <td className="px-3 py-2"><ScoreCell row={r} /></td>
                      <td className="px-3 py-2"><Sparkline values={r.spark} /></td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-900/60">
                        <td />
                        <td colSpan={8} className="px-3 py-4">
                          <div className="grid gap-6 md:grid-cols-2">
                            <div>
                              <h3 className="font-semibold mb-2">Why this score</h3>
                              <table className="w-full text-xs">
                                <tbody>
                                  {r.parts.map((p) => (
                                    <tr key={p.key} className="border-t border-slate-700">
                                      <td className="py-1 pr-2">{p.label}</td>
                                      <td className="py-1 pr-2 text-slate-400">{p.note}</td>
                                      <td className="py-1 text-right tabular-nums">{p.known ? `${p.earned}/${p.max}` : 'n/a'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {r.volToday != null && <p className="text-xs text-slate-400 mt-2">{r.rvolMode === 'time-of-day' ? `Volume so far ${fmtVolume(r.volToday)} vs ${fmtVolume(r.volAvg)} average at this time of day (${r.baselineDays} sessions).` : `Latest volume ${fmtVolume(r.volToday)} vs ${fmtVolume(r.volAvg)} 20-day average.`}</p>}
                              {r.sharesOut != null && <p className="text-xs text-slate-500 mt-1">Shares outstanding is used as a stand-in for float, which can be much smaller.</p>}
                            </div>
                            <div>
                              <h3 className="font-semibold mb-2 flex items-center gap-2">Recent news
                                <a href={`https://finance.yahoo.com/quote/${r.symbol}`} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 inline-flex items-center gap-1">Yahoo Finance <ExternalLink className="w-3 h-3" /></a>
                              </h3>
                              {!n || n.loading ? <p className="text-xs text-slate-400">Loading…</p>
                                : n.error ? <p className="text-xs text-amber-300">Could not load news: {n.error}</p>
                                : !n.items.length ? <p className="text-xs text-slate-400">No recent headlines.</p>
                                : <ul className="space-y-1.5 text-xs">{n.items.map((it, i) => <li key={i}><a href={it.url} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline">{it.headline}</a> <span className="text-slate-500">· {it.source}</span></li>)}</ul>}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {!sorted.length && (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                  {scanning ? 'Scanning…' : rows.length ? 'Nothing matches these filters. Loosen them or clear the filters.' : 'No results yet. Click “Scan watchlist”.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </section>

        <footer className="text-xs text-slate-500 pb-6">
          A screening aid, not investment advice. PMO is computed from daily closes. Live prices are about 16 minutes delayed (free-plan market data); RVOL compares volume so far today with the same time of day over the prior 20 sessions. Check any idea against a charting platform before acting.
        </footer>
      </div>
    </div>
  );
}
