/**
 * PayKit SDK — browser wrapper.
 *
 * This file imports the REAL shipped `paykit` package (added as a local
 * `file:..` dependency in package.json and built into `../dist`). The
 * playground therefore exercises the exact same code that ships on npm —
 * not a hand-written copy.
 *
 * Browser-safe primitives re-exported directly from the real package:
 *   - MockProvider               (../src/providers/mock.ts)
 *   - IdempotentPaymentExecutor  (../src/payments/idempotent.ts)
 *   - InMemoryIdempotencyStore   (../src/payments/idempotent.ts)
 *   - FraudDetector              (../src/fraud/detector.ts)
 *
 * The ONE exception is the webhook engine. The real `WebhookEngine`
 * (../src/webhooks/handler.ts) uses Node's built-in `crypto` module
 * (`crypto.createHmac` / `crypto.timingSafeEqual`), which is not available in
 * the browser. Rather than ship a Node polyfill into the client bundle, we
 * provide `BrowserWebhookEngine` below. It is NOT the shipped code: it has its
 * own dispatch and deduplication around the package's shared helpers (event-type
 * mapping, event-id rule, dedup key, header parsing, replay window), and mirrors
 * the real engine's public surface (`on` / `process` / `computeSignature` /
 * `verifyStripeSignature`). The signature scheme (`t=<ts>,v1=<hex>` over
 * `${ts}.${rawBody}`) is identical, so a signature produced here verifies
 * against the real Node engine and vice versa, and the replay window is
 * enforced with the SAME shared `checkTimestampFreshness` the Node engine
 * uses (default 300s tolerance). The HMAC itself is computed with the
 * browser-native Web Crypto API (`crypto.subtle`) instead of Node `crypto`.
 *
 * Parity is enforced by the SDK's own test-suite: jest imports THIS class
 * (`tests/browser_webhook_parity.test.ts`) and runs one verdict table against
 * it and the Node engine (fail-closed gate, tamper, replay window, dedup).
 *
 * It serves only this playground, so it is deliberately less than the Node
 * engine: no retries, timeout or `signal` (each handler runs once), the Stripe
 * scheme for every provider, and no memory bounds. The suite pins those too.
 */

// ── Real package (browser-safe classes) ─────────────────────────────────────
export {
  MockProvider,
  IdempotentPaymentExecutor,
  InMemoryIdempotencyStore,
  FraudDetector,
  VERSION,
} from "paykit";

import {
  checkTimestampFreshness,
  isSha256HexDigest,
  MockProvider,
  normalizeStripeEventType,
  parseStripeSignatureHeader,
  toleranceSecondsError,
  webhookDedupKey,
  webhookEventId,
} from "paykit";

export { normalizeStripeEventType };

/**
 * The real `MockProvider`, counting `createPayment` calls: the payments tab's
 * evidence that a cache HIT never reached the provider. A payment id cannot show
 * that, because `MockProvider` replays a re-sent key's original payment, so an
 * executor whose cache was broken would return the same id.
 */
export class CountingMockProvider extends MockProvider {
  createPaymentCalls = 0;

  async createPayment(request: Parameters<MockProvider["createPayment"]>[0]) {
    this.createPaymentCalls++;
    return super.createPayment(request);
  }

  reset(): void {
    super.reset();
    this.createPaymentCalls = 0;
  }
}

export type {
  PaymentStatus,
  PaymentProvider,
  Money,
  PaymentIntent,
  CreatePaymentRequest,
  WebhookEvent,
  WebhookEventType,
  WebhookProcessResult,
  FraudContext,
  FraudSignal,
  FraudCheckResult,
  FraudRiskLevel,
} from "paykit";

// ── Browser webhook adapter (Web Crypto, mirrors the real WebhookEngine) ─────
import type { WebhookEvent, WebhookProcessResult } from "paykit";

/**
 * Browser-native equivalent of the real `WebhookEngine`.
 *
 * The real engine (src/webhooks/handler.ts) verifies signatures with Node's
 * `crypto.createHmac(...).digest("hex")` and `crypto.timingSafeEqual`. Those
 * are Node-only. This adapter reproduces the SAME signature format and the
 * SAME process/dedup/dispatch semantics using `crypto.subtle`, so the
 * playground demonstrates real webhook verification logic in the browser.
 * Like the Node engine it fails closed: unless constructed with
 * `{ allowUnsigned: true }`, `process()` rejects a call without a secret, and a
 * call with a secret but no signature, before any handler runs.
 *
 * Signature format (identical to the real engine):
 *   `t=<unix_seconds>,v1=<hex hmac-sha256 of "${ts}.${rawBody}">`
 */
