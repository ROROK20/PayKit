/**
 * PayKit core type definitions.
 */

// ─── Payment Types ───────────────────────────────────────────────────────────

export type Currency = "USD" | "EUR" | "GBP" | "CAD" | "AUD" | string;

/**
 * `refunded` and `partially_refunded` come from `MockProvider`, whose payments
 * change status when refunded, and from your own ledger. `StripeProvider` never
 * returns them: a Stripe PaymentIntent stays `succeeded` after a refund, so that is
 * what `getPayment` says. Against Stripe, learn of a refund from `refundPayment`'s
 * result, a `charge.refunded` webhook or a Charge's `amount_refunded`. A branch on
 * these statuses that passes against the mock never fires in production.
 */
export type PaymentStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "refunded"
  | "partially_refunded";

/**
 * Provider identifiers. Only `stripe` (`StripeProvider`) and `mock`
 * (`MockProvider`) have adapters. `plaid` and `wise` are labels for
 * reconciliation records and the generic webhook path only — there is no
 * Plaid or Wise adapter, and the generic HMAC check does not implement
 * Plaid's (JWT) or Wise's (RSA) webhook signature schemes.
 *
 * Any other string is valid too, for your own adapter (`readonly name = "adyen"`);
 * the odd-looking member is what keeps the known names in autocomplete, which a
 * plain `| string` would erase. The name labels errors and events, and it is half
 * of what the idempotency store is scoped by, so give each adapter its own.
 */
export type PaymentProvider = "stripe" | "plaid" | "wise" | "mock" | (string & Record<never, never>);

export interface Money {
  /** Amount in the smallest currency unit (cents for USD) */
  amount: number;
  currency: Currency;
}

