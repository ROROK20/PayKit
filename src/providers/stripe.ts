/**
 * Stripe payment provider adapter.
 *
 * Wraps the Stripe SDK behind the PayKit PaymentProvider_Interface.
 * Requires: npm install stripe — or pass the SDK's constructor as
 * `config.Stripe`.
 *
 * Loading: `stripe` is an optional peer dependency, loaded lazily the first
 * time the provider is constructed — in PayKit's CommonJS build through the
 * module's own `require` (so require hooks and test-runner mocks apply), in
 * its ES-module build with a dynamic `import()` (the ESM build once called a
 * `require` shim, which plain Node ESM does not have, so StripeProvider never
 * initialised there). See `importStripe` below. Only "the `stripe` package itself is not installed"
 * downgrades to a warning and `NOT_INITIALIZED`; any other load failure (a
 * broken install, a missing transitive dependency) rejects `ready()` and every
 * call with the original error. `await provider.ready()` at startup to fail
 * fast.
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY — Stripe secret key (sk_live_... or sk_test_...), read
 *                       when `secretKey` is not passed. It is the only
 *                       environment variable this adapter reads.
 *
 * API version: pinned to 2024-06-20 — the version this adapter's request
 * mapping is written and tested against — unless `apiVersion` is passed.
 * Nothing else changes it: there is no `STRIPE_API_VERSION` variable.
 *
 * Network: stripe-node's `timeout` and `maxNetworkRetries` are always set
 * (defaults 20 s and 1 here; stripe-node's own are 80 s and, in current
 * versions, 2), so the longest a call can take is known — see
 * `StripeProviderConfig.timeoutMs` for why that matters to idempotency.
 */

import {
  PaymentProvider_Interface,
  PaymentProvider,
  PaymentIntent,
  CreatePaymentRequest,
  RefundRequest,
  RefundResult,
  PaymentStatus,
  ProviderError,
  PayKitError,
  IdempotencyError,
} from "../types/index";
import { assertIdempotencyKey, assertRefundKey, assertValidMoney } from "../payments/idempotent";

/**
 * Stripe PaymentIntent.status → PayKit status. Never `refunded` or
 * `partially_refunded`: a PaymentIntent has no such status and stays `succeeded`
 * after a refund (see `PaymentStatus`). `MockProvider` differs here.
 */
function mapStripeStatus(status: string): PaymentStatus {
  const map: Record<string, PaymentStatus> = {
    requires_payment_method: "pending",
    requires_confirmation: "pending",
    requires_action: "pending",
    processing: "processing",
    succeeded: "succeeded",
    canceled: "cancelled",
    requires_capture: "processing",
  };
  return Object.prototype.hasOwnProperty.call(map, status) ? map[status] : "pending";
}

/**
 * Stripe Refund.status → PayKit RefundResult.status. `requires_action` is not
 * settled yet, so it is pending; an unknown future status is reported pending
 * rather than claimed as an outcome.
 */
function mapStripeRefundStatus(status: string): RefundResult["status"] {
  const map: Record<string, RefundResult["status"]> = {
    succeeded: "succeeded",
    pending: "pending",
    requires_action: "pending",
    failed: "failed",
    canceled: "cancelled",
  };
  return Object.prototype.hasOwnProperty.call(map, status) ? map[status] : "pending";
}

/**
 * What a Stripe error says beyond its code. stripe-node puts `decline_code` and
 * the full `payment_intent` on the error; the intent's `client_secret` stays
 * behind, so a logged error cannot leak it.
 */
function stripeErrorDetails(err: any): { declineCode?: string; paymentIntentId?: string } {
  const declineCode = typeof err.decline_code === "string" && err.decline_code.length > 0 ? err.decline_code : undefined;
  const id = err.payment_intent?.id;
  return { declineCode, paymentIntentId: typeof id === "string" ? id : undefined };
}

/**
 * The `paymentIntents.create` parameters for a PayKit request — or a
 * non-retryable `INVALID_REQUEST` thrown before any network call when the
 * request cannot be expressed to Stripe.
 *
 * Without a payment method the intent is created unconfirmed and the customer
 * confirms in the browser with Stripe.js. With one, the adapter confirms
 * server-side (`confirm=true`), and since API version 2023-08-16 — automatic
 * payment methods on by default — Stripe then requires a `return_url` unless
 * `off_session=true`, or unless `automatic_payment_methods[allow_redirects]`
 * is `never`, which filters out redirect-based payment methods. So:
 *
 * | request                         | sent besides amount/currency/…                          |
 * |---------------------------------|---------------------------------------------------------|
 * | no `paymentMethodId`            | `confirm=false`, `automatic_payment_methods.enabled`    |
 * | `paymentMethodId`               | `confirm=true`, `allow_redirects: "never"`               |
 * | `paymentMethodId` + `returnUrl` | `confirm=true`, `return_url` (redirects allowed)         |
 * | `paymentMethodId` + `offSession`| `confirm=true`, `off_session=true` (redirects allowed)   |
 *
 * `automatic_payment_methods` is always sent explicitly, so the mapping does
 * not depend on the account's or the pinned API version's default. Any of these
 * can also carry `captureMethod`, sent as `capture_method`.
 */
