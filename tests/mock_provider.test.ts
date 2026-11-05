/**
 * Tests for MockProvider — the reference implementation.
 */

import { MockProvider } from "../src/providers/mock";
import { IdempotentPaymentExecutor } from "../src/payments/idempotent";
import { ReconciliationEngine } from "../src/reconciliation/engine";
import { IdempotencyError, PayKitError } from "../src/types";

describe("MockProvider", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider({ successRate: 1.0 });
  });

  test("createPayment returns succeeded intent", async () => {
    const intent = await provider.createPayment({
      amount: { amount: 5000, currency: "USD" },
      idempotencyKey: "key_1",
    });
    expect(intent.status).toBe("succeeded");
    expect(intent.amount.amount).toBe(5000);
    expect(intent.id).toBeDefined();
  });

  test("intents carry a fake clientSecret, so client-secret code paths work in development", async () => {
    const intent = await provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "key_cs" });
    expect(intent.clientSecret).toBe(`${intent.id}_secret_mock`);
  });

  test("failed provider returns failed status", async () => {
    const failProvider = new MockProvider({ successRate: 0.0 });
    const intent = await failProvider.createPayment({
      amount: { amount: 5000, currency: "USD" },
      idempotencyKey: "key_fail",
    });
    expect(intent.status).toBe("failed");
    expect(intent.errorCode).toBe("card_declined");
  });

  test("getPayment retrieves stored payment", async () => {
    const created = await provider.createPayment({
      amount: { amount: 3000, currency: "USD" },
      idempotencyKey: "key_get",
    });
    const retrieved = await provider.getPayment(created.id);
    expect(retrieved.id).toBe(created.id);
    expect(retrieved.amount.amount).toBe(3000);
  });

  test("getPayment throws for unknown ID", async () => {
    await expect(provider.getPayment("pay_nonexistent")).rejects.toThrow(PayKitError);
  });

  test("cancelPayment changes status to cancelled", async () => {
    // Create in processing state via override
    const pendingProvider = new MockProvider({
      overrides: { key_pending: "processing" },
    });
    const intent = await pendingProvider.createPayment({
      amount: { amount: 1000, currency: "USD" },
      idempotencyKey: "key_pending",
    });
    const cancelled = await pendingProvider.cancelPayment(intent.id);
    expect(cancelled.status).toBe("cancelled");
  });

  test("cancelPayment throws if already succeeded", async () => {
    const intent = await provider.createPayment({
      amount: { amount: 1000, currency: "USD" },
      idempotencyKey: "key_cancel_fail",
    });
    // succeeded → can't cancel
    await expect(provider.cancelPayment(intent.id)).rejects.toThrow(PayKitError);
  });

  test("refundPayment succeeds for succeeded payment", async () => {
    const intent = await provider.createPayment({
      amount: { amount: 10000, currency: "USD" },
      idempotencyKey: "key_refund",
    });
    const refund = await provider.refundPayment({ paymentId: intent.id, idempotencyKey: "refund_1" });
    expect(refund.status).toBe("succeeded");
    expect(refund.amount.amount).toBe(10000);
    expect(refund.paymentId).toBe(intent.id);
  });

  test("partial refund updates status to partially_refunded", async () => {
    const intent = await provider.createPayment({
      amount: { amount: 10000, currency: "USD" },
      idempotencyKey: "key_partial",
    });
    await provider.refundPayment({
      paymentId: intent.id,
      amount: { amount: 5000, currency: "USD" },
      idempotencyKey: "refund_partial",
    });
    const updated = await provider.getPayment(intent.id);
    expect(updated.status).toBe("partially_refunded");
  });

  test("full refund updates status to refunded", async () => {
    const intent = await provider.createPayment({
      amount: { amount: 10000, currency: "USD" },
      idempotencyKey: "key_full_refund",
    });
    await provider.refundPayment({ paymentId: intent.id, idempotencyKey: "refund_full" });
    const updated = await provider.getPayment(intent.id);
    expect(updated.status).toBe("refunded");
  });

  test("listPayments returns all payments up to limit", async () => {
    provider.reset();
    for (let i = 0; i < 5; i++) {
      await provider.createPayment({
        amount: { amount: 1000 + i, currency: "USD" },
        idempotencyKey: `list_key_${i}`,
      });
    }
    const list = await provider.listPayments({ limit: 3 });
    expect(list).toHaveLength(3);
  });

  test("listPayments default limit is 10", async () => {
    provider.reset();
    for (let i = 0; i < 15; i++) {
      await provider.createPayment({
        amount: { amount: 1000, currency: "USD" },
        idempotencyKey: `default_limit_${i}`,
      });
    }
    const list = await provider.listPayments();
    expect(list).toHaveLength(10);
  });

  test("reset clears all payments", async () => {
    await provider.createPayment({
      amount: { amount: 1000, currency: "USD" },
      idempotencyKey: "key_before_reset",
    });
    provider.reset();
    const list = await provider.listPayments();
    expect(list).toHaveLength(0);
  });

  test("provider name is mock", () => {
    expect(provider.name).toBe("mock");
  });

  test("metadata is preserved", async () => {
    const intent = await provider.createPayment({
      amount: { amount: 500, currency: "USD" },
      idempotencyKey: "key_meta",
      metadata: { orderId: "ord_123", userId: "usr_456" },
    });
    expect(intent.metadata?.orderId).toBe("ord_123");
  });

  test("refund of non-existent payment throws", async () => {
    await expect(
      provider.refundPayment({ paymentId: "pay_ghost", idempotencyKey: "refund_ghost" })
    ).rejects.toThrow(PayKitError);
  });
});