export interface PaymentIntent {
  id: string;
  idempotencyKey: string;
  provider: PaymentProvider;
  status: PaymentStatus;
  amount: Money;
  metadata?: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
  providerPaymentId?: string;
  /**
   * Stripe's `client_secret` for this PaymentIntent — what Stripe.js needs on
   * the client to confirm the payment. Hand it only to the paying customer's
   * browser; never log it or put it in a URL. (MockProvider returns a fake.)
   */
  clientSecret?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface CreatePaymentRequest {
  amount: Money;
  idempotencyKey: string;
  description?: string;
  metadata?: Record<string, string>;
  customerId?: string;
  /**
   * A saved or freshly collected payment method to charge now. With it,
   * `StripeProvider` confirms server-side (`confirm=true`) and the result is
   * the confirmation's outcome; without it, the PaymentIntent is created
   * unconfirmed (`pending`, Stripe's `requires_payment_method`) and the
   * customer confirms in the browser with Stripe.js using `clientSecret`. A
   * method attached to a Stripe Customer also needs that `customerId`.
   */
  paymentMethodId?: string;
  /**
   * Where the customer is sent back after authenticating (3-D Secure, bank
   * redirects). `StripeProvider` requires `paymentMethodId` alongside it:
   * Stripe accepts `return_url` only when confirming (`confirm=true`), and the
   * adapter confirms only when given a payment method. Otherwise it throws
   * `INVALID_REQUEST` — pass the URL to `stripe.confirmPayment()` instead.
   * Confirming on-session WITHOUT a return URL limits the payment to methods
   * that never redirect (Stripe's `allow_redirects: "never"`), cards included.
   */
  returnUrl?: string;
  /**
   * The customer is not present and cannot authenticate — a renewal or other
   * merchant-initiated charge of a saved payment method. `StripeProvider`
   * sends `off_session=true` with `confirm=true` and requires
   * `paymentMethodId` (otherwise `INVALID_REQUEST`). If the bank demands
   * authentication anyway, Stripe declines with code `authentication_required`
   * (a non-retryable `ProviderError`): bring the customer back on-session with
   * the PaymentIntent the decline left behind, `err.paymentIntentId`. Replaying
   * the same key only replays the decline.
   */
  offSession?: boolean;
  /**
   * `"manual"` authorizes now and leaves the money to `capturePayment(id)`
   * (Stripe's `capture_method`). The result then reads `"processing"`, PayKit's
   * name for `requires_capture`, until it is captured. An authorization expires
   * if not captured in time; Stripe's window depends on the payment method.
   * Absent, Stripe's default applies, and `capturePayment` has nothing to capture.
   */
  captureMethod?: "automatic" | "manual";
}

export interface RefundRequest {
  paymentId: string;
  amount?: Money; // partial refund if specified, full refund otherwise
  reason?: "duplicate" | "fraudulent" | "requested_by_customer" | string;
  /**
   * Required. What makes a retried refund refund once: the provider replays
   * the first result for a key it has seen (Stripe for at least 24h). Derive
   * it from YOUR refund request — a support ticket, a row in a refunds table
   * — never from the clock (a new key per attempt is a double refund) nor from
   * (payment, amount) alone (that would merge two legitimate equal partial
   * refunds). There is no safe default, so there is none.
   */
  idempotencyKey: string;
}

export interface RefundResult {
  refundId: string;
  paymentId: string;
  amount: Money;
  /** Stripe's `requires_action` maps to `pending`; `canceled` to `cancelled`. */
  status: "succeeded" | "pending" | "failed" | "cancelled";
  createdAt: Date;
}

// ─── Webhook Types ───────────────────────────────────────────────────────────

/**
 * The event names `WebhookEngine.on()` accepts as plain strings: PayKit's
 * canonical names, and the Stripe names behind them. For Stripe events the
 * engine maps Stripe's own type to the canonical one (see
 * `normalizeStripeEventType`) and runs handlers registered under either; the
 * comment on each canonical name gives its Stripe source. Any other event goes
 * through `customEvent()`, so a misspelt name here does not compile.
 */
export type KnownWebhookEventType =
  | "payment.succeeded" // Stripe: payment_intent.succeeded
  | "payment.failed" // Stripe: payment_intent.payment_failed
  | "payment.processing" // Stripe: payment_intent.processing
  | "payment.cancelled" // Stripe: payment_intent.canceled
  | "refund.created" // Stripe: refund.created (same name)
  | "refund.succeeded" // never fires for Stripe, which has no such event and PayKit derives none; other providers may send it. For Stripe use refund.updated / refund.failed / charge.refunded
  | "dispute.created" // Stripe: charge.dispute.created
  | "dispute.updated" // Stripe: charge.dispute.updated
  | "dispute.won" // Stripe: charge.dispute.closed with status "won"
  | "dispute.lost" // Stripe: charge.dispute.closed with status "lost"
  | "payment_intent.succeeded"
  | "payment_intent.payment_failed"
  | "payment_intent.processing"
  | "payment_intent.canceled"
  | "charge.dispute.created"
  | "charge.dispute.updated"
  | "charge.dispute.closed"
  | "charge.refunded" // Stripe, unmapped: keeps this name
  | "refund.updated" // Stripe, unmapped: keeps this name
  | "refund.failed"; // Stripe, unmapped: keeps this name

/**
 * The type on `WebhookEvent.type` and in results: whatever the sender called
 * the event. It has to stay open, because a provider can send anything. It is
 * NOT what handlers register with; see `WebhookSubscription`.
 */
export type WebhookEventType = KnownWebhookEventType | string;

declare const customWebhookEvent: unique symbol;

/** An event name you vouched for with `customEvent()`. A plain string is not one. */
export type CustomWebhookEventType = string & { readonly [customWebhookEvent]: true };

/** What a webhook handler can register under: a known name, `customEvent(name)`, or `*`. */
export type WebhookSubscription = KnownWebhookEventType | CustomWebhookEventType | "*";

export interface WebhookEvent {
  id: string;
  /** Canonical PayKit type (e.g. `payment.succeeded`). */
  type: WebhookEventType;
  /**
   * The provider's own event type, unmodified (e.g. Stripe's
   * `payment_intent.succeeded`). Equals `type` when no mapping applies.
   */
  providerType: string;
  provider: PaymentProvider;
  livemode: boolean;
  createdAt: Date;
  data: Record<string, unknown>;
  rawBody: string;
  signature?: string;
}

export interface WebhookHandler<T = unknown> {
  eventType: WebhookSubscription | WebhookSubscription[];
  handle(event: WebhookEvent, data: T): Promise<void>;
}

export interface WebhookProcessResult {
  /**
   * True when no matching handler failed. Acknowledge (2xx). That includes an
   * event with no matching handler at all, which sets `unhandled`.
   */
  processed: boolean;
  eventId: string;
  eventType: WebhookEventType;
  /** Handlers that completed successfully for this delivery. */
  handlersRun: number;
  /**
   * True when `processed` is true and NO handler matched: the event was
   * verified and nothing ran. Providers send event types you may simply not
   * care about, so this is still acknowledged, and the event id is remembered
   * like any other. But it is also what a handler registered under the wrong
   * name looks like, so log it: once 2xx is answered the provider stops
   * retrying, and the event is gone. Absent otherwise. A `*` handler matches
   * every event, so with one registered this is never set.
   */
  unhandled?: boolean;
  /** Handlers that exhausted their retries (set with `handler_failed`). */
  handlersFailed?: number;
  /**
   * Set when `processed` is false:
   * - `duplicate_event` — this id was already processed; acknowledge (2xx).
   * - `in_flight` — another delivery of this id is still running; answer
   *   non-2xx so the provider redelivers later.
   * - `handler_failed` — a handler exhausted its retries (see dead letters).
   *   The id was NOT marked processed; answer non-2xx so the provider
   *   redelivers and the handlers run again.
   */
  error?: string;
}

// ─── Reconciliation Types ────────────────────────────────────────────────────

export type ReconciliationStatus =
  | "matched"
  | "unmatched_internal"
  | "unmatched_provider"
  | "amount_mismatch"
  | "currency_mismatch"
  /** Amount and currency agree but the outcomes differ (e.g. succeeded vs failed). */
  | "status_mismatch"
  /** The two sides state different refunded totals; `amountDiscrepancy` is the gap. */
  | "refund_mismatch"
  /**
   * Both sides say partially refunded, but at least one does not state how much
   * (`amountRefunded`), so a wrong or doubled refund cannot be ruled out.
   */
  | "refund_unverified"
  /** Everything else agrees, but both sides carry a `reference` and they differ. */
  | "reference_mismatch"
  | "duplicate"
  /**
   * The record itself is unusable — an amount that is not a safe integer
   * (NaN, undefined, Infinity, 1.5), a malformed currency, a missing id or
   * status — so it is reported and never matched to anything.
   */
  | "invalid";

export interface InternalRecord {
  id: string;
  providerPaymentId?: string;
  amount: Money;
  status: PaymentStatus;
  createdAt: Date;
  /**
   * Refunded so far, in integer minor units of `amount`'s currency: what lets a
   * partial refund be checked against the provider's. See
   * `ProviderRecord.amountRefunded` for how it is read and validated.
   */
  amountRefunded?: number;
  /**
   * Free-form reference of yours (an order number, an invoice id), naming what
   * ONE charge pays for. It never decides which records pair, but once a pair is made a
   * `ProviderRecord.reference` that differs from this one is a
   * `reference_mismatch`. Two provider charges under
   * one reference that may both hold money (a debit in flight and a live hold
   * included) are flagged as a possible double
   * charge; an order that legitimately takes several payments should carry one
   * reference per payment. It is also quoted in the notes of a duplicate-id
   * report. If present it must be a non-empty string, or the record is `invalid`.
   */
  reference?: string;
}

export interface ProviderRecord {
  id: string;
  amount: Money;
  status: string;
  createdAt: Date;
  metadata?: Record<string, string>;
  /**
   * Refunded so far, in integer minor units of `amount`'s currency: a Stripe
   * Charge's `amount_refunded`. Pass it next to the raw status: a Stripe
   * PaymentIntent or Charge stays `succeeded` after a refund, so a `succeeded`
   * row stating a total above 0 reads as partially or fully refunded.
   *
   * Absent means the row does not say. A `refunded` status then implies the
   * whole amount, and a `partially_refunded` pair cannot be verified
   * (`refund_unverified`); any other row claims no refund. It must be a safe
   * integer from 0 to the size of `amount`, and agree with a `refunded` or
   * `partially_refunded` status, or the record is `invalid`.
   */
  amountRefunded?: number;
  /**
   * The same reference as `InternalRecord.reference`, when the provider's row
   * carries it (say, a PaymentIntent's `metadata.orderId`). It wins over the
   * reference of the internal record claiming this charge, and it is what lets
   * a double charge your ledger never recorded be seen at all. If the record
   * paired with this one carries a different reference, the pair is a
   * `reference_mismatch`: the charge may be paying for the wrong order.
   */
  reference?: string;
}

export interface ReconciliationMatch {
  internalId?: string;
  providerId?: string;
  status: ReconciliationStatus;
  amountDiscrepancy?: Money;
  /**
   * Additive annotation: this record looks like a duplicate — an internal
   * record that claims a provider charge already claimed, or has no
   * `providerPaymentId` and shares amount + currency + UTC day with another
   * internal record; a provider record whose id already appeared earlier in
   * the provider records (only the first is reconciled); or a possible double
   * charge. Kept separate from `status` so a duplicate that is ALSO an
   * amount/currency mismatch retains its primary status instead of being
   * silently overwritten.
   */
  duplicate?: boolean;
  /**
   * This charge shares its reference with an earlier charge that still holds
   * money: possibly one order paid twice. Always set with `duplicate`; `notes`
   * names the earlier charge.
   */
  possibleDoubleCharge?: boolean;
  notes: string;
}

/**
 * What a reconciliation run amounts to. Only `perfect` is an all-clear.
 * - `perfect` — both sides had records and every comparison the engine makes
 *   agreed. The README's Reconciliation section lists what those are, and what
 *   it does not compare.
 * - `review_required` — something does; see `matches` and `summary`.
 * - `nothing_to_reconcile` — both sides were empty, which verifies nothing.
 * - `internal_records_empty` / `provider_records_empty` — an error state: one
 *   side has records and the other none, which is what a failed export looks
 *   like. `matches` still lists every record of the side that has them.
 */
export type ReconciliationOutcome =
  | "perfect"
  | "review_required"
  | "nothing_to_reconcile"
  | "internal_records_empty"
  | "provider_records_empty";

export interface ReconciliationReport {
  runAt: Date;
  provider: PaymentProvider;
  totalInternal: number;
  totalProvider: number;
  matched: number;
  unmatchedInternal: number;
  unmatchedProvider: number;
  amountMismatches: number;
  /** Records whose internal vs provider currencies differ (never amount-diffed). */
  currencyMismatches: number;
  /** Pairs whose amounts agree but whose statuses describe different outcomes. */
  statusMismatches: number;
  /** Pairs whose stated refunded totals differ. */
  refundMismatches: number;
  /** Partially refunded pairs where at least one side states no refunded total. */
  refundsUnverified: number;
  /** Pairs that agree otherwise but carry different `reference`s. */
  referenceMismatches: number;
  /** Records flagged as likely duplicates (additive; may overlap other buckets). */
  duplicates: number;
  /** Rows with `possibleDoubleCharge`; each is also counted in `duplicates`. */
  possibleDoubleCharges: number;
  /** Records (either side) that failed validation and were not reconciled. */
  invalid: number;
  /** The verdict for code to branch on; `summary` says the same for people. */
  outcome: ReconciliationOutcome;
  matches: ReconciliationMatch[];
  summary: string;
}

// ─── Fraud Detection Types ───────────────────────────────────────────────────

export type FraudRiskLevel = "low" | "medium" | "high" | "critical";

export interface FraudSignal {
  name: string;
  triggered: boolean;
  weight: number;
  reason: string;
}

export interface FraudCheckResult {
  paymentId?: string;
  riskScore: number; // 0-100
  riskLevel: FraudRiskLevel;
  signals: FraudSignal[];
  recommendation: "approve" | "review" | "decline";
  reasons: string[];
  checkedAt: Date;
}

export interface FraudContext {
  /** Not read by any built-in rule; available to custom rules. */
  ipAddress?: string;
  userAgent?: string;
  /** Not read by any built-in rule; available to custom rules. */
  deviceFingerprint?: string;
  customerId?: string;
  /**
   * The customer's payment count over YOUR velocity window (e.g. the last
   * hour or day). PayKit does not count payments or apply a window: the
   * built-in `high_velocity` rule fires when this exceeds 10, and above
   * `reviewVelocityCeiling` (default 50) the recommendation is at least `review`,
   * whatever span the number covers. If present it must be a non-negative safe integer;
   * anything else (`NaN`, `1.5`, `-1`) makes `check()` decline, fail closed.
   */
  previousPaymentCount?: number;
  /**
   * Account age in days; fractions are fine. If present it must be a finite
   * number >= 0: anything else (an age computed from a missing date is `NaN`)
   * makes `check()` decline, fail closed. Omit it if you have no age.
   */
  accountAgeDays?: number;
  isNewPaymentMethod?: boolean;
  amount: Money;
  metadata?: Record<string, string>;
}

// ─── Provider Abstraction ────────────────────────────────────────────────────

/**
 * The contract every payment provider adapter implements.
 *
 * **Idempotency is a requirement, not an option.** `createPayment` MUST honour
 * `request.idempotencyKey`:
 * - a repeat call with the same key and the same request returns the payment
 *   the first call created — never a second payment, never a second charge —
 *   including when the first call's response never reached the caller;
 * - a repeat call with the same key and a different request throws
 *   `IdempotencyError` (never the first payment, never a new charge);
 * - for at least as long as `IdempotentPaymentExecutor`'s `ttlMs` (24h by
 *   default).
 *
 * `IdempotentPaymentExecutor` depends on it. It re-sends `createPayment` under
 * the same key when an attempt fails with a retryable error — a `timeout` or
 * `network_error` can arrive AFTER the provider charged the card, and no
 * client can tell — after a hard failure released the key, and after a
 * recorded result expired from (or was evicted by) its store. Only the
 * provider can deduplicate those. Comply by forwarding the key to the
 * provider's own idempotency mechanism: `StripeProvider` sends it as Stripe's
 * `Idempotency-Key`; `MockProvider` deduplicates in memory. An adapter for a
 * provider without such a mechanism must deduplicate itself before it is
 * wrapped in the executor.
 */
export interface PaymentProvider_Interface {
  readonly name: PaymentProvider;
  /** Must be idempotent on `request.idempotencyKey` — see the interface doc. */
  createPayment(request: CreatePaymentRequest): Promise<PaymentIntent>;
  capturePayment(paymentId: string): Promise<PaymentIntent>;
  cancelPayment(paymentId: string): Promise<PaymentIntent>;
  /** Must be idempotent on `request.idempotencyKey` (required), like `createPayment`. */
  refundPayment(request: RefundRequest): Promise<RefundResult>;
  getPayment(paymentId: string): Promise<PaymentIntent>;
  listPayments(options?: {
    limit?: number;
    startingAfter?: string;
  }): Promise<PaymentIntent[]>;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export class PayKitError extends Error {
  /**
   * Set on an error thrown by the provider during `execute()` when the store
   * then failed to release the key's reservation too: what `release()` threw.
   * This error is still the reason the payment failed. The key stays reserved
   * until the store's marker expires, so the same key meanwhile answers
   * `IDEMPOTENCY_WAIT_TIMEOUT` instead of reaching the provider.
   */
  releaseError?: unknown;

  constructor(
    message: string,
    public readonly code: string,
    public readonly provider?: PaymentProvider,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "PayKitError";
  }
}

export class IdempotencyError extends PayKitError {
  /**
   * @param provider - set when the provider itself rejected the reuse (e.g.
   *   Stripe's `StripeIdempotencyError`); absent when PayKit's store did.
   */
  constructor(key: string, provider?: PaymentProvider) {
    super(
      `Idempotency key already used with different parameters: ${key}`,
      "IDEMPOTENCY_CONFLICT",
      provider,
    );
    this.name = "IdempotencyError";
  }
}

/**
 * The provider answered, but the idempotency store could not record it. This is
 * NOT a failed payment: `intent` is the provider's result (money may have moved,
 * so check its `status`), and telling the customer to try again is false.
 *
 * The key's in-flight marker is deliberately kept, so a retry under the same key
 * waits (`IDEMPOTENCY_WAIT_TIMEOUT`) instead of reaching the provider while the
 * store is failing. It clears when a store with expiring markers lets it lapse,
 * or with the process for `InMemoryIdempotencyStore`; a later retry then relies
 * on the provider's own key dedup, which returns this same payment. Not
 * `retryable`, and never retry under a new key: that one can charge twice. Persist
 * `paymentIntentId` yourself.
 *
 * Errors get logged and `intent.clientSecret` is a credential, so the intent is
 * not one of this object's own properties: `JSON.stringify(err)`, `util.inspect`
 * (`console.log(err)`), `{ ...err }` and logging libraries that walk an error's
 * keys cannot reach it. `err.intent` still returns it, for code that asks by name;
 * don't log what that returns, and don't log with `util.inspect`'s `showHidden` and
 * `getters` together, which asks Node to call it. `cause` is whatever the store
 * threw, so a store whose errors quote the value being written would expose it there.
 */
export class PaymentResultNotStoredError extends PayKitError {
  readonly #intent: PaymentIntent;
  /** The payment's id at the provider, which is safe to log. Persist this. */
  public readonly paymentIntentId: string;

