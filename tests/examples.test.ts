/**
 * The runnable examples are part of the documentation, so they are executed
 * here: an example that silently stops working is a doc that lies.
 */

import type * as NextjsExample from "../examples/nextjs_integration";
import { main as basicPayment } from "../examples/basic_payment";
import { WebhookEngine } from "../src/webhooks/handler";
import type * as Types from "../src/types";
import { paymentIntentSucceeded } from "./fixtures/stripe_events";

// The Next.js example talks to this fake instead of stripe-node. Like Stripe, it creates a NEW
// object for each new idempotency key and replays a key's first response —
// until the key is pruned (Stripe: after ~24h; here: `stripeKeys.clear()`).
// The counters say how many objects really exist at the "provider".
const stripeCalls: { method: string; args: unknown[] }[] = [];
const stripeKeys = new Map<string, unknown>();
const created = { paymentIntents: 0, refunds: 0 };
/** Statuses the fake's next new refunds come back with (default "succeeded"). */
const nextRefundStatuses: string[] = [];
jest.mock(
  "stripe",
  () =>
    jest.fn().mockImplementation(() => ({
      paymentIntents: {
        create: async (...args: unknown[]) => {
          stripeCalls.push({ method: "paymentIntents.create", args });
          const [params, opts] = args as [Record<string, unknown>, { idempotencyKey: string }];
          if (stripeKeys.has(opts.idempotencyKey)) return stripeKeys.get(opts.idempotencyKey);
          const n = ++created.paymentIntents;
          const pi = {
            id: `pi_example_${n}`,
            client_secret: `pi_example_${n}_secret_Abc123`,
            status: "requires_payment_method",
            amount: params.amount,
            currency: params.currency,
            metadata: params.metadata,
            created: 1_700_000_000,
          };
          stripeKeys.set(opts.idempotencyKey, pi);
          return pi;
        },
        retrieve: async (...args: unknown[]) => {
          stripeCalls.push({ method: "paymentIntents.retrieve", args });
          const id = args[0] as string;
          return {
            id,
            client_secret: `${id}_secret_Abc123`,
            status: id === "pi_paid_3" ? "succeeded" : "requires_payment_method",
            amount: 4999,
            currency: "usd",
            metadata: {},
            created: 1_700_000_000,
          };
        },
      },
      refunds: {
        create: async (...args: unknown[]) => {
          stripeCalls.push({ method: "refunds.create", args });
          const [params, opts] = args as [Record<string, unknown>, { idempotencyKey: string }];
          if (stripeKeys.has(opts.idempotencyKey)) return stripeKeys.get(opts.idempotencyKey);
          const n = ++created.refunds;
          const refund = { id: `re_example_${n}`, amount: params.amount, currency: "usd", status: nextRefundStatuses.shift() ?? "succeeded", created: 1_700_000_100 };
          stripeKeys.set(opts.idempotencyKey, refund);
          return refund;
        },
      },
    })),
  { virtual: true },
);

function quietConsole(): () => void {
  const spies = [jest.spyOn(console, "log"), jest.spyOn(console, "error"), jest.spyOn(console, "warn")];
  spies.forEach((s) => s.mockImplementation(() => {}));
  return () => spies.forEach((s) => s.mockRestore());
}

describe("examples/basic_payment.ts", () => {
  test("runs end to end and its Stripe-shaped webhook reaches the payment.succeeded handler", async () => {
    const lines: string[] = [];
    const log = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await basicPayment();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    const out = lines.join("\n");
    expect(error).not.toHaveBeenCalled();
    expect(out).toContain("Webhook payment.succeeded processed: 1 handlers run");
    expect(out).toContain("Fulfilled order for payment: pi_xyz");
    expect(out).toContain("Cache hit flag: cache_hit"); // the executor's real flag, no fallback
    expect(out).toContain("=== Demo complete ===");
  });
});

