// Pure signal normalization primitives for the scoring model (design §5).
// Pike log-saturation is the OpenSSF criticality-score template — every group
// subscore is assembled from these functions. Nothing here touches I/O:
// fixture in, number out, so the whole model is fixture-testable.

/** Clamp to the [0, 1] unit interval every subscore lives in. */
export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Pike log-saturation: `n(S, T) = log(1 + S) / log(1 + max(S, T))`. A raw
 * count `S` saturates toward 1 as it approaches (and past) the threshold `T`
 * — the OpenSSF criticality template design §5 mandates. Guards: negative `S`
 * clamps to 0; when `max(S, T)` is 0 (no signal, no threshold) the 0/0 ratio
 * is defined as 0 (no evidence, never NaN).
 */
export function pike(signal: number, threshold: number): number {
  const s = signal > 0 ? signal : 0;
  const denomBase = Math.max(s, threshold);
  if (denomBase <= 0) return 0;
  return Math.log1p(s) / Math.log1p(denomBase);
}

/**
 * Whole days between an ISO timestamp and `nowMs`, never negative (a future
 * date reads as 0 days since). `null`/unparseable input → `null` so callers
 * can treat a missing date as an absent sub-signal, not a fresh one.
 */
export function daysSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = (nowMs - t) / 86_400_000;
  return days > 0 ? days : 0;
}

/**
 * Recency as an inverted saturation: a fresh event (days ≈ 0) scores ~1, an
 * event at or beyond the threshold `T` scores ~0. This is `1 - pike(days, T)`
 * — the "days-since → score, threshold inverted" transform design §5 applies
 * to push/release recency and issue close-latency.
 */
export function recencyFromDays(days: number, threshold: number): number {
  return clamp01(1 - pike(days, threshold));
}

/**
 * Mean of the finite entries; `null` when nothing is present. This is how a
 * group subscore blends its available sub-signals AND how a fully-absent
 * group signals "no data" (→ renormalized away, listed in nodata), never a
 * misleading zero (design §5 missing-data honesty).
 */
export function meanPresent(values: (number | null | undefined)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      count += 1;
    }
  }
  return count === 0 ? null : sum / count;
}