describe("MockProvider — honours idempotency keys (the provider contract), as Stripe does", () => {
  const charge = (provider: MockProvider, key: string, amount = 5000) =>
    provider.createPayment({ amount: { amount, currency: "USD" }, idempotencyKey: key, description: "contract" });

  test("the same key and request again returns the original payment: one charge, not two", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    const first = await charge(provider, "order_same");
    const again = await charge(provider, "order_same");
    expect(again.id).toBe(first.id);
    expect(await provider.listPayments({ limit: 100 })).toHaveLength(1);
  });

  test("the replay is the ORIGINAL response, like Stripe's, even after the payment moved on", async () => {
    const provider = new MockProvider({ overrides: { order_auth: "processing" } });
    const first = await charge(provider, "order_auth");
    await provider.capturePayment(first.id); // now succeeded
    const again = await charge(provider, "order_auth");
    expect(again).toMatchObject({ id: first.id, status: "processing" });
    expect((await provider.getPayment(first.id)).status).toBe("succeeded");
  });

  test("captureMethod: manual waits for capturePayment, like Stripe; a failure still fails", async () => {
    const provider = new MockProvider({ successRate: 1.0, overrides: { order_declined: "failed" } });
    const request = { amount: { amount: 5000, currency: "USD" }, captureMethod: "manual" as const };
    const held = await provider.createPayment({ ...request, idempotencyKey: "order_hold" });
    expect(held.status).toBe("processing");
    expect((await provider.capturePayment(held.id)).status).toBe("succeeded");
    expect((await provider.createPayment({ ...request, idempotencyKey: "order_declined" })).status).toBe("failed");
  });

  test("the same key with a different request throws IdempotencyError from the provider and charges nothing", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    await charge(provider, "order_conflict", 5000);
    const reuse = charge(provider, "order_conflict", 9999);
    await expect(reuse).rejects.toThrow(IdempotencyError);
    await expect(reuse).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", provider: "mock" });
    expect(await provider.listPayments({ limit: 100 })).toHaveLength(1);
  });

  test("concurrent calls with one key create exactly one payment", async () => {
    const provider = new MockProvider({ successRate: 1.0, latencyMs: 5 });
    const results = await Promise.all(Array.from({ length: 8 }, () => charge(provider, "order_burst")));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await provider.listPayments({ limit: 100 })).toHaveLength(1);
  });

  test("reset() forgets keys along with payments", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    const first = await charge(provider, "order_reset");
    provider.reset();
    const fresh = await charge(provider, "order_reset", 7000);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.amount.amount).toBe(7000);
  });
});

