/**
 * Tests for the Stripe provider adapter.
 *
 * The SDK is replaced with a jest mock here: a fake client that records every
 * call. These tests pin the adapter's own contract (request mapping, status and
 * error mapping, integer-cents passthrough). The real stripe-node (an
 * exact-pinned devDependency) is exercised in tests/stripe_real_sdk.test.ts.
 */

import { StripeProvider } from "../src/providers/stripe";
import { IdempotentPaymentExecutor } from "../src/payments/idempotent";
import { IdempotencyError, PayKitError, ProviderError } from "../src/types";

const calls: { method: string; args: unknown[] }[] = [];
let nextResult: unknown;
let nextError: unknown;
let constructedWith: unknown[] = [];

function record(method: string) {
  return async (...args: unknown[]) => {
    calls.push({ method, args });
    if (nextError) throw nextError;
    return nextResult;
  };
}

jest.mock(
  "stripe",
  () =>
    jest.fn().mockImplementation((...args: unknown[]) => {
      constructedWith = args;
      return {
        paymentIntents: {
          create: record("paymentIntents.create"),
          capture: record("paymentIntents.capture"),
          cancel: record("paymentIntents.cancel"),
          retrieve: record("paymentIntents.retrieve"),
          list: record("paymentIntents.list"),
        },
        refunds: { create: record("refunds.create") },
      };
    }),
  { virtual: true },
);

function stripeIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "pi_123",
    status: "succeeded",
    amount: 4999,
    currency: "usd",
    metadata: { order: "A-1" },
    created: 1_700_000_000,
    ...overrides,
  };
}

let warn: jest.SpyInstance;

beforeEach(() => {
  calls.length = 0;
  nextResult = stripeIntent();
  nextError = undefined;
  constructedWith = [];
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  delete process.env["STRIPE_SECRET_KEY"];
});

describe("StripeProvider initialisation", () => {
  test("without a key it warns and every operation throws NOT_INITIALIZED", async () => {
    delete process.env["STRIPE_SECRET_KEY"];
    const provider = new StripeProvider();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No secret key configured"));

    const ops: Promise<unknown>[] = [
      provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "k" }),
      provider.capturePayment("pi_1"),
      provider.cancelPayment("pi_1"),
      provider.refundPayment({ paymentId: "pi_1", idempotencyKey: "refund_k" }),
      provider.getPayment("pi_1"),
      provider.listPayments(),
    ];
    for (const op of ops) {
      await expect(op).rejects.toMatchObject({ code: "NOT_INITIALIZED", provider: "stripe" });
    }
    expect(calls).toHaveLength(0);
  });

  test("reads STRIPE_SECRET_KEY from the environment, pins the API version, and sets an explicit timeout and retry count", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_env_key";
    const provider = new StripeProvider();
    expect(provider.name).toBe("stripe");
    await expect(provider.ready()).resolves.toBe(true); // the SDK loads asynchronously
    // stripe-node's own defaults (80 s timeout, 2 retries in current versions)
    // would let one call outlive a 60-180 s pending marker; PayKit pins both.
    expect(constructedWith).toEqual([
      "sk_test_env_key",
      { apiVersion: "2024-06-20", timeout: 20_000, maxNetworkRetries: 1 },
    ]);
  });

  test("an explicit secretKey, apiVersion, timeoutMs and maxNetworkRetries win", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_env_key";
    await new StripeProvider({ secretKey: "sk_test_explicit", apiVersion: "2025-01-01", timeoutMs: 5_000, maxNetworkRetries: 0 }).ready();
    expect(constructedWith).toEqual([
      "sk_test_explicit",
      { apiVersion: "2025-01-01", timeout: 5_000, maxNetworkRetries: 0 },
    ]);
  });

  test("STRIPE_API_VERSION is not read: only apiVersion changes the pinned version", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_env_key";
    process.env["STRIPE_API_VERSION"] = "2099-01-01";
    try {
      await new StripeProvider().ready();
      expect(constructedWith).toEqual(["sk_test_env_key", expect.objectContaining({ apiVersion: "2024-06-20" })]);
    } finally {
      delete process.env["STRIPE_API_VERSION"];
    }
  });

  test.each([
    [{ timeoutMs: 0 }],
    [{ timeoutMs: -1 }],
    [{ timeoutMs: 1.5 }],
    [{ timeoutMs: Number.NaN }],
    [{ maxNetworkRetries: -1 }],
    [{ maxNetworkRetries: 0.5 }],
  ])("rejects %o with INVALID_CONFIG before building the SDK client", (bad) => {
    expect(() => new StripeProvider({ secretKey: "sk_test_x", ...bad })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG", provider: "stripe" }),
    );
    expect(constructedWith).toEqual([]);
  });

  test("a configuration the SDK rejects surfaces as its own error, not as 'stripe package not installed'", async () => {
    const Stripe = jest.requireMock("stripe") as jest.Mock;
    Stripe.mockImplementationOnce(() => {
      throw new Error("Stripe: Config object may only contain the following: ...");
    });
    const provider = new StripeProvider({ secretKey: "sk_test_x" });
    await expect(provider.ready()).rejects.toThrow(/Config object may only contain/);
    await expect(provider.getPayment("pi_1")).rejects.toThrow(/Config object may only contain/);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("not installed"));
  });

  test("an injected Stripe constructor is used instead of loading the package, with the pinned options", async () => {
    const injected: unknown[][] = [];
    class InjectedStripe {
      paymentIntents = { retrieve: async () => stripeIntent({ id: "pi_injected" }) };
      constructor(...args: unknown[]) {
        injected.push(args);
      }
    }
    const provider = new StripeProvider({ secretKey: "sk_test_injected", Stripe: InjectedStripe });
    expect(injected).toEqual([["sk_test_injected", { apiVersion: "2024-06-20", timeout: 20_000, maxNetworkRetries: 1 }]]);
    await expect(provider.ready()).resolves.toBe(true);
    expect((await provider.getPayment("pi_injected")).id).toBe("pi_injected");
    expect(constructedWith).toEqual([]); // the package's (mocked) constructor never ran
  });

  test("without a key ready() resolves false (and the provider warned)", async () => {
    delete process.env["STRIPE_SECRET_KEY"];
    await expect(new StripeProvider().ready()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No secret key configured"));
  });
});

