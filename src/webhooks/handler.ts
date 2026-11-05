/**
 * Webhook ingestion and dispatch engine.
 *
 * Features:
 * - Signature verification: Stripe's timestamped `t=,v1=` HMAC-SHA256 scheme
 *   (replay window enforced), or for any other provider a generic
 *   `sha256=<hex>` HMAC-SHA256 of the raw body. The generic scheme carries NO
 *   timestamp — a captured request stays valid forever, and only event-id
 *   dedup stands in the way of a replay — and it is not Plaid's (JWT) or
 *   Wise's (RSA) scheme, so their real webhooks will not verify.
 * - Deduplication: concurrent or repeated deliveries of one event never
 *   dispatch twice in this process (synchronous in-flight reservation plus a
 *   bounded processed-id FIFO), keyed by provider AND event id — ids are only
 *   unique per provider; multi-instance deployments need a shared store.
 *   The reservation is held until every handler attempt has settled — a slow
 *   attempt that outlives `handlerTimeoutMs` is never run twice at once.
 *   Across processes there is no such guarantee: handlers must be idempotent.
 *   An event without an id is rejected (`INVALID_PAYLOAD`), never given one
 * - Retry-with-backoff for failed handlers
 * - Handler registration by event type or wildcard; Stripe event types are
 *   normalised to PayKit names (`payment_intent.succeeded` → `payment.succeeded`)
 *   and handlers under either name run
 * - Dead-letter tracking for failed events (a bounded FIFO, `maxDeadLetters`)
 *   — a failed event is NOT acked: it is not remembered as processed, so the
 *   provider's redelivery runs again
 */

import crypto from "crypto";

import {
  WebhookEvent,
  WebhookProcessResult,
  WebhookEventType,
  WebhookSubscription,
  WebhookSignatureError,
  PaymentProvider,
  PayKitError,
} from "../types/index";
import { checkTimestampFreshness, toleranceSecondsError } from "./freshness";
import { normalizeStripeEventType, webhookDedupKey, webhookEventId } from "./events";
import { isSha256HexDigest, parseStripeSignatureHeader } from "./signature";

export interface WebhookEngineConfig {
  /**
   * Attempts per handler, the first included (default 3). An integer >= 1:
   * 0 would mean a handler is never run at all.
   */
  maxRetries?: number;
  /** Initial backoff delay in ms between handler attempts (default 500; finite, >= 0). */
  initialDelayMs?: number;
  /**
   * Max allowed age (in seconds) of a signed webhook, comparing the signature's
   * timestamp against now. Protects against replay of an old-but-validly-signed
   * payload. Set to 0 to disable the age check. Default 300 (5 minutes).
   * Must be a finite number from 0 to 86_400 (one day); anything else —
   * including the `NaN` of `Number(process.env.UNSET_VAR)` — throws
   * `INVALID_CONFIG` instead of silently accepting signatures of any age.
   */
  toleranceSeconds?: number;
  /**
   * Max number of recently-processed event IDs retained for deduplication.
   * The set is a bounded FIFO: once full, the OLDEST id is evicted to admit a
   * new one, so memory stays flat in a long-running process. Consequence: an
   * event replayed after more than `maxProcessedIds` *other* distinct events
   * have been seen is not recognized as a duplicate and would be
   * re-dispatched. Size this above the number of distinct events you expect
   * inside your provider's own retry window (Stripe retries for up to ~3 days).
   * The engine has no pluggable store: for durable or cross-instance
   * exactly-once effects, make handlers idempotent against your own database
   * (e.g. a unique `webhookDedupKey(provider, id)`). Default 10_000. Set to 0 for unbounded
   * (the pre-cap behavior — grows forever).
   */
  maxProcessedIds?: number;
  /**
   * Max number of entries kept for `getDeadLetters()`. A bounded FIFO like
   * `maxProcessedIds`: once full, the oldest entry is dropped to admit a new
   * one. Each entry holds the whole event (raw body included), and a handler
   * that keeps failing adds one per redelivery, so an unbounded list grows for
   * as long as the failure lasts. Default 1_000; 0 for unbounded. In-memory
   * and per process: for a durable record, persist failures from your route —
   * the event is not acked, so the provider redelivers it regardless.
   */
  maxDeadLetters?: number;
  /**
   * Process events when NO secret is configured, skipping verification.
   *
   * Default `false`: `process()` without a `secret` throws
   * `WebhookSignatureError` (reason `missing_secret`), so an accidentally-unset
   * env var (`process.env.STRIPE_WEBHOOK_SECRET` → `undefined`) can never
   * silently turn verification off. Set it only for local demos and tests.
   * It never relaxes a configured secret: whenever `secret` is passed, a
   * missing or invalid signature is rejected regardless of this flag.
   */
  allowUnsigned?: boolean;
  /**
   * How long `process()` waits for one handler attempt, in ms (default
   * 30_000; 0 = wait as long as it takes). When an attempt runs longer,
   * `process()` returns `in_flight` (answer non-2xx; the provider redelivers)
   * and aborts the attempt's `signal` — but the attempt is NOT abandoned: the
   * event stays reserved in this process until it settles, so no second copy
   * of the handler ever runs alongside it. When it settles, its real outcome
   * is recorded — a late success marks the event processed (the next
   * redelivery is acknowledged as `duplicate_event`), a failure continues the
   * normal retry → dead-letter path, each retry starting only after the
   * previous attempt settled. A handler that never settles keeps its event
   * `in_flight` in this process until it does (or the process restarts):
   * honour the signal, or give slow work its own timeout.
   *
   * This bounds ONE attempt, not `process()`: each attempt gets its own timer,
   * so a handler that keeps failing just under the limit is waited for through
   * every retry and backoff, and handlers run one after another. At the
   * defaults that can hold the response for about 90 s per handler.
   */
  handlerTimeoutMs?: number;
}