  constructor(
    public readonly idempotencyKey: string,
    intent: PaymentIntent,
    /** What the store threw. */
    public readonly cause: unknown,
  ) {
    super(
      `Payment ${intent.id} (status ${intent.status}) exists at the provider, but its result could not be stored for idempotency key ${idempotencyKey}: ${cause instanceof Error ? cause.message : String(cause)}. This is not a failed payment; do not retry under a new key.`,
      "PAYMENT_RESULT_NOT_STORED",
      intent.provider,
    );
    this.name = "PaymentResultNotStoredError";
    this.#intent = intent;
    this.paymentIntentId = intent.id;
  }

  /** The provider's whole result, client secret included: see the class comment. */
  get intent(): PaymentIntent {
    return this.#intent;
  }
}

export class WebhookSignatureError extends PayKitError {
  /**
   * Machine-readable cause, e.g. `missing_secret`, `missing_signature`,
   * `malformed_signature_header`, `signature_mismatch`,
   * `timestamp_outside_tolerance`. Also embedded in `message`.
   */
  public readonly reason?: string;

  constructor(provider: PaymentProvider, reason?: string) {
    super(
      `Webhook signature verification failed for provider: ${provider}${
        reason ? ` (${reason})` : ""
      }`,
      "WEBHOOK_SIGNATURE_INVALID",
      provider,
    );
    this.name = "WebhookSignatureError";
    this.reason = reason;
  }
}

export class ProviderError extends PayKitError {
  /**
   * The request parameter the provider blamed, when it named one (Stripe's
   * `param`, e.g. `amount`). `code` stays the provider's own error code
   * (`resource_missing`, `charge_already_refunded`, …).
   */
  public readonly param?: string;
  /** The issuer's reason for a decline, when given (Stripe's `decline_code`, e.g. `insufficient_funds`). */
  public readonly declineCode?: string;
  /**
   * The PaymentIntent the failure left behind, when the provider names one
   * (Stripe's `payment_intent.id`). It is what lets an off-session
   * `authentication_required` be recovered without a second PaymentIntent: the
   * same idempotency key replays the error, but `getPayment(paymentIntentId)`
   * returns its `clientSecret` for the customer's browser. Only the id is kept,
   * because errors get logged and a client secret must not be.
   */
  public readonly paymentIntentId?: string;
  /**
   * `true` when this failure cannot say whether the request took effect at the
   * provider: a payment may exist even though the call failed. Never move to a
   * new idempotency key on one of these without checking first, because a new
   * key can charge twice. `StripeProvider` sets it on `timeout`, `network_error`
   * and `idempotency_key_in_use`, where re-sending the same key collects the
   * original result, and on `server_error` and `unknown`, where it may not: see
   * the README on what to do after a Stripe 500. Left unset by a failure that
   * says the provider did not act (a decline, a rejected request, a rate limit),
   * and by a custom provider that does not set it.
   */
  public readonly outcomeUnknown?: boolean;

  constructor(
    message: string,
    code: string,
    provider: PaymentProvider,
    retryable: boolean = false,
    param?: string,
    details: { declineCode?: string; paymentIntentId?: string; outcomeUnknown?: boolean } = {},
  ) {
    super(message, code, provider, retryable);
    this.name = "ProviderError";
    this.param = param;
    this.declineCode = details.declineCode;
    this.paymentIntentId = details.paymentIntentId;
    this.outcomeUnknown = details.outcomeUnknown;
  }
}