function paymentIntentCreateParams(request: CreatePaymentRequest): Record<string, unknown> {
  const confirm = !!request.paymentMethodId;
  const offSession = request.offSession === true;
  // Stripe accepts `return_url` and `off_session` only together with
  // `confirm=true`, and this adapter confirms only when given a payment
  // method. Refuse rather than send a request Stripe rejects — or silently
  // drop a parameter the caller asked for.
  if (request.returnUrl && !confirm) {
    throw new PayKitError(
      "returnUrl requires paymentMethodId: Stripe accepts return_url only with confirm=true, which StripeProvider sets only when a payment method is given. Without one, pass return_url to stripe.confirmPayment() in the browser.",
      "INVALID_REQUEST",
      "stripe",
    );
  }
  if (offSession && !confirm) {
    throw new PayKitError(
      "offSession requires paymentMethodId: an off-session charge confirms a saved payment method server-side (off_session=true needs confirm=true), so name the method to charge.",
      "INVALID_REQUEST",
      "stripe",
    );
  }
  const redirectsAllowed = !confirm || !!request.returnUrl || offSession;
  return {
    amount: request.amount.amount,
    currency: request.amount.currency.toLowerCase(),
    description: request.description,
    metadata: request.metadata ?? {},
    customer: request.customerId,
    payment_method: request.paymentMethodId,
    confirm,
    off_session: offSession ? true : undefined,
    return_url: confirm ? request.returnUrl : undefined,
    capture_method: request.captureMethod,
    automatic_payment_methods: redirectsAllowed
      ? { enabled: true }
      : { enabled: true, allow_redirects: "never" },
  };
}

/** For a failure after which the request may still have taken effect at Stripe. */
const OUTCOME_UNKNOWN = { outcomeUnknown: true };

/** Default per-attempt HTTP timeout handed to stripe-node, in ms. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Default stripe-node network retries per call (on top of the first attempt). */
const DEFAULT_MAX_NETWORK_RETRIES = 1;

/** The part of the stripe-node constructor this adapter uses. */
export type StripeConstructor = new (secretKey: string, config: Record<string, unknown>) => any;

export interface StripeProviderConfig {
  /** Secret key; falls back to the `STRIPE_SECRET_KEY` environment variable. */
  secretKey?: string;
  /**
   * The stripe-node constructor (`import Stripe from "stripe"`), used instead
   * of loading the package. The adapter still constructs the client itself,
   * with its pinned `apiVersion`, `timeoutMs` and `maxNetworkRetries`.
   */
  Stripe?: StripeConstructor;
  /** Stripe API version. Default `"2024-06-20"` (no environment fallback). */
  apiVersion?: string;
  /**
   * Per-attempt HTTP timeout in ms, passed to stripe-node as `timeout`.
   * Default 20_000 (stripe-node's own default is 80_000). A positive integer.
   *
   * It bounds how long one `createPayment` holds an idempotency reservation:
   * at most `(1 + maxNetworkRetries) × timeoutMs` plus stripe-node's retry
   * sleeps (0.5 s before its first retry). `IdempotentPaymentExecutor` retries
   * on top, so a shared store's pending-marker TTL must exceed
   * `maxAttempts × that` plus the executor's backoff — at the defaults,
   * 3 × (2 × 20 s + 0.5 s) + 0.6 s ≈ 122 s. A marker that expires mid-call
   * lets a second caller reserve the key while the first is still charging.
   */
  timeoutMs?: number;
  /**
   * stripe-node `maxNetworkRetries`: how many times the SDK itself re-sends a
   * failed request (same idempotency key) before the error reaches PayKit.
   * Default 1. A non-negative integer. Even at 0, stripe-node retries a
   * dropped connection (ECONNRESET) once — measured against stripe-node
   * 22.6.2 in tests/stripe_real_sdk.test.ts.
   */
  maxNetworkRetries?: number;
}

