/**
 * Mock payment provider for testing and development.
 *
 * Simulates realistic payment behavior including:
 * - Configurable success/failure rates
 * - Realistic latency simulation
 * - Full CRUD payment lifecycle
 * - The provider idempotency contract (`PaymentProvider_Interface`), the way
 *   Stripe implements it: a repeated `createPayment` with a key it has seen
 *   returns that key's original payment instead of charging again, and the
 *   same key with a different request throws `IdempotencyError`. Keys are
 *   remembered for the life of the instance (until `reset()`).
 *
 * One difference from Stripe to keep in mind: a refund changes a mock payment's
 * status to `refunded` or `partially_refunded`, while a Stripe PaymentIntent stays
 * `succeeded`, so `StripeProvider.getPayment` never returns those (`PaymentStatus`).
 */

import {
  PaymentProvider_Interface,
  PaymentProvider,
  PaymentIntent,
  CreatePaymentRequest,
  RefundRequest,
  RefundResult,
  PaymentStatus,
  PayKitError,
  IdempotencyError,
} from "../types/index";
import { fingerprintRequest } from "../payments/fingerprint";
import { assertIdempotencyKey, assertRefundKey, assertValidMoney } from "../payments/idempotent";

export interface MockProviderConfig {
  /** Fraction of payments that succeed (default 0.97) */
  successRate?: number;
  /** Simulated latency in ms (default 0) */
  latencyMs?: number;
  /**
   * Fixed outcomes by IDEMPOTENCY KEY: a `createPayment` whose key is listed
   * gets that status instead of a sampled one. Only the object's own keys
   * count — `"constructor"` or `"toString"` are not overrides.
   */
  overrides?: Record<string, PaymentStatus>;
}

export class MockProvider implements PaymentProvider_Interface {
  readonly name: PaymentProvider = "mock";
  private payments = new Map<string, PaymentIntent>();
  private refunds = new Map<string, RefundResult>();
  /** Refund idempotency key → its first result and request, replayed like Stripe does. */
  private refundsByKey = new Map<string, { result: RefundResult; request: string }>();
  /**
   * Idempotency key → the payment its first request created, as first
   * returned, plus that request's fingerprint. What `createPayment` replays.
   */
  private byKey = new Map<string, { intent: PaymentIntent; fingerprint: string }>();
  private config: Required<MockProviderConfig>;

  constructor(config: MockProviderConfig = {}) {
    this.config = {
      successRate: config.successRate ?? 0.97,
      latencyMs: config.latencyMs ?? 0,
      overrides: config.overrides ?? {},
    };
  }