/** Passed to every handler attempt as its third argument. */
export interface WebhookHandlerContext {
  /**
   * Aborted when the attempt outlives `handlerTimeoutMs`. Pass it to `fetch`
   * (or check `signal.aborted`) so a slow attempt can stop; the engine waits
   * for the attempt to settle either way and never starts another copy of the
   * handler for this event meanwhile.
   */
  signal: AbortSignal;
}

type WebhookHandlerFn = (event: WebhookEvent, data: any, context: WebhookHandlerContext) => Promise<void>;

function invalidConfig(message: string): PayKitError {
  return new PayKitError(`Invalid WebhookEngine config: ${message}.`, "INVALID_CONFIG");
}

/**
 * Reject configuration that would silently weaken the engine: a tolerance
 * that disables replay protection by accident, a retry count under which no
 * handler runs, or caps that are not counts.
 */
function assertWebhookEngineConfig(config: WebhookEngineConfig): void {
  if (config.toleranceSeconds !== undefined) {
    const reason = toleranceSecondsError(config.toleranceSeconds);
    if (reason) throw invalidConfig(reason);
  }
  const { maxRetries, initialDelayMs, maxProcessedIds, maxDeadLetters } = config;
  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 1)) {
    throw invalidConfig(`maxRetries must be an integer >= 1 (attempts per handler), got ${maxRetries}`);
  }
  if (initialDelayMs !== undefined && (!Number.isFinite(initialDelayMs) || initialDelayMs < 0)) {
    throw invalidConfig(`initialDelayMs must be a finite number >= 0, got ${initialDelayMs}`);
  }
  if (config.handlerTimeoutMs !== undefined && (!Number.isFinite(config.handlerTimeoutMs) || config.handlerTimeoutMs < 0)) {
    throw invalidConfig(`handlerTimeoutMs must be a finite number >= 0 (0 = no limit), got ${config.handlerTimeoutMs}`);
  }
  for (const [name, value] of [["maxProcessedIds", maxProcessedIds], ["maxDeadLetters", maxDeadLetters]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw invalidConfig(`${name} must be an integer >= 0 (0 = unbounded), got ${value}`);
    }
  }
}