function assertStripeConfig(config: StripeProviderConfig): void {
  const { timeoutMs, maxNetworkRetries } = config;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new PayKitError(
      `Invalid StripeProvider config: timeoutMs must be a positive integer number of milliseconds, got ${timeoutMs}.`,
      "INVALID_CONFIG",
      "stripe",
    );
  }
  if (maxNetworkRetries !== undefined && (!Number.isInteger(maxNetworkRetries) || maxNetworkRetries < 0)) {
    throw new PayKitError(
      `Invalid StripeProvider config: maxNetworkRetries must be a non-negative integer, got ${maxNetworkRetries}.`,
      "INVALID_CONFIG",
      "stripe",
    );
  }
}

/**
 * True only when the `stripe` package ITSELF could not be found — CommonJS
 * `MODULE_NOT_FOUND` ("Cannot find module 'stripe'") or ESM
 * `ERR_MODULE_NOT_FOUND` ("Cannot find package 'stripe'"). A missing
 * dependency of stripe, or a stripe whose entry file is gone, names another
 * module and is a broken install, not an absent optional peer.
 */
function isStripeNotInstalled(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") return false;
  return typeof message === "string" && /^Cannot find (module|package) 'stripe'/.test(message);
}

/**
 * The peer dependency's specifier, held in a variable: a string literal would
 * make TypeScript demand stripe's types at build time. The magic comments
 * keep bundlers (webpack, Vite) from resolving it at bundle time, so a
 * consumer that never installs stripe still bundles PayKit; at runtime the
 * import resolves from PayKit's own location, as a peer dependency should.
 */
const STRIPE_SPECIFIER = "stripe";

/**
 * CommonJS (PayKit's `dist/index.js`, or sources under ts-jest) loads stripe
 * through the module's own `require`, so require hooks and test-runner mocks
 * (`jest.mock("stripe")`) apply — a native `import()` inside CommonJS
 * bypasses both, and jest cannot run one without
 * `--experimental-vm-modules`. An ES module has no `module` binding; there the
 * native dynamic `import()` is the only way to load a package lazily.
 */
async function importStripe(): Promise<StripeConstructor> {
  const cjsRequire =
    typeof module !== "undefined" && module !== null && typeof module.require === "function" ? module.require.bind(module) : null;
  const mod: any = cjsRequire
    ? cjsRequire(STRIPE_SPECIFIER)
    : await import(/* webpackIgnore: true */ /* @vite-ignore */ STRIPE_SPECIFIER);
  return (mod && mod.default) ?? mod;
}

export class StripeProvider implements PaymentProvider_Interface {
  readonly name: PaymentProvider = "stripe";
  private stripe: any | null = null;
  private config: StripeProviderConfig;
  /** The client once built; `null` when unconfigured or stripe is absent. */
  private readonly client: Promise<any | null>;

  constructor(config: StripeProviderConfig = {}) {
    assertStripeConfig(config);
    this.config = config;
    this.client = this._initStripe();
    // A load failure is reported by ready() and by every call; marking the
    // promise handled keeps it from also crashing the process as an
    // unhandled rejection when nothing has called the provider yet.
    this.client.catch(() => undefined);
  }

  /**
   * Resolves `true` once the Stripe client is built, `false` when it never
   * will be — no secret key, or the `stripe` package is not installed (both
   * warn, and every call then fails `NOT_INITIALIZED`). Rejects with the
   * original error for any other failure to load or construct the SDK.
   */
  async ready(): Promise<boolean> {
    return (await this.client) !== null;
  }

