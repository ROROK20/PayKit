/**
 * Optional typed backend client.
 *
 * PayKit's playground runs the REAL SDK entirely in the browser (see
 * `lib/sdk.ts`), so no backend is required — the default mode is "demo"
 * (in-browser SDK). However, if you point the app at a server that exposes the
 * same primitives over HTTP, set `NEXT_PUBLIC_API_URL` and the playground will
 * try the live backend first, then transparently fall back to the in-browser
 * SDK on ANY error (network failure, non-2xx, bad JSON, or no URL configured).
 *
 * This keeps `npm run build` and a no-backend static deploy fully functional:
 * the fallback path never throws into the React tree.
 */

import type { FraudContext, FraudCheckResult } from "paykit";

/**
 * Base URL of an optional PayKit backend. Empty string => no backend
 * configured => callers fall back to the in-browser SDK.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

/** Whether a backend URL is configured at build time. */
export const isApiConfigured = API_URL.length > 0;

export type ApiMode = "live" | "demo";

/** Result wrapper telling the caller which engine actually served the request. */
export interface ApiResult<T> {
  data: T;
  mode: ApiMode;
}

const DEFAULT_TIMEOUT_MS = 4000;

async function postJson<T>(path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  if (!isApiConfigured) {
    throw new Error("NEXT_PUBLIC_API_URL not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Backend responded ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health probe — used by the "live / demo" indicator. Resolves to `true` only
 * if a backend is configured AND reachable. Never throws.
 */
export async function pingBackend(timeoutMs = 2500): Promise<boolean> {
  if (!isApiConfigured) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a fraud check against the live backend. Throws on any failure so the
 * caller can fall back to the in-browser `FraudDetector`.
 */
export async function checkFraud(ctx: FraudContext): Promise<FraudCheckResult> {
  return postJson<FraudCheckResult>("/fraud/check", ctx);
}

/**
 * Helper that wraps a live-call + local-fallback in one place. Returns the
 * result plus the mode that actually produced it. Never throws.
 */
export async function withFallback<T>(
  live: () => Promise<T>,
  local: () => T | Promise<T>,
): Promise<ApiResult<T>> {
  if (isApiConfigured) {
    try {
      return { data: await live(), mode: "live" };
    } catch {
      // fall through to local engine
    }
  }
  return { data: await local(), mode: "demo" };
}