  async createPayment(request: CreatePaymentRequest): Promise<PaymentIntent> {
    assertIdempotencyKey(request.idempotencyKey, "mock");
    // The same money rule as the executor: a test against the mock must not
    // pass for a request Stripe would reject (-500, 49.99, NaN, 0, "usd ").
    assertValidMoney(request.amount?.amount, request.amount?.currency);
    await this._simulateLatency();

    // Idempotency contract. From this lookup to `byKey.set` below there is no
    // `await`, so concurrent calls with one key cannot both create a payment.
    // Like Stripe, a replay returns the ORIGINAL response, not current state.
    const fingerprint = fingerprintRequest(request);
    const seen = this.byKey.get(request.idempotencyKey);
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw new IdempotencyError(request.idempotencyKey, "mock");
      }
      return { ...seen.intent };
    }

    const id = `mock_pay_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const statusOverride = Object.prototype.hasOwnProperty.call(this.config.overrides, request.idempotencyKey)
      ? this.config.overrides[request.idempotencyKey]
      : undefined;

    // Override takes precedence; otherwise sample by configured success rate.
    let status: PaymentStatus;
    if (statusOverride) {
      status = statusOverride;
    } else {
      status = Math.random() < this.config.successRate ? "succeeded" : "failed";
    }
    // Like Stripe, a manual-capture payment that would have succeeded waits for
    // capturePayment() instead.
    if (status === "succeeded" && request.captureMethod === "manual") status = "processing";
    const isFailure = status === "failed";

    const intent: PaymentIntent = {
      id,
      idempotencyKey: request.idempotencyKey,
      provider: "mock",
      status,
      amount: request.amount,
      metadata: request.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
      providerPaymentId: id,
      clientSecret: `${id}_secret_mock`,
      errorCode: isFailure ? "card_declined" : undefined,
      errorMessage: isFailure ? "Your card was declined." : undefined,
    };

    this.payments.set(id, intent);
    this.byKey.set(request.idempotencyKey, { intent, fingerprint });
    return intent;
  }

  async capturePayment(paymentId: string): Promise<PaymentIntent> {
    await this._simulateLatency();
    const payment = this._getOrThrow(paymentId);
    if (payment.status !== "processing") {
      throw new PayKitError(
        `Cannot capture payment in status: ${payment.status}`,
        "INVALID_STATUS",
        "mock",
      );
    }
    const updated = { ...payment, status: "succeeded" as PaymentStatus, updatedAt: new Date() };
    this.payments.set(paymentId, updated);
    return updated;
  }

  async cancelPayment(paymentId: string): Promise<PaymentIntent> {
    await this._simulateLatency();
    const payment = this._getOrThrow(paymentId);
    if (!["pending", "processing"].includes(payment.status)) {
      throw new PayKitError(
        `Cannot cancel payment in status: ${payment.status}`,
        "INVALID_STATUS",
        "mock",
      );
    }
    const updated = { ...payment, status: "cancelled" as PaymentStatus, updatedAt: new Date() };
    this.payments.set(paymentId, updated);
    return updated;
  }

  async refundPayment(request: RefundRequest): Promise<RefundResult> {
    await this._simulateLatency();
    // Refund idempotency, as Stripe implements it: the same key and request
    // replays the first refund; the same key with another request is a
    // conflict. No `await` between this lookup and the `set` below.
    assertRefundKey(request, "mock");
    const requestKey = JSON.stringify([request.paymentId, request.amount?.amount ?? null, request.amount?.currency.toUpperCase() ?? null, request.reason ?? null]);
    const seen = this.refundsByKey.get(request.idempotencyKey);
    if (seen) {
      if (seen.request !== requestKey) throw new IdempotencyError(request.idempotencyKey, "mock");
      return { ...seen.result };
    }
    // Like Stripe: a partial amount is positive integer minor units in the
    // payment's own currency. (A negative "refund" would raise what is left
    // to refund, and a foreign currency would be refunded as if it matched.)
    if (request.amount) assertValidMoney(request.amount.amount, request.amount.currency);
    const payment = this._getOrThrow(request.paymentId);
    if (request.amount && request.amount.currency.toUpperCase() !== payment.amount.currency.toUpperCase()) {
      throw new PayKitError(
        `Refund currency ${request.amount.currency.toUpperCase()} does not match payment ${request.paymentId} in ${payment.amount.currency.toUpperCase()}`,
        "INVALID_REQUEST",
        "mock",
      );
    }
    if (payment.status !== "succeeded" && payment.status !== "partially_refunded") {
      throw new PayKitError(
        `Cannot refund payment in status: ${payment.status}`,
        "INVALID_STATUS",
        "mock",
      );
    }

    // Like Stripe: several partial refunds, up to what is left; no amount
    // means "the rest".
    let alreadyRefunded = 0;
    for (const r of this.refunds.values()) {
      if (r.paymentId === request.paymentId) alreadyRefunded += r.amount.amount;
    }
    const remaining = payment.amount.amount - alreadyRefunded;
    const refundAmount = request.amount ?? { amount: remaining, currency: payment.amount.currency };
    if (refundAmount.amount > remaining) {
      throw new PayKitError(
        `Refund of ${refundAmount.amount} exceeds the ${remaining} left to refund on payment ${request.paymentId}`,
        "INVALID_AMOUNT",
        "mock",
      );
    }
    const refundId = `mock_re_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const result: RefundResult = {
      refundId,
      paymentId: request.paymentId,
      amount: refundAmount,
      status: "succeeded",
      createdAt: new Date(),
    };

    this.refunds.set(refundId, result);
    this.refundsByKey.set(request.idempotencyKey, { result, request: requestKey });

    // Update payment status
    const newStatus =
      alreadyRefunded + refundAmount.amount >= payment.amount.amount
        ? ("refunded" as PaymentStatus)
        : ("partially_refunded" as PaymentStatus);
    this.payments.set(request.paymentId, { ...payment, status: newStatus, updatedAt: new Date() });

    return result;
  }

  async getPayment(paymentId: string): Promise<PaymentIntent> {
    await this._simulateLatency();
    return this._getOrThrow(paymentId);
  }

  async listPayments(options: { limit?: number; startingAfter?: string } = {}): Promise<PaymentIntent[]> {
    await this._simulateLatency();
    const all = Array.from(this.payments.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    const limit = options.limit ?? 10;
    if (options.startingAfter) {
      const idx = all.findIndex((p) => p.id === options.startingAfter);
      return idx >= 0 ? all.slice(idx + 1, idx + 1 + limit) : [];
    }
    return all.slice(0, limit);
  }

  /** Reset all stored payments, refunds and remembered idempotency keys (useful in tests). */
  reset(): void {
    this.payments.clear();
    this.refunds.clear();
    this.refundsByKey.clear();
    this.byKey.clear();
  }

  private _getOrThrow(id: string): PaymentIntent {
    const payment = this.payments.get(id);
    if (!payment) {
      throw new PayKitError(`Payment not found: ${id}`, "NOT_FOUND", "mock");
    }
    return payment;
  }

  private async _simulateLatency(): Promise<void> {
    if (this.config.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.latencyMs));
    }
  }
}