describe("MockProvider honours refund idempotency keys, as Stripe does", () => {
  async function paid(provider: MockProvider, key: string) {
    return provider.createPayment({ amount: { amount: 10000, currency: "USD" }, idempotencyKey: key });
  }

  test("a retried partial refund with the same key refunds once", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    const intent = await paid(provider, "pay_r1");
    const req = { paymentId: intent.id, amount: { amount: 4000, currency: "USD" }, idempotencyKey: "refund_ticket_1" };
    const first = await provider.refundPayment(req);
    const retry = await provider.refundPayment(req);
    expect(retry.refundId).toBe(first.refundId);
    // A second, DIFFERENT refund request gets its own key and is a real second refund.
    const second = await provider.refundPayment({ ...req, idempotencyKey: "refund_ticket_2" });
    expect(second.refundId).not.toBe(first.refundId);
    expect((await provider.getPayment(intent.id)).status).toBe("partially_refunded");
    // 4000 + 4000 refunded; the rest (no amount) completes it; more is refused.
    await provider.refundPayment({ paymentId: intent.id, idempotencyKey: "refund_ticket_3" });
    expect((await provider.getPayment(intent.id)).status).toBe("refunded");
    await expect(
      provider.refundPayment({ paymentId: intent.id, amount: { amount: 1, currency: "USD" }, idempotencyKey: "refund_ticket_4" }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  test("a partial refund larger than what is left is refused", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    const intent = await paid(provider, "pay_r4");
    await provider.refundPayment({ paymentId: intent.id, amount: { amount: 7000, currency: "USD" }, idempotencyKey: "refund_a" });
    await expect(
      provider.refundPayment({ paymentId: intent.id, amount: { amount: 3001, currency: "USD" }, idempotencyKey: "refund_b" }),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });

  test("the same key with a different refund request is an IdempotencyError", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    const intent = await paid(provider, "pay_r2");
    await provider.refundPayment({ paymentId: intent.id, amount: { amount: 1000, currency: "USD" }, idempotencyKey: "refund_k" });
    await expect(
      provider.refundPayment({ paymentId: intent.id, amount: { amount: 2000, currency: "USD" }, idempotencyKey: "refund_k" }),
    ).rejects.toThrow(IdempotencyError);
  });

  test.each([undefined, "", "   "])("a refund without a key (%p) is refused: a retry would refund twice", async (key) => {
    const provider = new MockProvider({ successRate: 1.0 });
    const intent = await paid(provider, "pay_r3");
    await expect(
      provider.refundPayment({ paymentId: intent.id, idempotencyKey: key as unknown as string }),
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY", provider: "mock" });
    expect((await provider.getPayment(intent.id)).status).toBe("succeeded");
  });
});

describe("MockProvider refunds are validated like Stripe's", () => {
  async function paid(provider: MockProvider) {
    return provider.createPayment({ amount: { amount: 1000, currency: "USD" }, idempotencyKey: "pay_v" });
  }

  test.each([
    ["a negative", { amount: -500, currency: "USD" }, "INVALID_AMOUNT"],
    ["a fractional", { amount: 0.5, currency: "USD" }, "INVALID_AMOUNT"],
    ["a zero", { amount: 0, currency: "USD" }, "INVALID_AMOUNT"],
    ["an other-currency (EUR on a USD payment)", { amount: 500, currency: "EUR" }, "INVALID_REQUEST"],
  ])("%s partial refund is refused and refunds nothing", async (_name, amount, code) => {
    const provider = new MockProvider({ successRate: 1.0 });
    const intent = await paid(provider);
    await expect(provider.refundPayment({ paymentId: intent.id, amount, idempotencyKey: "r_bad" })).rejects.toMatchObject({ code });
    expect((await provider.getPayment(intent.id)).status).toBe("succeeded");
  });

  test("a negative refund cannot open room for an over-refund", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    const intent = await paid(provider);
    await expect(
      provider.refundPayment({ paymentId: intent.id, amount: { amount: -1000, currency: "USD" }, idempotencyKey: "r_neg" }),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await provider.refundPayment({ paymentId: intent.id, idempotencyKey: "r_full" }); // the full 1000
    await expect(
      provider.refundPayment({ paymentId: intent.id, amount: { amount: 1, currency: "USD" }, idempotencyKey: "r_more" }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });
});

describe("MockProvider.createPayment validates money like the real path", () => {
  test.each([
    ["-500", { amount: -500, currency: "USD" }, "INVALID_AMOUNT"],
    ["49.99", { amount: 49.99, currency: "USD" }, "INVALID_AMOUNT"],
    ["NaN", { amount: Number.NaN, currency: "USD" }, "INVALID_AMOUNT"],
    ["0", { amount: 0, currency: "USD" }, "INVALID_AMOUNT"],
    ['"usd " (trailing space)', { amount: 100, currency: "usd " }, "INVALID_CURRENCY"],
  ])("refuses an amount of %s, so it can never be charged or refunded", async (_name, amount, code) => {
    const provider = new MockProvider({ successRate: 1.0 });
    await expect(provider.createPayment({ amount, idempotencyKey: "bad_money" })).rejects.toMatchObject({ code });
    expect(await provider.listPayments({ limit: 10 })).toHaveLength(0);
  });
});

describe("MockProvider overrides are looked up by idempotency key, own keys only", () => {
  test.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "a payment whose key is %p gets a real status, not an Object.prototype member",
    async (key) => {
      const provider = new MockProvider({ successRate: 1.0, overrides: { key_fail: "failed" } });
      const intent = await provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: key });
      expect(intent.status).toBe("succeeded");
    },
  );

  test("a listed key still gets its override", async () => {
    const provider = new MockProvider({ successRate: 1.0, overrides: { key_fail: "failed" } });
    expect((await provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "key_fail" })).status).toBe("failed");
  });
});

describe("MockProvider payments reconcile against its own list", () => {
  test("an executor's results match listPayments() through providerPaymentId", async () => {
    const mock = new MockProvider({ successRate: 1 });
    const executor = new IdempotentPaymentExecutor(mock);
    const payment = await executor.execute({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_recon" });
    expect(payment.providerPaymentId).toBe(payment.id);

    const rows = (await mock.listPayments()).map((p) => ({ id: p.id, amount: p.amount, status: p.status, createdAt: p.createdAt }));
    const report = new ReconciliationEngine({ provider: "mock" }).reconcile(
      [{ id: "i1", providerPaymentId: payment.providerPaymentId, amount: payment.amount, status: payment.status, createdAt: payment.createdAt }],
      rows,
    );
    expect(report).toMatchObject({ matched: 1, outcome: "perfect" });
  });
});
