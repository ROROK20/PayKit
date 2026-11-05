/**
 * Webhook signature timestamp freshness — the replay-window check.
 *
 * Deliberately dependency-free and browser-safe: the Node `WebhookEngine`
 * and the frontend `BrowserWebhookEngine` both call THIS function, so the
 * replay-protection semantics cannot drift between the two environments.
 */

export type FreshnessResult =
  | { ok: true }
  | { ok: false; reason: "invalid_timestamp" | "timestamp_outside_tolerance" | "invalid_tolerance" };

/** Largest replay window accepted: one day. Stripe signs every redelivery afresh. */
export const MAX_TOLERANCE_SECONDS = 86_400;

/**
 * Why a `toleranceSeconds` value is unusable, or `null` when it is valid: a
 * finite number from 0 (the check disabled — the one way to turn it off) to
 * `MAX_TOLERANCE_SECONDS`. `NaN` matters most: `Number(process.env.X)` of an
 * unset variable is `NaN`, and `Math.abs(now - ts) > NaN` is always false, so
 * an unvalidated `NaN` would silently accept signatures of any age.
 */
export function toleranceSecondsError(toleranceSeconds: unknown): string | null {
  if (typeof toleranceSeconds !== "number" || !Number.isFinite(toleranceSeconds)) {
    return `toleranceSeconds must be a finite number of seconds, got ${String(toleranceSeconds)}`;
  }
  if (toleranceSeconds < 0) {
    return `toleranceSeconds must be >= 0 (0 disables the replay check), got ${toleranceSeconds}`;
  }
  if (toleranceSeconds > MAX_TOLERANCE_SECONDS) {
    return `toleranceSeconds must be at most ${MAX_TOLERANCE_SECONDS} (one day), got ${toleranceSeconds}`;
  }
  return null;
}

/**
 * Check a signature's embedded unix-seconds timestamp against `nowSeconds`
 * (defaults to current time). A timestamp farther than `toleranceSeconds`
 * away — in either direction — is rejected. `toleranceSeconds === 0` disables
 * the check; an invalid tolerance (see `toleranceSecondsError`) fails closed
 * with `invalid_tolerance` rather than accepting every age.
 */
export function checkTimestampFreshness(
  tsRaw: string,
  toleranceSeconds: number,
  nowSeconds?: number,
): FreshnessResult {
  if (toleranceSecondsError(toleranceSeconds) !== null) return { ok: false, reason: "invalid_tolerance" };
  if (toleranceSeconds === 0) return { ok: true };

  const ts = Number(tsRaw);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return { ok: false, reason: "timestamp_outside_tolerance" };
  }
  return { ok: true };
}