describe("examples/nextjs_integration.ts", () => {
  const WEBHOOK_SECRET = "whsec_example_test_secret";
  const CUSTOMER_1 = "demo_session_customer_1"; // cus_1: owns ord_1 (open) and ord_3 (paid)
  const CUSTOMER_5 = "demo_session_customer_5"; // cus_5: a profile that scores "review"
  const CUSTOMER_9 = "demo_session_customer_9"; // cus_9: a profile that scores "decline"
  const CUSTOMER_7 = "demo_session_customer_7"; // cus_7: a profile whose age is NaN
  const SUPPORT = "demo_session_support";
  const UA = "Mozilla/5.0";
  const IP = "203.0.113.7";
  let example: typeof NextjsExample;
  let restoreConsole: () => void;
  const calls = (method: string) => stripeCalls.filter((c) => c.method === method);

  beforeAll(() => {
    // The example builds its StripeProvider at import time from the env.
    process.env["STRIPE_SECRET_KEY"] = "sk_test_example";
    example = require("../examples/nextjs_integration");
  });
  beforeEach(() => {
    stripeCalls.length = 0;
    restoreConsole = quietConsole();
    process.env["STRIPE_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
    process.env["PAYKIT_EXAMPLE_DEMO_AUTH"] = "1"; // the stub's demo sessions; off by default
  });
  afterEach(() => restoreConsole());
  afterAll(() => {
    delete process.env["STRIPE_SECRET_KEY"];
    delete process.env["STRIPE_WEBHOOK_SECRET"];
    delete process.env["PAYKIT_EXAMPLE_DEMO_AUTH"];
  });

  test("the auth stub fails closed: unless demo auth is switched on, even a demo token is refused", async () => {
    delete process.env["PAYKIT_EXAMPLE_DEMO_AUTH"];
    expect(await example.checkoutHandler(CUSTOMER_1, "ord_1", UA, IP)).toEqual({ httpStatus: 401, error: "Sign in to pay." });
    expect(await example.refundHandler(SUPPORT, "rt_100")).toMatchObject({ httpStatus: 401 });
    expect(stripeCalls).toHaveLength(0);
  });

  test("an unauthenticated checkout is refused: no clientSecret, no Stripe call", async () => {
    expect(await example.checkoutHandler(null, "ord_1", UA, IP)).toEqual({ httpStatus: 401, error: "Sign in to pay." });
    expect(await example.checkoutHandler("forged_token", "ord_1", UA, IP)).toMatchObject({ httpStatus: 401 });
    expect(stripeCalls).toHaveLength(0);
  });

  test("another customer's order is refused exactly like a missing one (404), so ids cannot be probed", async () => {
    const other = await example.checkoutHandler(CUSTOMER_1, "ord_2", UA, IP); // ord_2 is cus_2's
    const missing = await example.checkoutHandler(CUSTOMER_1, "ord_nope", UA, IP);
    expect(other).toEqual({ httpStatus: 404, error: "Unknown order." });
    expect(missing).toEqual(other);
    expect(stripeCalls).toHaveLength(0);
  });

  test("the owner's checkout returns Stripe's client_secret, charging the SERVER's price as the order's customer", async () => {
    const result = await example.checkoutHandler(CUSTOMER_1, "ord_1", UA, IP);
    expect(result).toEqual({ httpStatus: 200, clientSecret: "pi_example_1_secret_Abc123" });
    const [params] = calls("paymentIntents.create")[0].args as [Record<string, unknown>];
    expect(params).toMatchObject({ amount: 4999, currency: "usd", customer: "cus_1", metadata: { orderId: "ord_1" } });
    expect(example.checkoutHandler.length).toBe(4); // (session, orderId, userAgent, ip) — no amount, no customer
  });

  test("checkout again after Stripe has forgotten the key: the order's open PaymentIntent is retrieved, never a second one created", async () => {
    stripeKeys.clear(); // > 24h later
    const again = await example.checkoutHandler(CUSTOMER_1, "ord_1", "", IP); // and a different user agent
    expect(again).toEqual({ httpStatus: 200, clientSecret: "pi_example_1_secret_Abc123" });
    expect(calls("paymentIntents.create")).toHaveLength(0);
    expect(calls("paymentIntents.retrieve").map((c) => c.args[0])).toEqual(["pi_example_1"]);
    expect(created.paymentIntents).toBe(1);
  });

  test("a paid order refuses checkout: no PaymentIntent, no client secret", async () => {
    expect(await example.checkoutHandler(CUSTOMER_1, "ord_3", UA, IP)).toEqual({ httpStatus: 409, error: "This order is already paid." });
    expect(calls("paymentIntents.create")).toHaveLength(0);
  });

  test('fraud "review" holds the order and charges nothing — also on a second attempt', async () => {
    for (let i = 0; i < 2; i++) {
      expect(await example.checkoutHandler(CUSTOMER_5, "ord_5", UA, IP)).toMatchObject({ httpStatus: 202 });
    }
    expect(calls("paymentIntents.create")).toHaveLength(0);
  });

  test("a high-risk context (1-day account, new card, 15 payments in 24h, $1,500) is declined", async () => {
    expect(await example.checkoutHandler(CUSTOMER_9, "ord_9", UA, IP)).toEqual({ httpStatus: 402, error: "Transaction declined. Please contact support." });
    expect(calls("paymentIntents.create")).toHaveLength(0);
  });

  test("a profile with a broken number (age NaN, from a missing date) is declined, not scored as no risk", async () => {
    expect(await example.checkoutHandler(CUSTOMER_7, "ord_7", UA, IP)).toEqual({ httpStatus: 402, error: "Transaction declined. Please contact support." });
    expect(calls("paymentIntents.create")).toHaveLength(0);
  });

  test("refunds need the support role: a customer, or nobody, is refused", async () => {
    expect(await example.refundHandler(CUSTOMER_1, "rt_100")).toEqual({ httpStatus: 403, error: "Refunds need the support role." });
    expect(await example.refundHandler(null, "rt_100")).toMatchObject({ httpStatus: 401 });
    expect(calls("refunds.create")).toHaveLength(0);
  });

  test("made-up refund ids refund nothing: only a server-side ticket can, and the caller cannot pick the payment or amount", async () => {
    for (const id of ["r1", "r2", "r3"]) {
      expect(await example.refundHandler(SUPPORT, id)).toEqual({ httpStatus: 404, error: "Unknown refund ticket." });
    }
    expect(calls("refunds.create")).toHaveLength(0);
    expect(example.refundHandler.length).toBe(2); // (session, ticketId) — no payment id, amount or key
  });

  test("one ticket is one refund, even after Stripe has forgotten the key: the done ticket is answered from the records", async () => {
    const first = await example.refundHandler(SUPPORT, "rt_100");
    expect(first).toMatchObject({ httpStatus: 200, refundId: "re_example_1" });
    const [params, opts] = calls("refunds.create")[0].args as [Record<string, unknown>, { idempotencyKey: string }];
    expect(params).toMatchObject({ payment_intent: "pi_paid_3", amount: 1500 });
    expect(opts.idempotencyKey).toBe("refund_ord_3_rt_100");

    stripeKeys.clear(); // > 24h later
    const again = await example.refundHandler(SUPPORT, "rt_100");
    expect(again).toEqual(first);
    expect(calls("refunds.create")).toHaveLength(1); // Stripe was not asked again
    expect(created.refunds).toBe(1);
  });

  test("a ticket for more than is left (after issued refunds) is refused before any Stripe call", async () => {
    expect(await example.refundHandler(SUPPORT, "rt_101")).toMatchObject({ httpStatus: 409, error: expect.stringContaining("exceeds the 3499 left") });
    expect(calls("refunds.create")).toHaveLength(0);
  });

  test("a FAILED refund does not close the ticket: the retry uses a new attempt key and succeeds", async () => {
    nextRefundStatuses.push("failed");
    const first = await example.refundHandler(SUPPORT, "rt_103");
    expect(first).toMatchObject({ httpStatus: 200, status: "failed" });
    const retry = await example.refundHandler(SUPPORT, "rt_103");
    expect(retry).toMatchObject({ httpStatus: 200, status: "succeeded" });
    expect(calls("refunds.create").map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey)).toEqual([
      "refund_ord_3_rt_103",
      "refund_ord_3_rt_103_a2",
    ]);
    // Done now: a further replay is answered from the records.
    await example.refundHandler(SUPPORT, "rt_103");
    expect(calls("refunds.create")).toHaveLength(2);
  });

  test("a PENDING refund stays pending: a replay does not ask Stripe again, and it counts against what is left", async () => {
    nextRefundStatuses.push("pending");
    expect(await example.refundHandler(SUPPORT, "rt_104")).toMatchObject({ httpStatus: 200, status: "pending" });
    stripeKeys.clear();
    expect(await example.refundHandler(SUPPORT, "rt_104")).toMatchObject({ httpStatus: 200, status: "pending" });
    expect(calls("refunds.create")).toHaveLength(1);
    // 4999 - 1500 (rt_100) - 500 (rt_103) - 300 (rt_104, pending) = 2699 left.
    expect(await example.refundHandler(SUPPORT, "rt_101")).toMatchObject({ httpStatus: 409, error: expect.stringContaining("exceeds the 2699 left") });
  });

  test("a ticket on an order that was never paid is refused", async () => {
    expect(await example.refundHandler(SUPPORT, "rt_102")).toMatchObject({ httpStatus: 409 });
    expect(calls("refunds.create")).toHaveLength(0);
  });

  describe("checkout when the idempotency store fails", () => {
    /** A fresh copy of the example (its own orders and store) whose store fails as `method`. */
    function exampleWithFailingStore(method: "set" | "get") {
      let fresh!: typeof NextjsExample;
      jest.isolateModules(() => {
        fresh = require("../examples/nextjs_integration");
        const { InMemoryIdempotencyStore } = require("../src/payments/idempotent");
        jest.spyOn(InMemoryIdempotencyStore.prototype, method).mockRejectedValue(new Error("redis down"));
      });
      return fresh;
    }
    afterEach(() => jest.restoreAllMocks());

    test("after Stripe created the intent: never 'failed', the payment continues, and a retry finds the same one", async () => {
      const fresh = exampleWithFailingStore("set");
      const before = created.paymentIntents;
      const first = await fresh.checkoutHandler(CUSTOMER_1, "ord_1", UA, IP);
      expect(first.httpStatus).toBe(200);
      expect(first.clientSecret).toMatch(/_secret_/);
      expect(first.error).toBeUndefined();
      // What the alert says is the id, and never the secret.
      const logged = (console.error as jest.Mock).mock.calls.flat().join(" ");
      expect(logged).toContain("pi_example_");
      expect(logged).not.toContain("_secret_");
      // The order remembers it: the retry retrieves rather than creates.
      expect((await fresh.findOrder("ord_1"))?.paymentIntentId).toBe(`pi_example_${before + 1}`);
      const retry = await fresh.checkoutHandler(CUSTOMER_1, "ord_1", UA, IP);
      expect(retry.httpStatus).toBe(200);
      expect(created.paymentIntents).toBe(before + 1);
    });

    test("an unclassified failure does not promise that nothing was charged", async () => {
      const fresh = exampleWithFailingStore("get");
      const result = await fresh.checkoutHandler(CUSTOMER_1, "ord_1", UA, IP);
      expect(result.httpStatus).toBe(500);
      expect(result.error).toBe("We could not confirm your payment. Please contact support before trying again.");
    });
  });

  describe("a provider error's message stays on the server", () => {
    const DETAIL = "internal: request req_8f3 on key checkout_ord_1 rejected by 10.0.0.3";

    /** `makeError` runs in the example's own module registry, so `instanceof` holds there. */
    function exampleWithFailingProvider(method: "createPayment" | "getPayment" | "refundPayment", makeError: (types: typeof Types) => Error): typeof NextjsExample {
      let fresh!: typeof NextjsExample;
      jest.isolateModules(() => {
        const { StripeProvider } = require("../src/providers/stripe");
        jest.spyOn(StripeProvider.prototype, method).mockRejectedValue(makeError(require("../src/types")));
        fresh = require("../examples/nextjs_integration");
      });
      return fresh;
    }
    const internal = (types: typeof Types) => new types.PayKitError(DETAIL, "SOME_INTERNAL_CODE");
    afterEach(() => jest.restoreAllMocks());

    const expectOnlyInTheLog = (result: { httpStatus: number; error?: string }, expected: string) => {
      expect(result).toMatchObject({ httpStatus: 500, error: expected });
      expect(JSON.stringify(result)).not.toContain("10.0.0.3");
      expect((console.error as jest.Mock).mock.calls.flat().join(" ")).toContain("10.0.0.3");
    };

    test("checkout: creating the payment", async () => {
      const fresh = exampleWithFailingProvider("createPayment", internal);
      expectOnlyInTheLog(await fresh.checkoutHandler(CUSTOMER_1, "ord_1", UA, IP), "We could not confirm your payment. Please contact support before trying again.");
    });

    test("checkout: looking up the order's existing payment", async () => {
      const fresh = exampleWithFailingProvider("getPayment", internal);
      const order = await fresh.findOrder("ord_1");
      order!.paymentIntentId = "pi_existing";
      expectOnlyInTheLog(await fresh.checkoutHandler(CUSTOMER_1, "ord_1", UA, IP), "Payment lookup failed.");
    });

    test("refund", async () => {
      const fresh = exampleWithFailingProvider("refundPayment", internal);
      expectOnlyInTheLog(await fresh.refundHandler(SUPPORT, "rt_100"), "Refund failed");
    });

    test("a decline is the one failure the customer can act on", async () => {
      const fresh = exampleWithFailingProvider("createPayment", (types) => new types.ProviderError(`declined: ${DETAIL}`, "card_declined", "stripe", false));
      const result = await fresh.checkoutHandler(CUSTOMER_1, "ord_1", UA, IP);
      expect(result).toEqual({ httpStatus: 402, error: "Your card was declined. Please try another payment method." });
    });
  });

  test("the webhook route: signed Stripe event 200, unsigned 400, secret unset 500", async () => {
    const rawBody = JSON.stringify(paymentIntentSucceeded("evt_example_route"));
    const signature = new WebhookEngine().computeSignature(rawBody, WEBHOOK_SECRET);
    expect((await example.stripeWebhookHandler(rawBody, signature)).httpStatus).toBe(200);
    expect((await example.stripeWebhookHandler(rawBody, null)).httpStatus).toBe(400);
    delete process.env["STRIPE_WEBHOOK_SECRET"];
    expect((await example.stripeWebhookHandler(rawBody, signature)).httpStatus).toBe(500);
  });
});