/**
 * Webhook processing engine.
 *
 * Register handlers, then call process() on incoming webhook payloads.
 *
 * Deduplication is best-effort and in-memory: the engine remembers the most
 * recent `maxProcessedIds` event IDs (default 10_000) in a bounded FIFO. That
 * keeps memory flat in a long-running process, but means an event replayed
 * after more than that many *other* distinct events have passed through is no
 * longer seen as a duplicate. The engine has no pluggable store; for strict,
 * durable or cross-instance exactly-once effects, enforce them in your
 * handlers against your own database, keyed on
 * `webhookDedupKey(provider, id)` — event ids are unique only per provider.
 *
 * @example
 * ```ts
 * const engine = new WebhookEngine();
 *
 * // Stripe puts the object in `data.object` (here, the PaymentIntent).
 * engine.on<{ object: { id: string } }>('payment.succeeded', async (event, data) => {
 *   await fulfillOrder(data.object.id);
 * });
 *
 * // In your Express/Next.js route (raw body — not re-serialised JSON):
 * try {
 *   const result = await engine.process({
 *     rawBody: req.rawBody,
 *     signature: req.headers['stripe-signature'],
 *     secret: process.env.STRIPE_WEBHOOK_SECRET,
 *     provider: 'stripe',
 *   });
 *   // Acknowledge only what is done: processed, or already processed.
 *   // "handler_failed" / "in_flight" must be non-2xx so Stripe redelivers.
 *   // `unhandled`: no handler matched. Still acknowledged, so log it.
 *   if (result.unhandled) console.warn(`No webhook handler for ${result.eventType}`);
 *   if (result.processed || result.error === 'duplicate_event') res.status(200).end();
 *   else res.status(503).json({ error: result.error });
 * } catch (err) {
 *   res.status(err instanceof WebhookSignatureError ? 400 : 500).end();
 * }
 * ```
 */
export class WebhookEngine {
  private handlers = new Map<string, WebhookHandlerFn[]>();
  /**
   * Recently-processed events, as `webhookDedupKey(provider, id)` keys. A JS
   * Set preserves insertion order, so the first element is always the oldest
   * — that is what we evict once the FIFO is full (`maxProcessedIds`). No
   * second data structure needed.
   */
  private processedIds = new Set<string>();
  /**
   * Dedup keys (provider + event id) of events whose handlers are running
   * right now. Checked and reserved in the
   * same synchronous segment as `processedIds` — no `await` in between (an
   * `await` there would let a second delivery see "not seen" too) — so of N
   * concurrent deliveries of one event exactly one dispatches. Released in a `finally`, whatever the handlers do.
   */
  private inFlightIds = new Set<string>();
  private deadLetters: Array<{ event: WebhookEvent; error: string; failedAt: Date }> = [];
  private config: Required<WebhookEngineConfig>;