describe("StripeProvider payments", () => {
  const provider = () => new StripeProvider({ secretKey: "sk_test_x" });

  test("createPayment without a payment method creates an unconfirmed intent (exact params)", async () => {
    const intent = await provider().createPayment({
      amount: { amount: 4999, currency: "USD" },
      idempotencyKey: "order-A-1",
      description: "Order A-1",
    });

    const [params, opts] = calls[0].args as [Record<string, unknown>, Record<string, unknown>];
    expect(calls[0].method).toBe("paymentIntents.create");
    expect(params).toEqual({
      amount: 4999,
      currency: "usd",
      description: "Order A-1",
      metadata: {},
      confirm: false,
      automatic_payment_methods: { enabled: true },
    });
    expect(opts).toEqual({ idempotencyKey: "order-A-1" });

    expect(intent).toMatchObject({
      id: "pi_123",
      idempotencyKey: "order-A-1",
      provider: "stripe",
      status: "succeeded",
      amount: { amount: 4999, currency: "USD" },
      providerPaymentId: "pi_123",
    });
    expect(Number.isInteger(intent.amount.amount)).toBe(true);
    expect(intent.createdAt.getTime()).toBe(1_700_000_000_000);
  });

  test("returnUrl without a payment method is refused before calling Stripe (return_url needs confirm=true)", async () => {
    // Stripe's API reference: return_url "can only be used with confirm=true".
    const attempt = provider().createPayment({
      amount: { amount: 100, currency: "USD" },
      idempotencyKey: "k_return",
      returnUrl: "https://example.com/return",
    });
    await expect(attempt).rejects.toThrow(PayKitError);
    await expect(attempt).rejects.toMatchObject({ code: "INVALID_REQUEST", provider: "stripe", retryable: false });
    expect(calls).toHaveLength(0);
  });

  test("the executor does not retry that refusal: Stripe is never called", async () => {
    const executor = new IdempotentPaymentExecutor(provider(), { retry: { maxAttempts: 3, initialDelayMs: 1 } });
    await expect(
      executor.execute({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "k_return_exec", returnUrl: "https://example.com/r" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toHaveLength(0);
  });

  // Server-side confirmation. Since API 2023-08-16 Stripe enables automatic
  // payment methods by default and then requires `return_url` to confirm
  // unless `off_session=true` or `automatic_payment_methods[allow_redirects]`
  // is `never` (docs.stripe.com/changelog/2023-08-16/automatic-payment-methods).
  // Each case pins the exact parameter set the adapter sends.
  const confirmCases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      "a payment method alone confirms with redirects disallowed (no return_url needed)",
      { paymentMethodId: "pm_card_visa", customerId: "cus_1" },
      {
        payment_method: "pm_card_visa",
        customer: "cus_1",
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      },
    ],
    [
      "a payment method with a returnUrl confirms with return_url and redirects allowed",
      { paymentMethodId: "pm_card_visa", customerId: "cus_1", returnUrl: "https://example.com/return" },
      {
        payment_method: "pm_card_visa",
        customer: "cus_1",
        confirm: true,
        return_url: "https://example.com/return",
        automatic_payment_methods: { enabled: true },
      },
    ],
    [
      "offSession charges a saved method with off_session=true and redirects allowed",
      { paymentMethodId: "pm_saved", customerId: "cus_1", offSession: true },
      {
        payment_method: "pm_saved",
        customer: "cus_1",
        confirm: true,
        off_session: true,
        automatic_payment_methods: { enabled: true },
      },
    ],
    [
      "offSession with a returnUrl passes both through",
      { paymentMethodId: "pm_saved", customerId: "cus_1", offSession: true, returnUrl: "https://example.com/return" },
      {
        payment_method: "pm_saved",
        customer: "cus_1",
        confirm: true,
        off_session: true,
        return_url: "https://example.com/return",
        automatic_payment_methods: { enabled: true },
      },
    ],
    [
      "offSession: false is an ordinary on-session confirm",
      { paymentMethodId: "pm_card_visa", offSession: false },
      {
        payment_method: "pm_card_visa",
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      },
    ],
  ];

  test.each(confirmCases)("%s (exact params)", async (_name, fields, expected) => {
    await provider().createPayment({
      amount: { amount: 2000, currency: "EUR" },
      idempotencyKey: "k_confirm",
      metadata: { a: "b" },
      ...fields,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      { amount: 2000, currency: "eur", metadata: { a: "b" }, ...expected },
      { idempotencyKey: "k_confirm" },
    ]);
  });

  test.each([
    ["no key", undefined],
    ["an empty key", ""],
    ["a whitespace key", "  "],
  ])("createPayment with %s is refused before any Stripe call (stripe-node would send a random key per attempt)", async (_name, key) => {
    await expect(
      provider().createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: key as unknown as string }),
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY", provider: "stripe" });
    expect(calls).toHaveLength(0);
  });

  test("offSession without a payment method is refused before calling Stripe (off_session needs confirm=true)", async () => {
    const attempt = provider().createPayment({
      amount: { amount: 100, currency: "USD" },
      idempotencyKey: "k_off",
      customerId: "cus_1",
      offSession: true,
    });
    await expect(attempt).rejects.toMatchObject({ code: "INVALID_REQUEST", provider: "stripe", retryable: false });
    await expect(attempt).rejects.toThrow(/offSession requires paymentMethodId/);
    expect(calls).toHaveLength(0);
  });

  test("a server-side confirm that needs 3-D Secure returns pending with the clientSecret for stripe.handleNextAction()", async () => {
    nextResult = stripeIntent({ status: "requires_action", client_secret: "pi_123_secret_3ds" });
    const intent = await provider().createPayment({
      amount: { amount: 4999, currency: "USD" },
      idempotencyKey: "k_3ds",
      paymentMethodId: "pm_card_threeDSecure2Required",
    });
    expect(intent.status).toBe("pending");
    expect(intent.clientSecret).toBe("pi_123_secret_3ds");
  });

  test("an off-session charge the bank wants authenticated is a non-retryable authentication_required error", async () => {
    nextError = { type: "StripeCardError", code: "authentication_required", message: "Your card requires authentication." };
    const executor = new IdempotentPaymentExecutor(provider(), { retry: { maxAttempts: 3, initialDelayMs: 1 } });
    await expect(
      executor.execute({
        amount: { amount: 9900, currency: "USD" },
        idempotencyKey: "sub_u1_2026-11",
        paymentMethodId: "pm_saved",
        customerId: "cus_1",
        offSession: true,
      }),
    ).rejects.toMatchObject({ code: "authentication_required", retryable: false, provider: "stripe" });
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["requires_payment_method", "pending"],
    ["requires_confirmation", "pending"],
    ["requires_action", "pending"],
    ["processing", "processing"],
    ["requires_capture", "processing"],
    ["succeeded", "succeeded"],
    ["canceled", "cancelled"],
    ["some_future_status", "pending"],
  ])("maps Stripe status %s to %s", async (stripeStatus, expected) => {
    nextResult = stripeIntent({ status: stripeStatus });
    expect((await provider().getPayment("pi_123")).status).toBe(expected);
  });

  test("a status named after an Object.prototype member is unknown, so pending", async () => {
    nextResult = stripeIntent({ status: "constructor" });
    expect((await provider().getPayment("pi_123")).status).toBe("pending");
  });

  test.each(["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "succeeded", "canceled"])(
    "a PaymentIntent's status %s never maps to a refund status, unlike MockProvider's (the docs say so)",
    async (stripeStatus) => {
      nextResult = stripeIntent({ status: stripeStatus, latest_charge: { refunded: true, amount_refunded: 4999 } });
      const { status } = await provider().getPayment("pi_123");
      expect(["refunded", "partially_refunded"]).not.toContain(status);
    },
  );

  test("maps Stripe's client_secret onto intent.clientSecret (what Stripe.js needs)", async () => {
    nextResult = stripeIntent({ status: "requires_payment_method", client_secret: "pi_123_secret_Xyz789" });
    const intent = await provider().createPayment({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "k_cs" });
    expect(intent.clientSecret).toBe("pi_123_secret_Xyz789");
    expect(intent.clientSecret).not.toBe(intent.providerPaymentId);
  });

  test("surfaces last_payment_error on the intent", async () => {
    nextResult = stripeIntent({
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined", message: "Your card was declined." },
    });
    const intent = await provider().getPayment("pi_123");
    expect(intent.errorCode).toBe("card_declined");
    expect(intent.errorMessage).toBe("Your card was declined.");
  });

  test("capture, cancel and retrieve hit the matching endpoint with the id", async () => {
    const p = provider();
    await p.capturePayment("pi_cap");
    await p.cancelPayment("pi_can");
    await p.getPayment("pi_get");
    expect(calls.map((c) => [c.method, c.args[0]])).toEqual([
      ["paymentIntents.capture", "pi_cap"],
      ["paymentIntents.cancel", "pi_can"],
      ["paymentIntents.retrieve", "pi_get"],
    ]);
  });

  test("listPayments defaults the page size and maps every intent", async () => {
    nextResult = { data: [stripeIntent({ id: "pi_a" }), stripeIntent({ id: "pi_b", status: "canceled" })] };
    const list = await provider().listPayments();
    expect(calls[0].args[0]).toEqual({ limit: 10, starting_after: undefined });
    expect(list.map((i) => [i.id, i.status])).toEqual([
      ["pi_a", "succeeded"],
      ["pi_b", "cancelled"],
    ]);
  });

  test("listPayments forwards pagination options", async () => {
    nextResult = { data: [] };
    await provider().listPayments({ limit: 3, startingAfter: "pi_last" });
    expect(calls[0].args[0]).toEqual({ limit: 3, starting_after: "pi_last" });
  });
});

describe("StripeProvider refunds", () => {
  const provider = () => new StripeProvider({ secretKey: "sk_test_x" });

  test("a refund status named after an Object.prototype member is unknown, so pending", async () => {
    nextResult = { id: "re_1", amount: 1500, currency: "usd", status: "constructor", created: 1_700_000_100 };
    const result = await provider().refundPayment({ paymentId: "pi_123", idempotencyKey: "refund-odd" });
    expect(result.status).toBe("pending");
  });

  test("a partial refund forwards amount, reason and idempotency key", async () => {
    nextResult = { id: "re_1", amount: 1500, currency: "usd", status: "succeeded", created: 1_700_000_100 };
    const result = await provider().refundPayment({
      paymentId: "pi_123",
      amount: { amount: 1500, currency: "USD" },
      reason: "requested_by_customer",
      idempotencyKey: "refund-1",
    });
    // The payment is read first (currency check), then the refund is created.
    expect(calls.map((c) => c.method)).toEqual(["paymentIntents.retrieve", "refunds.create"]);
    expect(calls[0].args).toEqual(["pi_123"]);
    expect(calls[1].args).toEqual([
      { payment_intent: "pi_123", amount: 1500, reason: "requested_by_customer" },
      { idempotencyKey: "refund-1" },
    ]);
    expect(result).toEqual({
      refundId: "re_1",
      paymentId: "pi_123",
      amount: { amount: 1500, currency: "USD" },
      status: "succeeded",
      createdAt: new Date(1_700_000_100_000),
    });
  });

  test.each([
    ["0 (would have been sent as a full refund by a truthiness check)", 0],
    ["a float", 15.5],
    ["a negative amount", -100],
    ["NaN", Number.NaN],
  ])("a partial refund of %s is refused with INVALID_AMOUNT before any Stripe call", async (_name, amount) => {
    await expect(
      provider().refundPayment({ paymentId: "pi_123", amount: { amount, currency: "USD" }, idempotencyKey: "refund-bad" }),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    expect(calls).toHaveLength(0);
  });

  test("a partial refund in another currency than the payment is refused before any refund is created", async () => {
    nextResult = stripeIntent({ currency: "usd" });
    const attempt = provider().refundPayment({ paymentId: "pi_123", amount: { amount: 1500, currency: "EUR" }, idempotencyKey: "refund_eur" });
    await expect(attempt).rejects.toMatchObject({ code: "INVALID_REQUEST", provider: "stripe", retryable: false });
    await expect(attempt).rejects.toThrow(/EUR does not match payment pi_123 in USD/);
    expect(calls.filter((c) => c.method === "refunds.create")).toHaveLength(0);
  });

  test("the currency check is case-insensitive (Stripe returns usd)", async () => {
    nextResult = { id: "re_c", amount: 1500, currency: "usd", status: "succeeded", created: 1_700_000_400 };
    const result = await provider().refundPayment({ paymentId: "pi_123", amount: { amount: 1500, currency: "Usd" }, idempotencyKey: "refund_usd" });
    expect(result.refundId).toBe("re_c");
  });

  test("a failure reading the payment is mapped like any Stripe error and creates no refund", async () => {
    nextError = { type: "StripeInvalidRequestError", message: "No such payment_intent", code: "resource_missing", param: "intent" };
    await expect(
      provider().refundPayment({ paymentId: "pi_missing", amount: { amount: 1500, currency: "USD" }, idempotencyKey: "refund_missing" }),
    ).rejects.toMatchObject({ code: "resource_missing", param: "intent", retryable: false });
    expect(calls.map((c) => c.method)).toEqual(["paymentIntents.retrieve"]);
  });

  test.each([
    ["no key", undefined],
    ["an empty key", ""],
  ])("a refund with %s is refused before any Stripe call (a retry would refund twice)", async (_name, key) => {
    await expect(
      provider().refundPayment({ paymentId: "pi_123", idempotencyKey: key as unknown as string }),
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY", provider: "stripe", retryable: false });
    expect(calls).toHaveLength(0);
  });

  test("a full refund sends only the payment intent, with its key; non-succeeded maps to pending", async () => {
    nextResult = { id: "re_2", amount: 4999, currency: "usd", status: "pending", created: 1_700_000_200 };
    const result = await provider().refundPayment({ paymentId: "pi_123", idempotencyKey: "refund_full_1" });
    expect(calls[0].args).toEqual([{ payment_intent: "pi_123" }, { idempotencyKey: "refund_full_1" }]);
    expect(result.status).toBe("pending");
  });
});

describe("StripeProvider refund status mapping", () => {
  test.each([
    ["succeeded", "succeeded"],
    ["pending", "pending"],
    ["requires_action", "pending"],
    ["failed", "failed"],
    ["canceled", "cancelled"],
    ["some_future_status", "pending"],
  ])("maps Stripe refund status %s to %s", async (stripeStatus, expected) => {
    nextResult = { id: "re_s", amount: 100, currency: "usd", status: stripeStatus, created: 1_700_000_300 };
    const result = await new StripeProvider({ secretKey: "sk_test_x" }).refundPayment({ paymentId: "pi_123", idempotencyKey: "refund_s" });
    expect(result.status).toBe(expected);
  });
});

describe("StripeProvider error mapping", () => {
  const provider = () => new StripeProvider({ secretKey: "sk_test_x" });

  test.each([
    [{ type: "StripeCardError", message: "Declined", code: "card_declined" }, "card_declined", false, "Declined"],
    [{ type: "StripeCardError", message: "Declined" }, "card_error", false, "Declined"],
    [{ type: "StripeRateLimitError", message: "slow down" }, "rate_limit", true, "Rate limited by Stripe"],
    // Stripe's code is the code; `param` is exposed separately (see the next test).
    [{ type: "StripeInvalidRequestError", message: "Bad amount", code: "parameter_invalid_integer", param: "amount" }, "parameter_invalid_integer", false, "Bad amount"],
    [{ type: "StripeInvalidRequestError", message: "Bad amount", param: "amount" }, "invalid_request", false, "Bad amount"],
    [{ type: "StripeInvalidRequestError", message: "Bad request" }, "invalid_request", false, "Bad request"],
    [{ type: "StripeAuthenticationError", message: "Invalid API Key" }, "authentication_error", false, "Invalid API Key"],
    [{ type: "StripePermissionError", message: "No access" }, "permission_error", false, "No access"],
    [{ type: "StripeAPIError", message: "boom" }, "server_error", true, "boom"],
    // stripe-node 22: a timeout is a StripeConnectionError whose detail has code ETIMEDOUT.
    [
      { type: "StripeConnectionError", message: "Request aborted due to timeout being reached (20000ms)", detail: { code: "ETIMEDOUT" } },
      "timeout",
      true,
      "Request aborted due to timeout being reached (20000ms)",
    ],
    [
      { type: "StripeConnectionError", message: "An error occurred with our connection to Stripe.", detail: { code: "ECONNRESET" } },
      "network_error",
      true,
      "An error occurred with our connection to Stripe.",
    ],
    // Not a Stripe API outcome: reported, not retried blindly.
    [{}, "unknown", false, "Unknown error"],
    [new TypeError("Cannot read properties of undefined"), "unknown", false, "Cannot read properties of undefined"],
  ])("maps %o to code %s (retryable=%s)", async (stripeErr, code, retryable, message) => {
    nextError = stripeErr;
    const err = await provider().getPayment("pi_123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toBeInstanceOf(PayKitError);
    expect(err).toMatchObject({ code, retryable, message, provider: "stripe" });
  });

  test.each([
    [{ type: "StripeAPIError", message: "boom" }, "server_error"],
    [{ type: "StripeConnectionError", message: "timed out", detail: { code: "ETIMEDOUT" } }, "timeout"],
    [{ type: "StripeConnectionError", message: "reset", detail: { code: "ECONNRESET" } }, "network_error"],
    [{ type: "StripeInvalidRequestError", code: "idempotency_key_in_use", message: "in use" }, "idempotency_key_in_use"],
    [new TypeError("Cannot read properties of undefined"), "unknown"],
  ])("%o may have charged, so %s says its outcome is unknown", async (stripeErr, code) => {
    nextError = stripeErr;
    const err = await provider().createPayment({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "k_unknown" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code, outcomeUnknown: true });
  });

  test.each([
    [{ type: "StripeCardError", message: "Declined", code: "card_declined" }, "card_declined"],
    [{ type: "StripeRateLimitError", message: "slow down" }, "rate_limit"],
    [{ type: "StripeInvalidRequestError", message: "Bad amount", code: "parameter_invalid_integer" }, "parameter_invalid_integer"],
    [{ type: "StripeAuthenticationError", message: "Invalid API Key" }, "authentication_error"],
    [{ type: "StripePermissionError", message: "No access" }, "permission_error"],
  ])("%o says Stripe did not act, so %s does not claim an unknown outcome", async (stripeErr, code) => {
    nextError = stripeErr;
    const err = (await provider().createPayment({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "k_known" }).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(err.code).toBe(code);
    expect(err.outcomeUnknown).toBeUndefined();
  });

  test("a Stripe idempotency conflict is a non-retryable IdempotencyError carrying the key", async () => {
    nextError = { type: "StripeIdempotencyError", message: "Keys for idempotent requests can only be used with the same parameters" };
    const err = await provider()
      .createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "order-77" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyError);
    expect(err).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", provider: "stripe", retryable: false });
    expect((err as Error).message).toContain("order-77");
  });

  test("the executor does not retry a Stripe idempotency conflict (one API call, not maxAttempts)", async () => {
    nextError = { type: "StripeIdempotencyError", message: "reused key" };
    const executor = new IdempotentPaymentExecutor(provider(), { retry: { maxAttempts: 3, initialDelayMs: 1 } });
    await expect(
      executor.execute({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "order-78" }),
    ).rejects.toThrow(IdempotencyError);
    expect(calls.filter((c) => c.method === "paymentIntents.create")).toHaveLength(1);
  });

  test.each([
    ["resource_missing", "No such payment_intent: 'pi_gone'", "intent"],
    ["charge_already_refunded", "Charge ch_1 has already been refunded.", undefined],
  ])("an invalid-request error keeps Stripe's code (%s) and exposes param separately", async (code, message, param) => {
    nextError = { type: "StripeInvalidRequestError", code, message, param };
    const err = await provider().getPayment("pi_gone").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code, message, param, retryable: false });
  });

  test("idempotency_key_in_use (the key's first request is still running) is retryable, not a parameter conflict", async () => {
    nextError = {
      type: "StripeIdempotencyError",
      code: "idempotency_key_in_use",
      message: "There is currently another in-progress request using this Idempotent Key.",
    };
    const err = await provider()
      .createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "order-79" })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(IdempotencyError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code: "idempotency_key_in_use", retryable: true, provider: "stripe" });
  });

  test("the executor retries idempotency_key_in_use under the same key and returns the payment", async () => {
    // A client-side timeout fires while Stripe is still executing attempt 1;
    // the executor's retry meets the in-flight key, then the replayed result.
    const p = provider();
    await p.ready();
    const executor = new IdempotentPaymentExecutor(p, { retry: { maxAttempts: 3, initialDelayMs: 1 } });
    let attempt = 0;
    const stripeClient = (p as unknown as { stripe: { paymentIntents: { create: (...a: unknown[]) => Promise<unknown> } } }).stripe;
    stripeClient.paymentIntents.create = async (...args: unknown[]) => {
      calls.push({ method: "paymentIntents.create", args });
      attempt++;
      if (attempt === 1) throw { type: "StripeIdempotencyError", code: "idempotency_key_in_use", message: "in progress" };
      return stripeIntent({ id: "pi_once" });
    };
    const intent = await executor.execute({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order-80" });
    expect(intent.id).toBe("pi_once");
    expect(calls.map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey)).toEqual(["order-80", "order-80"]);
  });

  test("every operation routes SDK failures through the error mapper", async () => {
    nextError = { type: "StripeRateLimitError" };
    const p = provider();
    const ops: Promise<unknown>[] = [
      p.createPayment({ amount: { amount: 1, currency: "USD" }, idempotencyKey: "k" }),
      p.capturePayment("pi_1"),
      p.cancelPayment("pi_1"),
      p.refundPayment({ paymentId: "pi_1", idempotencyKey: "refund_rl" }),
      p.listPayments(),
    ];
    for (const op of ops) {
      await expect(op).rejects.toMatchObject({ code: "rate_limit", retryable: true });
    }
  });
});
