// services/ta.js
// Pure technical indicators: RSI (Wilder) and Bollinger Bands (SMA + population stdev).
// Inputs: arrays of numeric closes. No network, no dates.
// Returns: latest values only (your MCP builds series by calling these on growing slices).

/**
 * Compute the latest RSI using Wilder's smoothing.
 * @param {number[]} values - Close prices (oldest → newest)
 * @param {number} period - RSI period (default 14)
 * @returns {number|null} - RSI in [0,100], or null if insufficient/invalid data
 */
export function rsi(values, period = 14) {
  const arr = normalize(values);
  if (arr.length < period + 1) return null;

  // Seed averages over the first `period` deltas
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smoothing for the remaining deltas
  for (let i = period + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (!isFiniteNum(avgGain) || !isFiniteNum(avgLoss)) return null;

  // Handle flat / division-by-zero cases explicitly
  if (avgLoss === 0) {
    if (avgGain === 0) return 50;   // perfectly flat
    return 100;                     // only gains
  }

  const rs = avgGain / avgLoss;
  if (!isFiniteNum(rs)) return null;

  const rsi = 100 - (100 / (1 + rs));
  return isFiniteNum(rsi) ? clamp(rsi, 0, 100) : null;
}

/**
 * Compute latest Bollinger Bands.
 * Uses SMA over the window and population standard deviation.
 * @param {number[]} values - Close prices (oldest → newest)
 * @param {number} period - Window length (default 20)
 * @param {number} mult - Std-dev multiplier (default 2)
 * @returns {{ mean:number, upper:number, lower:number, last:number, percentB:number|null, bandwidth:number|null }|null}
 */
export function bollinger(values, period = 20, mult = 2) {
  const arr = normalize(values);
  if (arr.length < period) return null;

  const slice = arr.slice(-period);
  const mean = avg(slice);
  if (!isFiniteNum(mean)) return null;

  const variance = avg(slice.map(v => (v - mean) * (v - mean)));
  const stdev = Math.sqrt(variance);
  if (!isFiniteNum(stdev)) return null;

  const upper = mean + mult * stdev;
  const lower = mean - mult * stdev;
  const last  = arr[arr.length - 1];

  // Avoid division by zero in derived metrics
  const denomBands = upper - lower;
  const denomMean  = mean;

  const percentB =
    isFiniteNum(denomBands) && denomBands !== 0
      ? (last - lower) / denomBands
      : null;

  const bandwidth =
    isFiniteNum(denomMean) && denomMean !== 0
      ? (upper - lower) / denomMean
      : null;

  return {
    mean,
    upper,
    lower,
    last,
    percentB: isFiniteNum(percentB) ? percentB : null,
    bandwidth: isFiniteNum(bandwidth) ? bandwidth : null
  };
}

// ───────── helpers (kept local to this module)

function normalize(values) {
  // Coerce to numbers and drop non-finite entries to keep math stable.
  if (!Array.isArray(values)) return [];
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const x = Number(values[i]);
    if (Number.isFinite(x)) out.push(x);
  }
  return out;
}

function avg(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function isFiniteNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}