export class BrowserWebhookEngine {
  private handlers = new Map<
    string,
    Array<(event: WebhookEvent, data: unknown) => Promise<void>>
  >();
  private processedIds = new Set<string>();
  /** Same synchronous in-flight reservation as the Node engine: check and add with no `await` between. */
  private inFlightIds = new Set<string>();
  private deadLetters: Array<{ event: WebhookEvent; error: string }> = [];
  /** Replay window in seconds; same default (300) as the Node engine. */
  private readonly toleranceSeconds: number;
  /** Same opt-in, same default (`false`) as the Node engine's `allowUnsigned`. */
  private readonly allowUnsigned: boolean;

  constructor(options: { toleranceSeconds?: number; allowUnsigned?: boolean } = {}) {
    // Same validation as the Node engine: an invalid tolerance (NaN, negative,
    // over a day) must not silently disable replay protection.
    const reason = options.toleranceSeconds === undefined ? null : toleranceSecondsError(options.toleranceSeconds);
    if (reason) throw new Error(`Invalid BrowserWebhookEngine config: ${reason}.`);
    this.toleranceSeconds = options.toleranceSeconds ?? 300;
    this.allowUnsigned = options.allowUnsigned ?? false;
  }

  on(
    eventType: string | string[],
    handler: (event: WebhookEvent, data: unknown) => Promise<void>,
  ): this {
    const types = Array.isArray(eventType) ? eventType : [eventType];
    for (const type of types) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type)!.push(handler);
    }
    return this;
  }

  off(eventType: string): this {
    this.handlers.delete(eventType);
    return this;
  }

  /**
   * Process an incoming webhook payload. Matches the real engine's contract:
   * verifies the signature (fail closed — a missing signature with a secret,
   * or no secret without `allowUnsigned`, throws before any handler runs),
   * parses, deduplicates by event id, then dispatches matching + wildcard
   * handlers.
   */
  async process(options: {
    rawBody: string;
    signature?: string;
    secret?: string;
    provider?: string;
    timestamp?: number;
  }): Promise<WebhookProcessResult> {
    const { rawBody, signature, secret, timestamp } = options;
    const provider = options.provider ?? "stripe";

    if (secret) {
      if (!signature) throw new WebhookSignatureError(provider, "missing_signature");
      const reason = await this.verifyStripeSignatureReason(rawBody, signature, secret, timestamp);
      if (reason) throw new WebhookSignatureError(provider, reason);
    } else if (!this.allowUnsigned) {
      throw new WebhookSignatureError(provider, "missing_secret");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error("Invalid JSON in webhook body");
    }
    // Same rule as the Node engine: null, an array or a scalar is refused.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Webhook body must be a JSON object");
    }

    // Same shared rule as the Node engine: no id → rejected, never invented
    // (an invented id is new on every redelivery and would defeat dedup).
    const id = webhookEventId(parsed, provider);
    if (id === null) {
      throw new Error("Webhook event has no id; it cannot be deduplicated, so it is not processed");
    }

    const providerType = typeof parsed.type === "string" ? parsed.type : "unknown";
    const data = (parsed.data as Record<string, unknown>) ?? {};
    const event: WebhookEvent = {
      id,
      // Same shared normaliser as the Node engine (payment_intent.succeeded → payment.succeeded).
      type: provider === "stripe" ? normalizeStripeEventType(providerType, data) : providerType,
      providerType,
      provider: provider as WebhookEvent["provider"],
      livemode: !!parsed.livemode,
      createdAt: new Date(((parsed.created as number) ?? Date.now() / 1000) * 1000),
      data,
      rawBody,
      signature,
    };

    // Check-and-reserve with no await in between, exactly like the Node
    // engine, under the same shared (provider, event id) key.
    const dedupKey = webhookDedupKey(provider, event.id);
    if (this.processedIds.has(dedupKey)) {
      return {
        processed: false,
        eventId: event.id,
        eventType: event.type,
        handlersRun: 0,
        error: "duplicate_event",
      };
    }
    if (this.inFlightIds.has(dedupKey)) {
      return {
        processed: false,
        eventId: event.id,
        eventType: event.type,
        handlersRun: 0,
        error: "in_flight",
      };
    }
    this.inFlightIds.add(dedupKey);

    try {
      // Canonical type, raw provider type, then "*" — each handler once (as Node).
      const all = [...new Set([
        ...(this.handlers.get(event.type) ?? []),
        ...(event.providerType !== event.type ? this.handlers.get(event.providerType) ?? [] : []),
        ...(this.handlers.get("*") ?? []),
      ])];

      let handlersRun = 0;
      let handlersFailed = 0;
      for (const handler of all) {
        try {
          await handler(event, event.data);
          handlersRun++;
        } catch (err) {
          handlersFailed++;
          this.deadLetters.push({
            event,
            error: err instanceof Error ? err.message : "handler error",
          });
        }
      }

      if (handlersFailed > 0) {
        // Same contract as the Node engine: a failed event is not acked and
        // not remembered, so a redelivery runs the handlers again.
        return {
          processed: false,
          eventId: event.id,
          eventType: event.type,
          handlersRun,
          handlersFailed,
          error: "handler_failed",
        };
      }

      this.processedIds.add(dedupKey);
      return {
        processed: true,
        eventId: event.id,
        eventType: event.type,
        handlersRun,
        ...(handlersRun === 0 ? { unhandled: true } : {}),
      };
    } finally {
      this.inFlightIds.delete(dedupKey);
    }
  }

  getDeadLetters(): Array<{ event: WebhookEvent; error: string }> {
    return [...this.deadLetters];
  }

  reset(): void {
    this.handlers.clear();
    this.processedIds.clear();
    this.deadLetters = [];
  }

  /**
   * Compute an HMAC-SHA256 webhook signature using Web Crypto.
   * Produces `t=<ts>,v1=<hex>` over `${ts}.${rawBody}` — byte-identical to the
   * real Node engine's `computeSignature`.
   */
  async computeSignature(rawBody: string, secret: string, timestamp?: number): Promise<string> {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const hex = await hmacSha256Hex(`${ts}.${rawBody}`, secret);
    return `t=${ts},v1=${hex}`;
  }

  /**
   * Verify a Stripe-style `t=...,v1=...` signature, INCLUDING timestamp
   * freshness — a validly-signed payload older (or newer) than the replay
   * window is rejected, exactly like the Node engine. Pass `nowSeconds` to
   * pin "now" in tests.
   */
  async verifyStripeSignature(
    rawBody: string,
    signature: string,
    secret: string,
    nowSeconds?: number,
  ): Promise<boolean> {
    return (await this.verifyStripeSignatureReason(rawBody, signature, secret, nowSeconds)) === null;
  }

  /**
   * Same check as `verifyStripeSignature`, returning the rejection reason
   * (the Node engine's reason strings) or `null` when the signature is valid.
   */
  private async verifyStripeSignatureReason(
    rawBody: string,
    signature: string,
    secret: string,
    nowSeconds?: number,
  ): Promise<string | null> {
    if (!secret) return "missing_secret";
    if (!signature) return "missing_signature";
    // Same shared parser + strict digest check as the Node engine: any
    // matching v1 is valid, and only exactly-64-lowercase-hex candidates count.
    const header = parseStripeSignatureHeader(signature);
    if (!header) return "malformed_signature_header";
    const expectedHex = await hmacSha256Hex(`${header.timestamp}.${rawBody}`, secret);
    let matched = false;
    for (const candidate of header.signatures) {
      if (isSha256HexDigest(candidate) && timingSafeEqualHex(expectedHex, candidate)) matched = true;
    }
    if (!matched) return "signature_mismatch";
    const fresh = checkTimestampFreshness(header.timestamp, this.toleranceSeconds, nowSeconds);
    return fresh.ok ? null : fresh.reason;
  }
}

/** Mirrors the real package's WebhookSignatureError (same message, code, reason). */
export class WebhookSignatureError extends Error {
  readonly code = "WEBHOOK_SIGNATURE_INVALID";
  readonly reason?: string;
  constructor(provider: string, reason?: string) {
    super(`Webhook signature verification failed for provider: ${provider}${reason ? ` (${reason})` : ""}`);
    this.name = "WebhookSignatureError";
    this.reason = reason;
  }
}

// ── Web Crypto helpers ───────────────────────────────────────────────────────

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  // `globalThis.crypto` is `window.crypto` in a browser and Node's Web Crypto
  // in the SDK's jest suite, which runs this exact class for parity.
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish hex comparison (mirrors crypto.timingSafeEqual intent). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
