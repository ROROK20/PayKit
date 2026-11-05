/**
 * StripeProvider against the REAL stripe-node (the exact-pinned
 * devDependency), with only the network replaced. A scripted HttpClient —
 * stripe-node's own extension point — answers each request the way Stripe's
 * API would, and records what the SDK put on the wire. So the adapter's
 * request mapping and error mapping are checked against the SDK itself, not
 * against a hand-written model of it. No socket is ever opened.
 */

import fs from "fs";
import path from "path";
import { inspect } from "util";

import { IdempotentPaymentExecutor } from "../src/payments/idempotent";
import { StripeConstructor, StripeProvider } from "../src/providers/stripe";
import { IdempotencyError, ProviderError } from "../src/types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RealStripe = require("stripe");

type Reply = [status: number, body: unknown] | "TIMEOUT" | "RESET";
interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

class ScriptedResponse extends RealStripe.HttpClientResponse {
  constructor(status: number, private readonly body: unknown) {
    super(status, { "request-id": "req_test" });
  }
  toJSON(): Promise<unknown> {
    return Promise.resolve(this.body);
  }
  getRawResponse(): unknown {
    return {};
  }
}

class ScriptedHttpClient extends RealStripe.HttpClient {
  script: Reply[] = [];
  sent: Sent[] = [];
  getClientName(): string {
    return "paykit-scripted";
  }
  makeRequest(_host: string, _port: string, path: string, method: string, headers: Record<string, string>, body: string): Promise<unknown> {
    this.sent.push({ method, path, headers, body: decodeURIComponent(body ?? "") });
    const next = this.script.shift() ?? [500, { error: { type: "api_error", message: "script exhausted" } }];
    if (next === "TIMEOUT") return Promise.reject(Object.assign(new TypeError("ETIMEDOUT"), { code: "ETIMEDOUT" }));
    if (next === "RESET") return Promise.reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    return Promise.resolve(new ScriptedResponse(next[0], next[1]));
  }
}

function realStripeProvider(config: { maxNetworkRetries?: number } = {}) {
  const http = new ScriptedHttpClient();
  // The adapter constructs the client itself (pinned apiVersion, timeout,
  // retries); this wrapper only adds the scripted transport.
  const Stripe = function (key: string, options: Record<string, unknown>) {
    return new RealStripe(key, { ...options, httpClient: http });
  } as unknown as StripeConstructor;
  const provider = new StripeProvider({ secretKey: "sk_test_scripted", Stripe, maxNetworkRetries: 0, ...config });
  return { http, provider };
}

const intent = (overrides: Record<string, unknown> = {}) => ({
  id: "pi_real_1",
  object: "payment_intent",
  status: "succeeded",
  amount: 4999,
  currency: "usd",
  metadata: { orderId: "ord_1" },
  created: 1_700_000_000,
  client_secret: "pi_real_1_secret_x",
  ...overrides,
});
const stripeError = (status: number, error: Record<string, unknown>): Reply => [status, { error }];

