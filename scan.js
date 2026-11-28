import { latestPmo, relativeVolume, scoreStock, lastCloses } from './indicators.js';

export const MAX_SYMBOLS = 40;

/** Parse "mara, riot  tsla\nSOFI" into unique, valid, upper-case tickers. */
export function parseSymbols(text) {
  const seen = new Set();
  const valid = [];
  const rejected = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const s = raw.trim().toUpperCase();
    if (!s) continue;
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) { rejected.push(raw); continue; }
    if (!seen.has(s)) { seen.add(s); valid.push(s); }
  }
  return { valid, rejected };
}

/** Turn a provider snapshot into a result row with real indicators. */
export function analyze(snapshot, { timeAdjust = true } = {}) {
  const closes = snapshot.bars.map((b) => b.c);
  const p = latestPmo(closes);
  // The live Worker sends time-of-day RVOL already computed from 5-minute bars (null = unavailable).
  // Demo data has only daily bars, so it falls back to the daily ratio.
  const pre = snapshot.rvol;
  const rv = pre !== undefined
    ? (pre ? { ratio: pre.ratio, today: pre.today, avg: pre.baseline, adjusted: false, mode: 'time-of-day', days: pre.days, unit: pre.unit || 'shares', shares: pre.shares || null }
           : { ratio: null, today: null, avg: null, adjusted: false, mode: 'time-of-day' })
    : { ...relativeVolume(snapshot.bars, { timeAdjust }), mode: 'daily' };
  const { score, partial, parts } = scoreStock({
    pmo: p.value, pmoRising: p.rising, rvol: rv.ratio, sharesOut: snapshot.sharesOut,
  });
  return {
    symbol: snapshot.symbol,
    name: snapshot.name,
    price: snapshot.price,
    changePct: snapshot.changePct,
    rvol: rv.ratio,
    rvolAdjusted: rv.adjusted,
    rvolMode: rv.mode,
    baselineDays: rv.days ?? null,
    volToday: rv.today,
    volAvg: rv.avg,
    rvolUnit: rv.unit || 'shares',
    sharesRvol: rv.shares ? rv.shares.ratio : null,
    sharesToday: rv.shares ? rv.shares.today : null,
    sharesAvg: rv.shares ? rv.shares.baseline : null,
    pmo: p.value,
    pmoSignal: p.signal,
    pmoRising: p.rising,
    sharesOut: snapshot.sharesOut,
    score,
    partial,
    parts,
    spark: lastCloses(snapshot.bars, 60),
    problems: snapshot.problems,
    source: snapshot.source,
    asOf: snapshot.asOf,
  };
}

/**
 * Filters. A blank field means "don't filter". Zero is a real value (e.g. Min PMO 0).
 * A row with an unknown value for a filtered metric is excluded and counted as "unknown",
 * so missing data never silently passes a filter.
 */
export function applyFilters(rows, f) {
  const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
  const maxPrice = num(f.maxPrice), minRvol = num(f.minRvol), minPmo = num(f.minPmo), minScore = num(f.minScore);
  let unknown = 0;
  const kept = rows.filter((r) => {
    const checks = [];
    if (maxPrice != null) checks.push([r.price, (v) => v <= maxPrice]);
    if (minRvol != null) checks.push([r.rvol, (v) => v >= minRvol]);
    if (minPmo != null) checks.push([r.pmo, (v) => v >= minPmo]);
    if (minScore != null) checks.push([r.score, (v) => v >= minScore]);
    if (f.pmoRisingOnly) checks.push([r.pmoRising, (v) => v === true]);
    if (f.greenOnly) checks.push([r.changePct, (v) => v > 0]);
    for (const [value, ok] of checks) {
      if (value == null) { unknown += 1; return false; }
      if (!ok(value)) return false;
    }
    return true;
  });
  return { kept, unknown };
}

export function toCsv(rows) {
  const head = ['Symbol', 'Price', 'Change %', 'RVOL', 'PMO', 'PMO rising', 'Shares out (M)', 'Score', 'Partial'];
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? String(Number(v.toFixed(4))) : `"${String(v).replace(/"/g, '""')}"`);
  const lines = rows.map((r) => [
    r.symbol, r.price, r.changePct, r.rvol, r.pmo, r.pmoRising, r.sharesOut == null ? null : r.sharesOut / 1e6, r.score, r.partial,
  ].map(cell).join(','));
  return [head.join(','), ...lines].join('\n');
}