  constructor(config: WebhookEngineConfig = {}) {
    assertWebhookEngineConfig(config);
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      initialDelayMs: config.initialDelayMs ?? 500,
      toleranceSeconds: config.toleranceSeconds ?? 300,
      maxProcessedIds: config.maxProcessedIds ?? 10_000,
      maxDeadLetters: config.maxDeadLetters ?? 1_000,
      allowUnsigned: config.allowUnsigned ?? false,
      handlerTimeoutMs: config.handlerTimeoutMs ?? 30_000,
    };
  }

  /**
   * Record an event ID as processed, evicting the oldest IDs first if the
   * bounded FIFO is full. Keeps `processedIds` from growing without limit.
   */
  private _rememberProcessed(dedupKey: string): void {
    this.processedIds.add(dedupKey);
    const cap = this.config.maxProcessedIds;
    if (cap > 0) {
      while (this.processedIds.size > cap) {
        const oldest = this.processedIds.values().next().value;
        if (oldest === undefined) break;
        this.processedIds.delete(oldest);
      }
    }
  }

  /**
   * Register a handler for one or more event types.
   *
   * @param eventType - A known event name, `customEvent(name)` for any other,
   *   '*' for all events, or an array of these. A misspelt known name does not
   *   compile: at runtime it would simply never match, and every delivery would
   *   be acknowledged with no handler run. A `*` handler matches every event,
   *   so with one registered `result.unhandled` is never set.
   * @param handler - Async handler function.
   */
  on<T = unknown>(
    eventType: WebhookSubscription | WebhookSubscription[],
    handler: (event: WebhookEvent, data: T, context: WebhookHandlerContext) => Promise<void>,
  ): this {
    const types = Array.isArray(eventType) ? eventType : [eventType];
    for (const type of types) {
      if (!this.handlers.has(type)) {
        this.handlers.set(type, []);
      }
      this.handlers.get(type)!.push(handler as any);
    }
    return this;
  }

  /**
   * Remove all handlers for an event type.
   */
  off(eventType: WebhookSubscription): this {
    this.handlers.delete(eventType);
    return this;
  }

  /**
   * Process an incoming webhook payload.
   *
   * Verifies signature (including replay-window / timestamp freshness), parses
   * the event, deduplicates, and dispatches handlers.
   *
   * Fails closed: a missing/empty `signature` when a `secret` is passed, or a
   * missing/empty `secret` (unless the engine was built with
   * `{ allowUnsigned: true }`), throws `WebhookSignatureError` before any
   * handler runs.
   *
   * @param options.timestamp - Optional "now" override, in UNIX seconds, used
   *   as the reference point for the replay-window check. Intended for testing;
   *   defaults to the current wall-clock time.
   */
  async process(options: {
    rawBody: string;
    signature?: string;
    secret?: string;
    provider: PaymentProvider;
    timestamp?: number;
  }): Promise<WebhookProcessResult> {
    const { rawBody, signature, secret, provider, timestamp } = options;

    // Signature verification (+ replay-window freshness check). Fail closed:
    // the only way past this block without a valid signature is an explicit
    // `allowUnsigned: true` AND no secret at all.
    if (secret) {
      if (!signature) {
        throw new WebhookSignatureError(provider, "missing_signature");
      }
      const verified = this._verifySignature(provider, rawBody, signature, secret, timestamp);
      if (!verified.ok) {
        throw new WebhookSignatureError(provider, verified.reason);
      }
    } else if (!this.config.allowUnsigned) {
      throw new WebhookSignatureError(provider, "missing_secret");
    }

    // Parse event. Valid JSON is not enough: `null`, an array or a scalar
    // has no fields to read, and must fail as a payload error, not a TypeError.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new PayKitError("Invalid JSON in webhook body", "INVALID_PAYLOAD", provider);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PayKitError("Webhook body must be a JSON object", "INVALID_PAYLOAD", provider);
    }

    const event = this._parseEvent(parsed as Record<string, unknown>, provider, rawBody, signature);

    // Dedup + reservation. From the processedIds check to inFlightIds.add()
    // there is NO await, so two concurrent deliveries of one event cannot both
    // observe "not seen" (an await here reopens that race). The loser gets `in_flight`, which a
    // route should answer non-2xx so the provider redelivers later: if the
    // winner then fails, the event is retried rather than lost.
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

    // The dispatch runs as a job that owns the reservation until EVERY attempt
    // it started has settled — so this process never runs a second copy of a
    // handler for this event while one may still be running. process() waits
    // for the job, but stops waiting if an attempt outlives handlerTimeoutMs:
    // it then answers `in_flight` (non-2xx, so the provider redelivers later)
    // while the job finishes in the background and records the real outcome.
    let signalTimeout!: () => void;
    const timedOut = new Promise<"timed_out">((resolve) => {
      signalTimeout = () => resolve("timed_out");
    });
    const job = this._dispatchAll(event, signalTimeout).then(
      (outcome) => {
        // Remember the id only when every handler completed; otherwise the
        // release below lets the provider's redelivery dispatch again (the
        // handlers that did succeed run again then — they must be idempotent).
        if (outcome.handlersFailed === 0) this._rememberProcessed(dedupKey);
        return outcome;
      },
    ).finally(() => {
      this.inFlightIds.delete(dedupKey);
    });

    const first = await Promise.race([job, timedOut]);
    if (first === "timed_out") {
      return {
        processed: false,
        eventId: event.id,
        eventType: event.type,
        handlersRun: 0,
        error: "in_flight",
      };
    }
    if (first.handlersFailed > 0) {
      return {
        processed: false,
        eventId: event.id,
        eventType: event.type,
        handlersRun: first.handlersRun,
        handlersFailed: first.handlersFailed,
        error: "handler_failed",
      };
    }
    return {
      processed: true,
      eventId: event.id,
      eventType: event.type,
      handlersRun: first.handlersRun,
      ...(first.handlersRun === 0 ? { unhandled: true } : {}),
    };
  }

  /**
   * Verify Stripe-style HMAC-SHA256 webhook signature (including the
   * replay-window freshness check). Returns `true` only if the signature is
   * valid AND the embedded timestamp is within `toleranceSeconds` of now.
   */
  verifyStripeSignature(
    rawBody: string,
    signature: string,
    secret: string,
  ): boolean {
    return this._verifySignature("stripe", rawBody, signature, secret).ok;
  }

  /**
   * Compute HMAC signature for constructing test webhooks.
   */
  computeSignature(
    rawBody: string,
    secret: string,
    timestamp?: number,
  ): string {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const payload = `${ts}.${rawBody}`;
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return `t=${ts},v1=${sig}`;
  }

  /**
   * Get dead-letter events (events where all handler retries failed), oldest
   * first. Every failed delivery is recorded, so an event that keeps failing
   * across provider redeliveries appears once per delivery. Only the most
   * recent `maxDeadLetters` (default 1,000) are kept.
   */
  getDeadLetters(): typeof this.deadLetters {
    return [...this.deadLetters];
  }

  /**
   * Clear the processed event ID cache. In-flight reservations are left alone:
   * they belong to deliveries still running, and dropping them would let a
   * concurrent duplicate dispatch.
   */
  clearProcessedCache(): void {
    this.processedIds.clear();
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Handlers for an event: its canonical type, its raw provider type when that
   * differs (so `on("payment_intent.succeeded")` still works), then `*`. A
   * Set keeps registration order and runs each handler function at most once,
   * even if it is registered under several names that match this event.
   */
  private _handlersFor(event: WebhookEvent): WebhookHandlerFn[] {
    const handlers = new Set([
      ...(this.handlers.get(event.type) ?? []),
      ...(event.providerType !== event.type ? this.handlers.get(event.providerType) ?? [] : []),
      ...(this.handlers.get("*") ?? []),
    ]);
    return [...handlers];
  }

  private _verifySignature(
    provider: PaymentProvider,
    rawBody: string,
    signature: string,
    secret: string,
    nowSeconds?: number,
  ): { ok: boolean; reason?: string } {
    if (!secret) return { ok: false, reason: "missing_secret" };
    if (!signature) return { ok: false, reason: "missing_signature" };
    try {
      if (provider === "stripe") {
        // Stripe format: "t=1234567890,v1=abc123...[,v1=def456...]"
        const header = parseStripeSignatureHeader(signature);
        if (!header) return { ok: false, reason: "malformed_signature_header" };

        const computed = crypto
          .createHmac("sha256", secret)
          .update(`${header.timestamp}.${rawBody}`)
          .digest("hex");

        // Any matching v1 is valid (Stripe sends one per secret while an
        // endpoint secret is rolled). Every candidate is compared — no early
        // exit — so timing does not reveal which one matched.
        let matched = false;
        for (const candidate of header.signatures) {
          if (this._safeHexEqual(computed, candidate)) matched = true;
        }
        if (!matched) {
          return { ok: false, reason: "signature_mismatch" };
        }

        // Replay-window / freshness check: reject signatures whose timestamp is
        // too far from now. Guards against replay of an old, validly-signed body.
        const replay = this._checkTimestampFreshness(header.timestamp, nowSeconds);
        if (!replay.ok) return replay;

        return { ok: true };
      }

      // Generic HMAC-SHA256 of the raw body. No timestamp is signed, so there is
      // no replay window here: see the module header and README.
      const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      const provided = signature.replace(/^sha256=/, "");
      return this._safeHexEqual(computed, provided)
        ? { ok: true }
        : { ok: false, reason: "signature_mismatch" };
    } catch {
      return { ok: false, reason: "verification_error" };
    }
  }

  /**
   * Constant-time comparison of our computed digest against a provided one.
   * The provided value must be exactly 64 lowercase hex characters FIRST:
   * `Buffer.from(hex)` silently truncates at the first non-hex character, so
   * "<valid digest>zz" would decode to the valid digest and pass. After that
   * check both buffers are 32 bytes, so `timingSafeEqual` cannot throw.
   */
  private _safeHexEqual(computed: string, provided: string): boolean {
    if (!isSha256HexDigest(provided)) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(provided, "hex"));
  }

  /**
   * Reject a signed payload whose embedded timestamp is outside the configured
   * tolerance window relative to `nowSeconds` (defaults to current time).
   * When `toleranceSeconds` is 0 the check is disabled. Delegates to the
   * shared `checkTimestampFreshness` (also used by the browser adapter, so
   * replay semantics cannot drift between environments).
   */
  private _checkTimestampFreshness(
    tsRaw: string,
    nowSeconds?: number,
  ): { ok: boolean; reason?: string } {
    return checkTimestampFreshness(tsRaw, this.config.toleranceSeconds, nowSeconds);
  }

  private _parseEvent(
    data: Record<string, unknown>,
    provider: PaymentProvider,
    rawBody: string,
    signature?: string,
  ): WebhookEvent {
    // No id → no deduplication possible. Reject rather than invent one: an
    // invented id is new on every redelivery, so handlers would run again.
    const id = webhookEventId(data, provider);
    if (id === null) {
      throw new PayKitError(
        `Webhook event has no id${provider === "stripe" ? "" : " (or eventId)"}; it cannot be deduplicated, so it is not processed`,
        "INVALID_PAYLOAD",
        provider,
      );
    }

    // Stripe event format: canonical PayKit type, Stripe's own type preserved.
    if (provider === "stripe") {
      const providerType = typeof data.type === "string" ? data.type : "unknown";
      const eventData = (data.data as Record<string, unknown>) ?? {};
      return {
        id,
        type: normalizeStripeEventType(providerType, eventData),
        providerType,
        provider: "stripe",
        livemode: (data.livemode as boolean) ?? false,
        createdAt: data.created
          ? new Date((data.created as number) * 1000)
          : new Date(),
        data: eventData,
        rawBody,
        signature,
      };
    }

    // Generic format (no name mapping)
    const genericType = ((data.type ?? data.event_type) as WebhookEventType) ?? "unknown";
    return {
      id,
      type: genericType,
      providerType: genericType,
      provider,
      livemode: (data.livemode as boolean) ?? false,
      createdAt: data.created_at
        ? new Date(data.created_at as string)
        : new Date(),
      data: (data.data ?? data) as Record<string, unknown>,
      rawBody,
      signature,
    };
  }

  /**
   * Run one handler with retry/backoff. Returns `true` if it completed, or
   * `false` once every attempt failed (the event is then dead-lettered).
   */
  /** Every matching handler, in order, each with retry. Never rejects. */
  private async _dispatchAll(
    event: WebhookEvent,
    onTimeout: () => void,
  ): Promise<{ handlersRun: number; handlersFailed: number }> {
    let handlersRun = 0;
    let handlersFailed = 0;
    for (const handler of this._handlersFor(event)) {
      if (await this._dispatchWithRetry(handler, event, onTimeout)) handlersRun++;
      else handlersFailed++;
    }
    return { handlersRun, handlersFailed };
  }

  /**
   * One handler attempt. Resolves or rejects when the HANDLER does — never
   * earlier — so a retry can only start after the previous attempt settled.
   * If it runs past `handlerTimeoutMs`, its `signal` is aborted (a handler
   * that passes it to `fetch` etc. can stop) and `onTimeout` tells process()
   * to stop waiting; the attempt itself is still awaited to its real outcome.
   */
  private async _attempt(handler: WebhookHandlerFn, event: WebhookEvent, onTimeout: () => void): Promise<void> {
    const controller = new AbortController();
    const ms = this.config.handlerTimeoutMs;
    const timer = ms
      ? setTimeout(() => {
          controller.abort(new Error(`handler exceeded handlerTimeoutMs (${ms}ms)`));
          onTimeout();
        }, ms)
      : undefined;
    try {
      await handler(event, event.data, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async _dispatchWithRetry(
    handler: WebhookHandlerFn,
    event: WebhookEvent,
    onTimeout: () => void,
  ): Promise<boolean> {
    let delay = this.config.initialDelayMs;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this._attempt(handler, event, onTimeout);
        return true;
      } catch (err: unknown) {
        lastError = err as Error;
        if (attempt < this.config.maxRetries) {
          // Full jitter: sleep a random amount in [delay/2, delay] so a burst of
          // failing handlers doesn't retry in lockstep (thundering herd).
          const jittered = delay / 2 + Math.random() * (delay / 2);
          await new Promise((resolve) => setTimeout(resolve, jittered));
          delay *= 2;
        }
      }
    }

    // All retries exhausted → dead letter (bounded FIFO, oldest dropped first)
    this.deadLetters.push({
      event,
      error: lastError?.message ?? "Unknown error",
      failedAt: new Date(),
    });
    const cap = this.config.maxDeadLetters;
    if (cap > 0 && this.deadLetters.length > cap) {
      this.deadLetters.splice(0, this.deadLetters.length - cap);
    }
    return false;
  }
}