describe("StripeProvider × real stripe-node (scripted transport)", () => {
  test("captureMethod: manual reaches Stripe, reads as processing, and capturePayment finishes it", async () => {
    const { http, provider } = realStripeProvider();
    http.script.push([200, intent({ id: "pi_auth", status: "requires_capture" })]);
    const authorized = await provider.createPayment({
      amount: { amount: 4999, currency: "USD" },
      idempotencyKey: "order_hold",
      paymentMethodId: "pm_card_visa",
      captureMethod: "manual",
    });
    expect(authorized.status).toBe("processing");
    expect(http.sent[0].body.split("&")).toContain("capture_method=manual");

    http.script.push([200, intent({ id: "pi_auth", status: "succeeded" })]);
    const captured = await provider.capturePayment(authorized.id);
    expect(captured.status).toBe("succeeded");
    expect(http.sent[1].path).toBe("/v1/payment_intents/pi_auth/capture");
  });

  test("control: without captureMethod no capture_method goes on the wire", async () => {
    const { http, provider } = realStripeProvider();
    http.script.push([200, intent()]);
    await provider.createPayment({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_auto", paymentMethodId: "pm_card_visa" });
    expect(http.sent[0].body).not.toContain("capture_method");
  });

  describe("a decline carries what recovery needs", () => {
    const secret = "pi_declined_secret_DoNotLogMe";
    const left = intent({ id: "pi_declined", status: "requires_payment_method", client_secret: secret });
    const renewal = {
      amount: { amount: 4999, currency: "USD" },
      idempotencyKey: "renewal_1",
      paymentMethodId: "pm_saved",
      customerId: "cus_1",
      offSession: true,
    };

    test("off-session authentication_required: the same PaymentIntent is recovered, with no second one created", async () => {
      const { http, provider } = realStripeProvider();
      http.script.push(
        stripeError(402, {
          type: "card_error",
          code: "authentication_required",
          decline_code: "authentication_required",
          message: "This transaction requires authentication.",
          payment_intent: left,
        }),
      );
      const err = await provider.createPayment(renewal).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({
        code: "authentication_required",
        retryable: false,
        declineCode: "authentication_required",
        paymentIntentId: "pi_declined",
      });

      http.script.push([200, left]);
      const recovered = await provider.getPayment((err as ProviderError).paymentIntentId!);
      expect(recovered).toMatchObject({ id: "pi_declined", status: "pending", clientSecret: secret });
      expect(http.sent.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1/payment_intents", "GET /v1/payment_intents/pi_declined"]);
    });

    test("the client secret stays off the error, so logging it cannot leak it", async () => {
      const { http, provider } = realStripeProvider();
      http.script.push(stripeError(402, { type: "card_error", code: "authentication_required", message: "m", payment_intent: left }));
      const err = await provider.createPayment(renewal).catch((e: unknown) => e);
      expect(inspect(err, { depth: 5 })).not.toContain(secret);
      expect(JSON.stringify(err)).not.toContain(secret);
    });

    test("the fields survive the executor, and an issuer's reason comes through on a plain decline", async () => {
      const { http, provider } = realStripeProvider();
      http.script.push(
        stripeError(402, {
          type: "card_error",
          code: "card_declined",
          decline_code: "insufficient_funds",
          message: "Your card has insufficient funds.",
          payment_intent: left,
        }),
      );
      await expect(new IdempotentPaymentExecutor(provider).execute(renewal)).rejects.toMatchObject({
        code: "card_declined",
        declineCode: "insufficient_funds",
        paymentIntentId: "pi_declined",
      });
      expect(http.sent).toHaveLength(1); // not retryable
    });

    test("an error naming neither reports neither", async () => {
      const { http, provider } = realStripeProvider();
      http.script.push(stripeError(402, { type: "card_error", code: "card_declined", message: "Your card was declined." }));
      const err = (await provider.createPayment(renewal).catch((e: unknown) => e)) as ProviderError;
      expect(err.code).toBe("card_declined");
      expect(err.declineCode).toBeUndefined();
      expect(err.paymentIntentId).toBeUndefined();
    });

    test("an invalid-request error that names a PaymentIntent carries it too", async () => {
      const { http, provider } = realStripeProvider();
      http.script.push(stripeError(400, { type: "invalid_request_error", code: "payment_intent_unexpected_state", message: "m", param: "x", payment_intent: left }));
      const err = (await provider.getPayment("pi_declined").catch((e: unknown) => e)) as ProviderError;
      expect(err).toMatchObject({ code: "payment_intent_unexpected_state", param: "x", paymentIntentId: "pi_declined" });
    });
  });

  test("stripe-node is the pinned devDependency, not a stand-in", () => {
    expect(RealStripe.PACKAGE_VERSION).toBe(require("../package.json").devDependencies.stripe);
  });

  test("a server-side confirm puts exactly the adapter's parameters, key and API version on the wire", async () => {
    const { http, provider } = realStripeProvider();
    http.script.push([200, intent()]);
    const result = await provider.createPayment({
      amount: { amount: 4999, currency: "USD" },
      idempotencyKey: "order_ord_1",
      paymentMethodId: "pm_card_visa",
      customerId: "cus_1",
      metadata: { orderId: "ord_1" },
    });
    expect(result).toMatchObject({ id: "pi_real_1", status: "succeeded", clientSecret: "pi_real_1_secret_x", amount: { amount: 4999, currency: "USD" } });
    const [req] = http.sent;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/payment_intents");
    expect(req.headers["Idempotency-Key"]).toBe("order_ord_1");
    expect(req.headers["Stripe-Version"]).toBe("2024-06-20");
    expect(req.body.split("&").sort()).toEqual(
      [
        "amount=4999",
        "currency=usd",
        "customer=cus_1",
        "payment_method=pm_card_visa",
        "confirm=true",
        "metadata[orderId]=ord_1",
        "automatic_payment_methods[enabled]=true",
        "automatic_payment_methods[allow_redirects]=never",
      ].sort(),
    );
  });

  test("an unconfirmed intent (no payment method) maps requires_payment_method to pending", async () => {
    const { http, provider } = realStripeProvider();
    http.script.push([200, intent({ status: "requires_payment_method" })]);
    const result = await provider.createPayment({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_unconfirmed" });
    expect(result.status).toBe("pending");
    expect(http.sent[0].body).toContain("confirm=false");
  });

  test.each([
    [
      "card_declined (402 card_error)",
      stripeError(402, { type: "card_error", code: "card_declined", decline_code: "generic_decline", message: "Your card was declined." }),
      { code: "card_declined", retryable: false },
    ],
    [
      "idempotency_key_in_use (409)",
      stripeError(409, { type: "idempotency_error", code: "idempotency_key_in_use", message: "There is currently another in-progress request using this Idempotent Key." }),
      { code: "idempotency_key_in_use", retryable: true },
    ],
    [
      "resource_missing (404 invalid_request_error)",
      stripeError(404, { type: "invalid_request_error", code: "resource_missing", param: "intent", message: "No such payment_intent: 'pi_x'" }),
      { code: "resource_missing", param: "intent", retryable: false },
    ],
    ["an authentication error (401)", stripeError(401, { type: "invalid_request_error", message: "Invalid API Key provided" }), { code: "authentication_error", retryable: false }],
    ["a rate limit (429)", stripeError(429, { type: "invalid_request_error", code: "rate_limit", message: "Too many requests" }), { code: "rate_limit", retryable: true }],
    ["a Stripe-side failure (500 api_error)", stripeError(500, { type: "api_error", message: "Something went wrong" }), { code: "server_error", retryable: true }],
  ])("the real SDK's %s maps to the documented ProviderError", async (_name, reply, expected) => {
    const { http, provider } = realStripeProvider();
    http.script.push(reply);
    const err = await provider.createPayment({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_err", paymentMethodId: "pm_x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ provider: "stripe", ...expected });
  });

  test("a 500 from the real SDK: every retry goes out under the one key, and the error says the outcome is unknown", async () => {
    const { http, provider } = realStripeProvider();
    const answer500 = stripeError(500, { type: "api_error", message: "Something went wrong" });
    http.script.push(answer500, answer500, answer500);
    const executor = new IdempotentPaymentExecutor(provider, { retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 } });
    const err = await executor.execute({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_500", paymentMethodId: "pm_x" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "server_error", retryable: true, outcomeUnknown: true });
    expect(http.sent.length).toBeGreaterThanOrEqual(3);
    expect(new Set(http.sent.map((s) => s.headers["Idempotency-Key"]))).toEqual(new Set(["order_500"]));
    expect(http.sent[0].body).toContain("confirm=true");
  });

  test("the README's account of a Stripe 500 rests on a comment that is still in the pinned stripe-node", () => {
    const source = fs.readFileSync(path.join(__dirname, "../node_modules/stripe/cjs/RequestSender.js"), "utf8");
    expect(source).toMatch(/our idempotency framework\s*\/\/\s*would typically replay it anyway/);
    const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
    expect(readme).toContain("**A Stripe 500 leaves the outcome unknown");
    expect(readme).toContain("**Reconcile against the provider before any new key.**");
    expect(readme).toContain("has not been observed against live Stripe");
  });

  test("a key reused with different parameters (400 idempotency_error) is an IdempotencyError", async () => {
    const { http, provider } = realStripeProvider();
    http.script.push(stripeError(400, { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." }));
    const err = await provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "order_reused" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyError);
    expect(err).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", retryable: false });
  });

  test("a timeout (ETIMEDOUT) surfaces from the real SDK as a retryable `timeout`", async () => {
    const { http, provider } = realStripeProvider();
    http.script.push("TIMEOUT");
    const err = await provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "order_timeout" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "timeout", retryable: true });
    expect(http.sent).toHaveLength(1);
  });

  test("a dropped connection: stripe-node retries it once even at maxNetworkRetries 0 (same key), then a retryable `network_error`", async () => {
    // Learned from the real SDK, not assumed: a closed connection (ECONNRESET)
    // gets one retry regardless of maxNetworkRetries.
    const { http, provider } = realStripeProvider();
    http.script.push("RESET", "RESET");
    const err = await provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "order_reset" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "network_error", retryable: true });
    expect(http.sent.map((s) => s.headers["Idempotency-Key"])).toEqual(["order_reset", "order_reset"]);
  });

  test("stripe-node's own retry (maxNetworkRetries: 1) re-sends the SAME idempotency key", async () => {
    const { http, provider } = realStripeProvider({ maxNetworkRetries: 1 });
    http.script.push("TIMEOUT", [200, intent()]);
    await expect(provider.createPayment({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_sdk_retry" })).resolves.toMatchObject({ id: "pi_real_1" });
    expect(http.sent.map((s) => s.headers["Idempotency-Key"])).toEqual(["order_sdk_retry", "order_sdk_retry"]);
  });

  test("the executor's retry after a timeout re-sends the same key through the real SDK", async () => {
    const { http, provider } = realStripeProvider();
    const executor = new IdempotentPaymentExecutor(provider, { retry: { maxAttempts: 3, initialDelayMs: 1 } });
    http.script.push("TIMEOUT", [200, intent()]);
    await expect(executor.execute({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_exec_retry" })).resolves.toMatchObject({ id: "pi_real_1" });
    expect(http.sent.map((s) => [s.path, s.headers["Idempotency-Key"]])).toEqual([
      ["/v1/payment_intents", "order_exec_retry"],
      ["/v1/payment_intents", "order_exec_retry"],
    ]);
  });

  test("a partial refund reads the PaymentIntent, then posts the refund with its key", async () => {
    const { http, provider } = realStripeProvider();
    http.script.push([200, intent({ id: "pi_paid" })], [200, { id: "re_1", object: "refund", amount: 1500, currency: "usd", status: "succeeded", created: 1_700_000_100 }]);
    const refund = await provider.refundPayment({ paymentId: "pi_paid", amount: { amount: 1500, currency: "USD" }, idempotencyKey: "refund_ord_1_rt_1" });
    expect(refund).toMatchObject({ refundId: "re_1", status: "succeeded", amount: { amount: 1500, currency: "USD" } });
    expect(http.sent.map((s) => [s.method, s.path])).toEqual([
      ["GET", "/v1/payment_intents/pi_paid"],
      ["POST", "/v1/refunds"],
    ]);
    expect(http.sent[1].headers["Idempotency-Key"]).toBe("refund_ord_1_rt_1");
    expect(http.sent[1].body.split("&").sort()).toEqual(["amount=1500", "payment_intent=pi_paid"]);
  });
});