  private async _initStripe(): Promise<any | null> {
    const key = this.config.secretKey ?? process.env["STRIPE_SECRET_KEY"] ?? "";
    if (!key) {
      console.warn(
        "[PayKit/Stripe] No secret key configured. Set STRIPE_SECRET_KEY env var or pass secretKey to StripeProvider.",
      );
      return null;
    }
    let Stripe = this.config.Stripe;
    if (!Stripe) {
      try {
        Stripe = await importStripe();
      } catch (err) {
        if (isStripeNotInstalled(err)) {
          console.warn("[PayKit/Stripe] stripe package not installed. Run: npm install stripe");
          return null;
        }
        throw err;
      }
    }
    this.stripe = new Stripe(key, {
      apiVersion: this.config.apiVersion ?? "2024-06-20",
      timeout: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxNetworkRetries: this.config.maxNetworkRetries ?? DEFAULT_MAX_NETWORK_RETRIES,
    });
    return this.stripe;
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentIntent> {
    // Before anything else: without a key, stripe-node sends a random one per
    // call, so Stripe could not deduplicate a retry at all.
    assertIdempotencyKey(request.idempotencyKey, "stripe");
    const stripe = await this._stripe();
    const params = paymentIntentCreateParams(request);
    try {
      const pi = await stripe.paymentIntents.create(params, {
        idempotencyKey: request.idempotencyKey,
      });
      return this._mapIntent(pi, request.idempotencyKey);
    } catch (err: any) {
      throw this._mapError(err, request.idempotencyKey);
    }
  }

  async capturePayment(paymentId: string): Promise<PaymentIntent> {
    const stripe = await this._stripe();
    try {
      const pi = await stripe.paymentIntents.capture(paymentId);
      return this._mapIntent(pi);
    } catch (err: any) {
      throw this._mapError(err);
    }
  }

  async cancelPayment(paymentId: string): Promise<PaymentIntent> {
    const stripe = await this._stripe();
    try {
      const pi = await stripe.paymentIntents.cancel(paymentId);
      return this._mapIntent(pi);
    } catch (err: any) {
      throw this._mapError(err);
    }
  }

  /**
   * Refund a PaymentIntent: in full when `amount` is absent, otherwise that
   * many minor units. A partial `amount` must be a positive integer
   * (`INVALID_AMOUNT` — 0 is an error, never a full refund) in the payment's
   * own currency: Stripe's refund takes only a number, so the adapter first
   * retrieves the PaymentIntent and refuses a mismatch (`INVALID_REQUEST`)
   * rather than refund 1500 cents of a USD payment for "1500 EUR". Both checks
   * run before any refund is created.
   */
  async refundPayment(request: RefundRequest): Promise<RefundResult> {
    const stripe = await this._stripe();
    assertRefundKey(request, "stripe");
    if (request.amount) {
      if (request.amount.amount === 0) {
        throw new PayKitError(
          "Invalid refund amount: 0. A partial refund must be at least 1 minor unit; omit amount for a full refund.",
          "INVALID_AMOUNT",
          "stripe",
        );
      }
      assertValidMoney(request.amount.amount, request.amount.currency);
      let paymentCurrency: string;
      try {
        paymentCurrency = (await stripe.paymentIntents.retrieve(request.paymentId)).currency;
      } catch (err: any) {
        throw this._mapError(err);
      }
      if (paymentCurrency.toUpperCase() !== request.amount.currency.toUpperCase()) {
        throw new PayKitError(
          `Refund currency ${request.amount.currency.toUpperCase()} does not match payment ${request.paymentId} in ${paymentCurrency.toUpperCase()}; Stripe refunds in the payment's currency.`,
          "INVALID_REQUEST",
          "stripe",
        );
      }
    }
    try {
      const refundParams: Record<string, unknown> = {
        payment_intent: request.paymentId,
      };
      if (request.amount) refundParams.amount = request.amount.amount;
      if (request.reason) refundParams.reason = request.reason;

      const refund = await stripe.refunds.create(refundParams, { idempotencyKey: request.idempotencyKey });

      return {
        refundId: refund.id,
        paymentId: request.paymentId,
        amount: {
          amount: refund.amount,
          currency: refund.currency.toUpperCase(),
        },
        status: mapStripeRefundStatus(refund.status),
        createdAt: new Date(refund.created * 1000),
      };
    } catch (err: any) {
      throw this._mapError(err, request.idempotencyKey);
    }
  }

  async getPayment(paymentId: string): Promise<PaymentIntent> {
    const stripe = await this._stripe();
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentId);
      return this._mapIntent(pi);
    } catch (err: any) {
      throw this._mapError(err);
    }
  }

  async listPayments(options: { limit?: number; startingAfter?: string } = {}): Promise<PaymentIntent[]> {
    const stripe = await this._stripe();
    try {
      const list = await stripe.paymentIntents.list({
        limit: options.limit ?? 10,
        starting_after: options.startingAfter,
      });
      return list.data.map((pi: any) => this._mapIntent(pi));
    } catch (err: any) {
      throw this._mapError(err);
    }
  }

  private _mapIntent(pi: any, idempotencyKey = ""): PaymentIntent {
    return {
      id: pi.id,
      idempotencyKey,
      provider: "stripe",
      status: mapStripeStatus(pi.status),
      amount: {
        amount: pi.amount,
        currency: pi.currency.toUpperCase(),
      },
      metadata: pi.metadata,
      createdAt: new Date(pi.created * 1000),
      updatedAt: new Date(),
      providerPaymentId: pi.id,
      clientSecret: pi.client_secret ?? undefined,
      errorCode: pi.last_payment_error?.code,
      errorMessage: pi.last_payment_error?.message,
    };
  }

  /**
   * Map a Stripe SDK error. Only failures that can succeed on an identical
   * retry are `retryable`: a reused-key conflict, bad credentials or missing
   * permissions fail the same way every time, so retrying them only burns
   * attempts (and rate limit). A key still in use by an in-flight request is
   * the exception that IS retryable.
   */
  private _mapError(err: any, idempotencyKey?: string): PayKitError {
    // Stripe's `idempotency_key_in_use`: another request with this key is
    // still executing — typically the attempt this retry follows, after a
    // client-side timeout. Not a parameter conflict, and retrying under the
    // same key is how to collect its result. Checked before the error type,
    // whatever class stripe-node raises it as.
    if (err?.code === "idempotency_key_in_use") {
      return new ProviderError(
        err.message ?? "Another request with this idempotency key is in progress",
        "idempotency_key_in_use",
        "stripe",
        true,
        undefined,
        OUTCOME_UNKNOWN,
      );
    }
    if (err?.type === "StripeIdempotencyError") {
      return new IdempotencyError(idempotencyKey ?? "unknown", "stripe");
    }
    if (err?.type === "StripeAuthenticationError") {
      return new ProviderError(err.message ?? "Stripe authentication failed", "authentication_error", "stripe", false);
    }
    if (err?.type === "StripePermissionError") {
      return new ProviderError(err.message ?? "Stripe permission denied", "permission_error", "stripe", false);
    }
    if (err?.type === "StripeCardError") {
      return new ProviderError(err.message, err.code ?? "card_error", "stripe", false, err.param, stripeErrorDetails(err));
    }
    if (err?.type === "StripeRateLimitError") {
      return new ProviderError("Rate limited by Stripe", "rate_limit", "stripe", true);
    }
    // Keep Stripe's own code (resource_missing, charge_already_refunded,
    // parameter_invalid_integer, …) — what callers branch on — and expose the
    // offending parameter separately.
    if (err?.type === "StripeInvalidRequestError") {
      return new ProviderError(err.message, err.code ?? "invalid_request", "stripe", false, err.param, stripeErrorDetails(err));
    }
    // stripe-node raises StripeConnectionError when no response arrived: a
    // timeout (its detail carries ETIMEDOUT) or a network failure. Either can
    // follow a charge that did happen, so both are retryable — under the same
    // idempotency key, which makes the retry safe.
    if (err?.type === "StripeConnectionError") {
      const timedOut = err.detail?.code === "ETIMEDOUT" || /timeout/i.test(String(err.message ?? ""));
      return timedOut
        ? new ProviderError(err.message ?? "Stripe request timed out", "timeout", "stripe", true, undefined, OUTCOME_UNKNOWN)
        : new ProviderError(err.message ?? "Could not reach Stripe", "network_error", "stripe", true, undefined, OUTCOME_UNKNOWN);
    }
    // StripeAPIError: Stripe's side failed (5xx, or a status stripe-node does
    // not classify, e.g. a 409 lock timeout). Re-sending under the same key
    // cannot charge twice and can clear a 503 or a lock timeout, so it stays
    // retryable. It need not settle a 500: stripe-node's RequestSender.js says
    // Stripe's idempotency framework "would typically replay" one, so the key
    // can keep answering 500 while the outcome stays unknown. Read from that
    // source, not observed against live Stripe. See the README for what to do.
    if (err?.type === "StripeAPIError") {
      return new ProviderError(err.message ?? "Stripe API error", "server_error", "stripe", true, undefined, OUTCOME_UNKNOWN);
    }
    // Anything else is not a Stripe API outcome PayKit understands (a bug, an
    // SDK error): report it, do not retry it blindly. Re-sending the same key
    // later is still safe. It can follow a charge that did happen.
    return new ProviderError(err?.message ?? "Unknown error", "unknown", "stripe", false, undefined, OUTCOME_UNKNOWN);
  }

  /**
   * The Stripe client, awaited before every call and outside each call's
   * error mapping: a load failure surfaces as itself, never relabelled as a
   * (retryable) Stripe API error.
   */
  private async _stripe(): Promise<any> {
    const stripe = await this.client;
    if (!stripe) {
      throw new PayKitError(
        "Stripe not initialized: no secret key (STRIPE_SECRET_KEY) or the stripe package is not installed.",
        "NOT_INITIALIZED",
        "stripe",
      );
    }
    return stripe;
  }
}
