// Indicator math for the Explosive Move Scanner.
// Pure functions, no network, no React. Everything here is covered by tests/indicators.test.mjs.

/** Simple average of an array of numbers (ignores nothing: caller passes clean data). */
export function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Standard exponential moving average, multiplier 2/(n+1), seeded with the first value. */
export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = null;
  for (const v of values) {
    if (v == null || Number.isNaN(v)) { out.push(prev); continue; }
    prev = prev == null ? v : (v - prev) * k + prev;
    out.push(prev);
  }
  return out;
}

/**
 * DecisionPoint "custom smoothing function" used by the PMO:
 * like an EMA but with multiplier 2/period (not 2/(period+1)).
 */
export function customSmooth(values, period) {
  const k = 2 / period;
  const out = [];
  let prev = null;
  for (const v of values) {
    if (v == null || Number.isNaN(v)) { out.push(prev); continue; }
    prev = prev == null ? v : (v - prev) * k + prev;
    out.push(prev);
  }
  return out;
}

/** One-day percent change series. out[0] is null. */
export function rateOfChange(closes) {
  return closes.map((c, i) => (i === 0 || !closes[i - 1] ? null : (c / closes[i - 1]) * 100 - 100));
}

/**
 * Price Momentum Oscillator.
 *   PMO line = p2-period custom smoothing of ( 10 x p1-period custom smoothing of daily % change )
 *   Signal   = p3-period EMA of the PMO line
 * Defaults match this scanner's PMO(13, 8, 5). The classic DecisionPoint setting is (35, 20, 10).
 * Smoothing is seeded with the first available value, so the first few readings are less reliable;
 * give it at least ~4x the first period in bars (the providers request ~120 daily bars).
 */
export function pmo(closes, { p1 = 13, p2 = 8, p3 = 5 } = {}) {
  const roc = rateOfChange(closes);
  const first = customSmooth(roc, p1).map((v) => (v == null ? null : v * 10));
  const line = customSmooth(first, p2);
  const signal = ema(line, p3);
  return { line, signal };
}

/** Latest PMO reading (or nulls when there isn't enough history). */
export function latestPmo(closes, opts = {}) {
  const minBars = (opts.p1 ?? 13) * 3;
  if (!closes || closes.length < minBars) return { value: null, signal: null, rising: null };
  const { line, signal } = pmo(closes, opts);
  const value = line[line.length - 1];
  const sig = signal[signal.length - 1];
  // A tiny tolerance stops floating-point noise from reading a flat PMO as "rising".
  return { value, signal: sig, rising: value != null && sig != null ? value - sig > 1e-6 : null };
}

// ---------- Market clock (US equities, Eastern time) ----------

const ET = 'America/New_York';

function etParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { weekday: p.weekday, dateKey: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute) };
}

/** 'YYYY-MM-DD' in Eastern time for a unix-seconds or Date value. */
export function etDateKey(t) {
  return etParts(t instanceof Date ? t : new Date(t * 1000)).dateKey;
}

/**
 * Fraction of the regular session (9:30-16:00 ET) that has elapsed.
 * Returns 1 when the market is closed (weekend, before the open, after the close)
 * because then the latest daily bar is a complete day. Holidays are not detected.
 */
export function sessionFraction(now = new Date()) {
  const { weekday, minutes } = etParts(now);
  if (weekday === 'Sat' || weekday === 'Sun') return 1;
  const open = 9 * 60 + 30, close = 16 * 60;
  if (minutes < open || minutes >= close) return 1;
  return (minutes - open) / (close - open);
}

export function isMarketOpen(now = new Date()) {
  const { weekday } = etParts(now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const f = sessionFraction(now);
  return f > 0 && f < 1;
}

// ---------- Relative volume ----------

/**
 * Relative volume from daily bars.
 *   avg   = mean volume of the `lookback` completed days BEFORE the latest bar
 *   ratio = latest volume / avg
 * When `timeAdjust` is on and the latest bar is today's still-forming bar, the average is scaled by the
 * fraction of the session elapsed (a straight-line approximation: real volume is heavier at the open and
 * close, so early-session readings run high and are floored at 10% of the session).
 */
export function relativeVolume(bars, { lookback = 20, timeAdjust = true, now = new Date() } = {}) {
  if (!bars || bars.length < lookback + 1) return { ratio: null, today: null, avg: null, adjusted: false };
  const latest = bars[bars.length - 1];
  const prior = bars.slice(-1 - lookback, -1).map((b) => b.v);
  const avg = mean(prior);
  if (!avg) return { ratio: null, today: latest.v, avg: null, adjusted: false };
  const formingToday = isMarketOpen(now) && etDateKey(latest.t) === etDateKey(now);
  let expected = avg;
  if (timeAdjust && formingToday) expected = avg * Math.max(sessionFraction(now), 0.1);
  return { ratio: latest.v / expected, today: latest.v, avg, adjusted: timeAdjust && formingToday };
}

// ---------- Score ----------

/**
 * Explainable 0-100 score. Default weights keep the original scanner's split:
 * momentum 30, volume 40, float 30. Missing inputs are reported as n/a and the score is scaled over
 * what is actually known (flagged `partial`) instead of being filled with made-up numbers.
 */
export function scoreStock({ pmo: pmoValue, pmoRising, rvol, sharesOut }) {
  const parts = [];
  const add = (key, label, max, earned, note) => parts.push({ key, label, max, earned, known: earned != null, note });

  add('pmoPos', 'PMO above zero', 15, pmoValue == null ? null : pmoValue > 0 ? 15 : 0,
    pmoValue == null ? 'needs price history' : `PMO ${pmoValue.toFixed(2)}`);
  add('pmoRise', 'PMO above its signal line', 15, pmoRising == null ? null : pmoRising ? 15 : 0,
    pmoRising == null ? 'needs price history' : pmoRising ? 'rising' : 'falling');
  const rv = rvol == null ? null : rvol >= 2 ? 40 : rvol >= 1.5 ? 28 : rvol >= 1.2 ? 15 : 0;
  add('rvol', 'Relative volume', 40, rv, rvol == null ? 'needs volume history' : `${rvol.toFixed(2)}x (2x = full marks)`);
  const fl = sharesOut == null ? null : sharesOut < 70e6 ? 30 : sharesOut < 150e6 ? 15 : 0;
  add('float', 'Small share count', 30, fl,
    sharesOut == null ? 'share count unavailable' : `${(sharesOut / 1e6).toFixed(1)}M shares (<70M = full marks)`);

  const known = parts.filter((p) => p.known);
  const maxKnown = known.reduce((a, p) => a + p.max, 0);
  if (!maxKnown) return { score: null, partial: true, parts };
  const earned = known.reduce((a, p) => a + p.earned, 0);
  return { score: Math.round((earned / maxKnown) * 100), partial: known.length < parts.length, parts };
}

/** Format a unix-seconds or ms-less price series as last-N closes for sparklines. */
export function lastCloses(bars, n = 60) {
  return bars.slice(-n).map((b) => b.c);
}
