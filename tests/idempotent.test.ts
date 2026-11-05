/**
 * Tests for idempotent payment executor.
 */

import { format, inspect } from "util";

import {
  IdempotentPaymentExecutor,
  InMemoryIdempotencyStore,
  RetryConfig,
  assertValidMoney,
} from "../src/payments/idempotent";
import { idempotencyStoreKey } from "../src/index";
import { fingerprintRequest } from "../src/payments/fingerprint";
import { MockProvider } from "../src/providers/mock";
import {
  CreatePaymentRequest,
  IdempotencyError,
  PaymentIntent,
  PaymentProvider,
  PaymentProvider_Interface,
  PaymentResultNotStoredError,
  PaymentStatus,
  PayKitError,
  ProviderError,
} from "../src/types";

function makeRequest(key: string, amount = 5000): CreatePaymentRequest {
  return {
    amount: { amount, currency: "USD" },
    idempotencyKey: key,
    description: "Test payment",
  };
}

describe("InMemoryIdempotencyStore", () => {
  let store: InMemoryIdempotencyStore;
  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
  });

  test("set and get returns same intent", async () => {
    const intent: PaymentIntent = {
      id: "pay_1",
      idempotencyKey: "key_1",
      provider: "mock",
      status: "succeeded",
      amount: { amount: 5000, currency: "USD" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await store.set("key_1", { intent, fingerprint: "fp" });
    const retrieved = await store.get("key_1");
    expect(retrieved?.intent.id).toBe("pay_1");
  });

  test("get returns null for unknown key", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  test("has returns true for existing key", async () => {
    const intent: PaymentIntent = {
      id: "pay_2",
      idempotencyKey: "key_2",
      provider: "mock",
      status: "succeeded",
      amount: { amount: 1000, currency: "USD" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await store.set("key_2", { intent, fingerprint: "fp" });
    expect(await store.has("key_2")).toBe(true);
    expect(await store.has("key_9")).toBe(false);
  });

  test("delete removes key", async () => {
    const intent: PaymentIntent = {
      id: "pay_3",
      idempotencyKey: "key_3",
      provider: "mock",
      status: "succeeded",
      amount: { amount: 1000, currency: "USD" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await store.set("key_3", { intent, fingerprint: "fp" });
    await store.delete("key_3");
    expect(await store.has("key_3")).toBe(false);
  });

  test("delete leaves an in-flight reservation with its owner (the store contract)", async () => {
    const token = await store.reserve("key_res");
    expect(token).toEqual(expect.any(String));
    await store.delete("key_res");
    expect(await store.reserve("key_res")).toBeNull(); // still reserved: no second winner
    await store.release("key_res", token!);
    expect(await store.reserve("key_res")).toEqual(expect.any(String)); // only its owner frees it
  });

  test("reserve() returns a token unique to each reservation, and release() needs that token", async () => {
    // The shape a TTL'd store (Redis PX) needs: A's marker expires, B reserves,
    // then A's late release must not delete B's reservation.
    const first = await store.reserve("key_tok");
    expect(first).toEqual(expect.any(String));
    await store.release("key_tok", "someone_elses_token"); // a stale release...
    expect(await store.reserve("key_tok")).toBeNull(); // ...left the reservation in place
    await store.release("key_tok", first!);
    const second = await store.reserve("key_tok");
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    await store.release("key_tok", first!); // the first token frees nothing
    expect(await store.reserve("key_tok")).toBeNull();
  });

  test("the executor releases a failed reservation with the token reserve() returned", async () => {
    const inner = new InMemoryIdempotencyStore();
    const seen: { reserved: (string | null)[]; released: [string, string][] } = { reserved: [], released: [] };
    const spyStore = {
      get: (k: string) => inner.get(k),
      set: (k: string, r: Parameters<InMemoryIdempotencyStore["set"]>[1], t?: number) => inner.set(k, r, t),
      delete: (k: string) => inner.delete(k),
      has: (k: string) => inner.has(k),
      reserve: async (k: string) => {
        const t = await inner.reserve(k);
        seen.reserved.push(t);
        return t;
      },
      release: async (k: string, t: string) => {
        seen.released.push([k, t]);
        return inner.release(k, t);
      },
    };
    const failing: PaymentProvider_Interface = {
      name: "mock",
      createPayment: async () => {
        throw new ProviderError("declined", "card_declined", "mock", false);
      },
      capturePayment: jest.fn(),
      cancelPayment: jest.fn(),
      refundPayment: jest.fn(),
      getPayment: jest.fn(),
      listPayments: jest.fn(),
    };
    const ex = new IdempotentPaymentExecutor(failing, { store: spyStore });
    await expect(ex.execute(makeRequest("key_release_token"))).rejects.toMatchObject({ code: "card_declined" });
    expect(seen.reserved).toHaveLength(1);
    expect(seen.released).toEqual([[JSON.stringify(["mock", null, "key_release_token"]), seen.reserved[0]]]);
    expect(await inner.reserve("key_release_token")).toEqual(expect.any(String)); // actually freed
  });

  test("expired key returns null", async () => {
    const intent: PaymentIntent = {
      id: "pay_exp",
      idempotencyKey: "key_exp",
      provider: "mock",
      status: "succeeded",
      amount: { amount: 1000, currency: "USD" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // TTL of -1ms = already expired
    await store.set("key_exp", { intent, fingerprint: "fp" }, -1);
    expect(await store.get("key_exp")).toBeNull();
  });
});

describe("IdempotentPaymentExecutor", () => {
  let provider: MockProvider;
  let executor: IdempotentPaymentExecutor;

  beforeEach(() => {
    provider = new MockProvider({ successRate: 1.0 }); // always succeed
    executor = new IdempotentPaymentExecutor(provider);
  });

  test("executes payment on first call", async () => {
    const result = await executor.execute(makeRequest("key_001"));
    expect(result.id).toBeDefined();
    expect(result.status).toBe("succeeded");
  });

  test("returns cached result on duplicate key", async () => {
    const first = await executor.execute(makeRequest("key_dup"));
    const second = await executor.execute(makeRequest("key_dup"));
    expect(first.id).toBe(second.id);
  });

  test("does not double-charge on duplicate", async () => {
    const createSpy = jest.spyOn(provider, "createPayment");
    await executor.execute(makeRequest("key_nodup2"));
    await executor.execute(makeRequest("key_nodup2"));
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  test("does not double-charge under CONCURRENT calls with the same key (the race)", async () => {
    // The classic idempotency race: many in-flight requests with the same key
    // fire simultaneously. Without an atomic reservation, all of them read
    // "no cached result" and each hits the provider → duplicate charges.
    const createSpy = jest.spyOn(provider, "createPayment");
    const req = makeRequest("key_concurrent_race");
    const results = await Promise.all(
      Array.from({ length: 12 }, () => executor.execute(req)),
    );
    // The provider must be invoked EXACTLY once...
    expect(createSpy).toHaveBeenCalledTimes(1);
    // ...and every concurrent caller must receive the same payment intent.
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  test("different keys create different payments", async () => {
    const r1 = await executor.execute(makeRequest("key_a"));
    const r2 = await executor.execute(makeRequest("key_b"));
    expect(r1.id).not.toBe(r2.id);
  });

  test("isDuplicate returns false before first call", async () => {
    expect(await executor.isDuplicate("brand_new_key")).toBe(false);
  });

  test("isDuplicate returns true after execution", async () => {
    await executor.execute(makeRequest("key_check"));
    expect(await executor.isDuplicate("key_check")).toBe(true);
  });

  test("invalidate removes from cache", async () => {
    await executor.execute(makeRequest("key_inv"));
    await executor.invalidate("key_inv");
    expect(await executor.isDuplicate("key_inv")).toBe(false);
  });

  test("invalidate does not force a re-charge: the re-sent key gets the provider's original payment", async () => {
    const first = await executor.execute(makeRequest("key_inv_resend"));
    await executor.invalidate("key_inv_resend");
    const createSpy = jest.spyOn(provider, "createPayment");
    const again = await executor.execute(makeRequest("key_inv_resend"));
    expect(createSpy).toHaveBeenCalledTimes(1); // PayKit's store has forgotten the key...
    expect(again.id).toBe(first.id); // ...and the provider replays the original payment
    expect(await provider.listPayments({ limit: 100 })).toHaveLength(1);
  });

  test("invalidate during an in-flight execute keeps the reservation: no second provider call runs alongside it", async () => {
    // The interleaving: execute() is mid-call, invalidate() runs, a second
    // execute() arrives. Dropping the pending marker here would let the second
    // caller win reserve() and charge concurrently.
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: PaymentProvider_Interface = {
      name: "mock",
      async createPayment(req) {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        const now = new Date();
        return { id: `p${calls}`, idempotencyKey: req.idempotencyKey, provider: "mock", status: "succeeded", amount: req.amount, createdAt: now, updatedAt: now };
      },
      capturePayment: jest.fn(),
      cancelPayment: jest.fn(),
      refundPayment: jest.fn(),
      getPayment: jest.fn(),
      listPayments: jest.fn(),
    };
    const ex = new IdempotentPaymentExecutor(slow, { pollIntervalMs: 5 });
    const req = makeRequest("key_inv_inflight");
    const first = ex.execute(req);
    await new Promise((r) => setTimeout(r, 5));
    await ex.invalidate("key_inv_inflight");
    const second = ex.execute(req);
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(b.id).toBe(a.id);
    expect(b.metadata?._idempotency).toBe("in_flight_join");
  });

  test("failed payment result is cached under its key (no retry storm)", async () => {
    // Design intent: a failed attempt is a RESULT, not an invitation to
    // hammer the provider — replaying the same idempotency key returns the
    // cached failure. A caller who wants a genuine retry uses a new key (or
    // invalidate()).
    const failProvider = new MockProvider({ successRate: 0.0 });
    const failExecutor = new IdempotentPaymentExecutor(failProvider, {
      retry: { maxAttempts: 1 },
    });
    const r1 = await failExecutor.execute(makeRequest("key_fail"));
    expect(r1.status).toBe("failed");
    const r2 = await failExecutor.execute(makeRequest("key_fail"));
    expect(r2.id).toBe(r1.id); // same cached result
  });
});

describe("IdempotentPaymentExecutor — conflict detection is shared through the store", () => {
  test("two servers sharing one store: reusing a key with a different amount is rejected, not served the first charge", async () => {
    // Before: the fingerprint lived in the executor that ran the key, so
    // server B — a different executor on the same store — had no record of
    // it and silently returned server A's 5000-cent charge for a 9999 request.
    const store = new InMemoryIdempotencyStore();
    const provider = new MockProvider({ successRate: 1.0 });
    const createSpy = jest.spyOn(provider, "createPayment");
    const serverA = new IdempotentPaymentExecutor(provider, { store });
    const serverB = new IdempotentPaymentExecutor(provider, { store });

    await serverA.execute(makeRequest("order_shared", 5000));
    await expect(serverB.execute(makeRequest("order_shared", 9999))).rejects.toThrow(IdempotencyError);
    // The same request from server B is a legitimate retry and is served the cached result.
    const retry = await serverB.execute(makeRequest("order_shared", 5000));
    expect(retry.metadata?._idempotency).toBe("cache_hit");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  test("a concurrent loser on another server with different params gets IdempotencyError, not the winner's result", async () => {
    const store = new InMemoryIdempotencyStore();
    const provider = new MockProvider({ successRate: 1.0, latencyMs: 30 });
    const serverA = new IdempotentPaymentExecutor(provider, { store });
    const serverB = new IdempotentPaymentExecutor(provider, { store, pollIntervalMs: 5 });

    const winner = serverA.execute(makeRequest("order_race", 5000));
    const loser = serverB.execute(makeRequest("order_race", 7500)); // loses the reservation, waits
    await expect(winner).resolves.toMatchObject({ amount: { amount: 5000 } });
    await expect(loser).rejects.toThrow(IdempotencyError);
  });

  test.each([
    ["description", { description: "A different order" }],
    ["a metadata value", { metadata: { orderId: "ord_OTHER" } }],
    ["an added metadata key", { metadata: { orderId: "ord_1", coupon: "SAVE10" } }],
    ["returnUrl", { returnUrl: "https://example.com/elsewhere" }],
    ["offSession", { offSession: true }],
    ["captureMethod", { captureMethod: "manual" as const }],
  ])("changing %s under the same key is a conflict", async (_field, change) => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0 }));
    const base: CreatePaymentRequest = { ...makeRequest("key_fields", 5000), metadata: { orderId: "ord_1" } };
    await executor.execute(base);
    await expect(executor.execute({ ...base, ...change })).rejects.toThrow(IdempotencyError);
  });

  test("equivalent requests are not conflicts: metadata key order and currency case do not matter", async () => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0 }));
    await executor.execute({ ...makeRequest("key_equiv", 5000), metadata: { a: "1", b: "2" } });
    const again = await executor.execute({
      ...makeRequest("key_equiv", 5000),
      amount: { amount: 5000, currency: "usd" },
      metadata: { b: "2", a: "1" },
    });
    expect(again.metadata?._idempotency).toBe("cache_hit");
  });

  test.each([
    ["metadata {} first, then omitted", { metadata: {} }, {}],
    ["metadata omitted first, then {}", {}, { metadata: {} }],
  ])("empty metadata is the same request as no metadata (%s): a replay, not IdempotencyError", async (_name, first, second) => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0 }));
    const original = await executor.execute({ ...makeRequest("key_meta_empty", 5000), ...first });
    const again = await executor.execute({ ...makeRequest("key_meta_empty", 5000), ...second });
    expect(again.id).toBe(original.id);
    expect(again.metadata?._idempotency).toBe("cache_hit");
    const base: CreatePaymentRequest = { amount: { amount: 1, currency: "USD" }, idempotencyKey: "k" };
    expect(fingerprintRequest({ ...base, metadata: {} })).toBe(fingerprintRequest(base));
  });

  test("captureMethod is part of the request, and a request without it keeps its stored fingerprint", () => {
    const base = { amount: { amount: 5000, currency: "usd" }, idempotencyKey: "k" };
    expect(fingerprintRequest({ ...base, captureMethod: "manual" })).not.toBe(fingerprintRequest(base));
    expect(fingerprintRequest({ ...base, captureMethod: "automatic" })).not.toBe(fingerprintRequest(base));
    expect(fingerprintRequest({ ...base, captureMethod: "manual" })).not.toBe(fingerprintRequest({ ...base, captureMethod: "automatic" }));
    expect(fingerprintRequest({ ...base, captureMethod: undefined })).toBe(fingerprintRequest(base));
  });

  test("offSession: false is the same request as no offSession, and adding the field left stored fingerprints unchanged", async () => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0 }));
    await executor.execute(makeRequest("key_offsession_false", 5000));
    const again = await executor.execute({ ...makeRequest("key_offsession_false", 5000), offSession: false });
    expect(again.metadata?._idempotency).toBe("cache_hit");

    // The exact persisted format of a request without offSession, as written
    // before the field existed: a record already in a Redis store still matches.
    expect(fingerprintRequest({ amount: { amount: 5000, currency: "usd" }, idempotencyKey: "k" })).toBe(
      '{"amount":5000,"currency":"USD","description":null,"metadata":null,"customerId":null,"paymentMethodId":null,"returnUrl":null}',
    );
  });
});

describe("IdempotentPaymentExecutor — retries re-send the key; the provider contract makes that one charge", () => {
  test("a timeout that arrives AFTER the charge: the retry re-sends the same key and gets the same payment, not a second one", async () => {
    // The ambiguous failure no client can resolve: the provider charged the
    // card, then the response was lost. `timeout` is retryable by default, so
    // the executor re-sends under the same key; the provider honouring that
    // key (here MockProvider, as Stripe does) is what keeps it to one charge.
    const provider = new MockProvider({ successRate: 1.0 });
    const realCreate = provider.createPayment.bind(provider);
    let calls = 0;
    jest.spyOn(provider, "createPayment").mockImplementation(async (req) => {
      const intent = await realCreate(req); // the charge happens...
      calls++;
      if (calls === 1) throw new ProviderError("socket timeout", "timeout", "mock", true); // ...the response is lost
      return intent;
    });
    const executor = new IdempotentPaymentExecutor(provider, { retry: { initialDelayMs: 1 } });

    const result = await executor.execute(makeRequest("order_timeout"));

    expect(calls).toBe(2); // the retry was sent — by design
    const ledger = await provider.listPayments({ limit: 100 });
    expect(ledger).toHaveLength(1); // ...and charged nothing new
    expect(result.id).toBe(ledger[0].id);
  });
});

/**
 * A provider that IGNORES idempotency keys — it violates the contract on
 * purpose, so a test using it measures only what PayKit itself guarantees.
 */
class KeyIgnoringProvider implements PaymentProvider_Interface {
  readonly name: PaymentProvider = "mock";
  creates = 0;
  constructor(private readonly status: PaymentStatus) {}
  async createPayment(req: CreatePaymentRequest): Promise<PaymentIntent> {
    this.creates++;
    const now = new Date();
    return {
      id: `ignoring_${this.creates}`,
      idempotencyKey: req.idempotencyKey,
      provider: "mock",
      status: this.status,
      amount: req.amount,
      createdAt: now,
      updatedAt: now,
    };
  }
  capturePayment(): Promise<PaymentIntent> { return Promise.reject(new Error("unused")); }
  cancelPayment(): Promise<PaymentIntent> { return Promise.reject(new Error("unused")); }
  refundPayment(): Promise<never> { return Promise.reject(new Error("unused")); }
  getPayment(): Promise<PaymentIntent> { return Promise.reject(new Error("unused")); }
  listPayments(): Promise<PaymentIntent[]> { return Promise.reject(new Error("unused")); }
}

/** Run `fn` with the wall clock moved `ms` into the future. */
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const target = Date.now() + ms;
  const clock = jest.spyOn(Date, "now").mockReturnValue(target);
  try {
    return await fn();
  } finally {
    clock.mockRestore();
  }
}

describe("IdempotentPaymentExecutor — a result in which money may have moved is never re-sent by PayKit within ttlMs", () => {
  test.each<PaymentStatus>(["processing", "pending"])(
    "a %s result is still a cache hit 61s later: no second provider call, even with a provider that ignores keys",
    async (status) => {
      // Cached only for failedTtlMs (60s), the same key would run again 61s
      // later, and a key-ignoring provider would create a second payment that
      // could still capture.
      const provider = new KeyIgnoringProvider(status);
      const executor = new IdempotentPaymentExecutor(provider);
      const req = makeRequest(`order_${status}`);
      const first = await executor.execute(req);

      const again = await later(61_000, () => executor.execute(req));

      expect(provider.creates).toBe(1);
      expect(again).toMatchObject({ id: first.id, status, metadata: { _idempotency: "cache_hit" } });
    },
  );

  test("MockProvider 'processing' (Stripe requires_capture): 61s later a cache hit; past ttlMs the provider's key dedup returns the same payment", async () => {
    const provider = new MockProvider({ overrides: { order_auth: "processing" } });
    const createSpy = jest.spyOn(provider, "createPayment");
    const executor = new IdempotentPaymentExecutor(provider);
    const req = makeRequest("order_auth");
    const first = await executor.execute(req);

    await later(61_000, () => executor.execute(req));
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Past the 24h ttlMs PayKit has forgotten the key; the provider has not.
    const afterTtl = await later(86_400_000 + 1_000, () => executor.execute(req));
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(afterTtl.id).toBe(first.id);
    expect(await provider.listPayments({ limit: 100 })).toHaveLength(1);
  });

  test("control: a result in which no money moved ('failed') keeps the short failedTtlMs and reaches the provider again after it", async () => {
    const provider = new KeyIgnoringProvider("failed");
    const executor = new IdempotentPaymentExecutor(provider);
    const req = makeRequest("order_declined");
    await executor.execute(req);
    await later(61_000, () => executor.execute(req));
    expect(provider.creates).toBe(2);
  });
});

describe("assertValidMoney — positive, exact integer minor units in a three-letter currency", () => {
  test.each([
    ["0 (nothing to charge)", 0, "USD", "INVALID_AMOUNT"],
    ["2^53 + 2 (not exact)", 2 ** 53 + 2, "USD", "INVALID_AMOUNT"],
    ["1e21 (integer-valued, not an amount)", 1e21, "USD", "INVALID_AMOUNT"],
    ["a float", 49.99, "USD", "INVALID_AMOUNT"],
    ["a negative", -100, "USD", "INVALID_AMOUNT"],
    ['"usd " (trailing space)', 100, "usd ", "INVALID_CURRENCY"],
    ['"X"', 100, "X", "INVALID_CURRENCY"],
    ['"US$"', 100, "US$", "INVALID_CURRENCY"],
    ["an emoji", 100, "💵", "INVALID_CURRENCY"],
  ])("refuses %s", (_name, amount, currency, code) => {
    expect(() => assertValidMoney(amount, currency)).toThrow(expect.objectContaining({ code }));
  });

  test.each([
    [1, "USD"],
    [4999, "usd"],
    [Number.MAX_SAFE_INTEGER, "JPY"],
  ])("accepts %d %s", (amount, currency) => {
    expect(() => assertValidMoney(amount, currency)).not.toThrow();
  });

  test("the executor refuses a zero or malformed request before any provider call", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    const spy = jest.spyOn(provider, "createPayment");
    const executor = new IdempotentPaymentExecutor(provider);
    await expect(executor.execute({ amount: { amount: 0, currency: "USD" }, idempotencyKey: "z" })).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(executor.execute({ amount: { amount: 100, currency: "usd " }, idempotencyKey: "c" })).rejects.toMatchObject({ code: "INVALID_CURRENCY" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("retryableErrors — the default retries flagged errors too; an explicit list is exact", () => {
  function failingProvider(errors: ProviderError[]): { provider: PaymentProvider_Interface; calls: () => number } {
    let calls = 0;
    const provider: PaymentProvider_Interface = {
      name: "mock",
      async createPayment(req) {
        const err = errors[calls++];
        if (err) throw err;
        const now = new Date();
        return { id: "p_ok", idempotencyKey: req.idempotencyKey, provider: "mock", status: "succeeded", amount: req.amount, createdAt: now, updatedAt: now };
      },
      capturePayment: jest.fn(),
      cancelPayment: jest.fn(),
      refundPayment: jest.fn(),
      getPayment: jest.fn(),
      listPayments: jest.fn(),
    };
    return { provider, calls: () => calls };
  }
  const timeout = () => new ProviderError("timed out", "timeout", "mock", true);
  const inUse = () => new ProviderError("key in use", "idempotency_key_in_use", "mock", true);

  test("default: a timeout and a flagged-retryable error are re-sent", async () => {
    const { provider, calls } = failingProvider([timeout(), inUse()]);
    const ex = new IdempotentPaymentExecutor(provider, { retry: { maxAttempts: 3, initialDelayMs: 1 } });
    await expect(ex.execute(makeRequest("retry_default"))).resolves.toMatchObject({ id: "p_ok" });
    expect(calls()).toBe(3);
  });

  test('an explicit ["rate_limit"] narrows retries: a retryable-flagged timeout is NOT re-sent', async () => {
    const { provider, calls } = failingProvider([timeout()]);
    const ex = new IdempotentPaymentExecutor(provider, { retry: { maxAttempts: 3, initialDelayMs: 1, retryableErrors: ["rate_limit"] } });
    await expect(ex.execute(makeRequest("retry_narrow"))).rejects.toMatchObject({ code: "timeout" });
    expect(calls()).toBe(1);
  });

  test("an explicit list retries exactly the listed codes", async () => {
    const { provider, calls } = failingProvider([timeout(), inUse()]);
    const ex = new IdempotentPaymentExecutor(provider, {
      retry: { maxAttempts: 3, initialDelayMs: 1, retryableErrors: ["timeout"] },
    });
    await expect(ex.execute(makeRequest("retry_exact"))).rejects.toMatchObject({ code: "idempotency_key_in_use" });
    expect(calls()).toBe(2);
  });
});

describe("idempotency keys are required and well-formed — a key-less caller never shares another's slot", () => {
  test("two customers without a key — the second is refused, never handed the first's PaymentIntent", async () => {
    const provider = new MockProvider({ successRate: 1.0 });
    const executor = new IdempotentPaymentExecutor(provider);
    const spy = jest.spyOn(provider, "createPayment");
    for (const key of [undefined, ""]) {
      const request = (customerId: string) => ({ amount: { amount: 100, currency: "USD" }, idempotencyKey: key as unknown as string, customerId });
      await expect(executor.execute(request("cus_A"))).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
      await expect(executor.execute(request("cus_B"))).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["empty", ""],
    ["whitespace only", "   "],
    ["leading whitespace", " order_1"],
    ["trailing whitespace", "order_1\n"],
    ["longer than 255 characters", "k".repeat(256)],
  ])("refuses a key that is %s", async (_name, key) => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0 }));
    await expect(
      executor.execute({ amount: { amount: 100, currency: "USD" }, idempotencyKey: key as unknown as string }),
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
  });

  test("accepts a 255-character key (Stripe's limit)", async () => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0 }));
    await expect(executor.execute({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "k".repeat(255) })).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  test("MockProvider.createPayment refuses a blank key too (direct callers, not only the executor)", async () => {
    await expect(
      new MockProvider({ successRate: 1.0 }).createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY", provider: "mock" });
  });
});

describe("concurrent callers — takeover after a failed winner, and a clear in-flight timeout", () => {
  function scriptedProvider(script: Array<"fail" | "ok">, latencyMs: number) {
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const provider: PaymentProvider_Interface = {
      name: "mock",
      async createPayment(req) {
        const step = script[calls++] ?? "ok";
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, latencyMs));
        inFlight--;
        if (step === "fail") throw new ProviderError("declined", "card_declined", "mock", false);
        const now = new Date();
        return { id: `p_${calls}`, idempotencyKey: req.idempotencyKey, provider: "mock", status: "succeeded", amount: req.amount, createdAt: now, updatedAt: now };
      },
      capturePayment: jest.fn(),
      cancelPayment: jest.fn(),
      refundPayment: jest.fn(),
      getPayment: jest.fn(),
      listPayments: jest.fn(),
    };
    return { provider, stats: () => ({ calls, maxInFlight }) };
  }

  test("when the winner's provider call fails, a waiting caller takes the key over and runs it — one call at a time", async () => {
    const { provider, stats } = scriptedProvider(["fail", "ok"], 30);
    const ex = new IdempotentPaymentExecutor(provider, { pollIntervalMs: 5 });
    const req = makeRequest("key_takeover");
    const winner = ex.execute(req);
    const waiter = ex.execute(req);
    await expect(winner).rejects.toMatchObject({ code: "card_declined" });
    await expect(waiter).resolves.toMatchObject({ id: "p_2", status: "succeeded" });
    expect(stats()).toEqual({ calls: 2, maxInFlight: 1 });
  });

  test("a waiter that times out is told the payment is in flight (retryable), and the same key later returns the result", async () => {
    const { provider, stats } = scriptedProvider(["ok"], 120);
    const store = new InMemoryIdempotencyStore();
    const winnerEx = new IdempotentPaymentExecutor(provider, { store });
    const impatient = new IdempotentPaymentExecutor(provider, { store, waitTimeoutMs: 20, pollIntervalMs: 5 });
    const req = makeRequest("key_inflight");
    const winner = winnerEx.execute(req);
    const err = await impatient.execute(req).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "IDEMPOTENCY_WAIT_TIMEOUT", retryable: true });
    expect((err as Error).message).toMatch(/still in flight .* retry later with the same key/);
    await winner;
    const later = await impatient.execute(req);
    expect(later.metadata?._idempotency).toBe("cache_hit");
    expect(stats().calls).toBe(1);
  });
});

describe("cached results are never shared objects — a caller mutating its result cannot poison later duplicates", () => {
  test("the first caller deletes clientSecret and sets status 'failed'; duplicates still get the real result", async () => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0 }));
    const req = makeRequest("key_mutate");
    const first = await executor.execute(req);
    const secret = first.clientSecret;
    delete first.clientSecret;
    first.status = "failed";
    first.amount.amount = 1; // a nested field too
    first.createdAt.setFullYear(1970);

    const replay = await executor.execute(req);
    expect(replay).toMatchObject({ id: first.id, status: "succeeded", clientSecret: secret, amount: { amount: 5000, currency: "USD" } });
    expect(replay.createdAt.getFullYear()).not.toBe(1970);
    expect(replay.createdAt).toBeInstanceOf(Date);
  });

  test("mutating a replayed result does not change the next replay either", async () => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0 }));
    const req = makeRequest("key_mutate_replay");
    await executor.execute(req);
    const r1 = await executor.execute(req);
    r1.amount.amount = 1;
    if (r1.metadata) r1.metadata.orderId = "tampered";
    const r2 = await executor.execute(req);
    expect(r2.amount.amount).toBe(5000);
    expect(r2.metadata?.orderId).toBeUndefined();
  });

  test("InMemoryIdempotencyStore keeps and hands out copies, not the caller's objects", async () => {
    const store = new InMemoryIdempotencyStore();
    const now = new Date();
    const intent: PaymentIntent = { id: "p1", idempotencyKey: "k", provider: "mock", status: "succeeded", amount: { amount: 100, currency: "USD" }, createdAt: now, updatedAt: now };
    await store.set("k", { intent, fingerprint: "fp" });
    intent.amount.amount = 999;
    const got = (await store.get("k"))!;
    expect(got.intent.amount.amount).toBe(100);
    got.intent.status = "failed";
    expect((await store.get("k"))!.intent.status).toBe("succeeded");
  });
});

test("a replay is the first result with one change: metadata._idempotency, which replaces a caller's own value", async () => {
  const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1 }));
  const request = { ...makeRequest("k_tag"), metadata: { _idempotency: "mine", order: "o1" } };
  const first = await executor.execute(request);
  expect(first.metadata).toEqual({ _idempotency: "mine", order: "o1" });
  const replay = await executor.execute(request);
  expect(replay.metadata).toEqual({ _idempotency: "cache_hit", order: "o1" });
  expect({ ...replay, metadata: first.metadata }).toEqual(first);
});

describe("a request with no usable money is refused with the documented code, before the provider", () => {
  const cases: [string, unknown, string][] = [
    ["no amount at all", { idempotencyKey: "k" }, "INVALID_AMOUNT"],
    ["a null amount", { idempotencyKey: "k", amount: null }, "INVALID_AMOUNT"],
    ["an amount that is not an object", { idempotencyKey: "k", amount: 5000 }, "INVALID_AMOUNT"],
    ["no currency", { idempotencyKey: "k", amount: { amount: 5000 } }, "INVALID_CURRENCY"],
  ];

  test.each(cases)("execute(): %s", async (_name, request, code) => {
    const provider = new MockProvider({ successRate: 1 });
    const create = jest.spyOn(provider, "createPayment");
    const err = await new IdempotentPaymentExecutor(provider).execute(request as CreatePaymentRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayKitError);
    expect(err).toMatchObject({ code });
    expect(create).not.toHaveBeenCalled();
  });

  test.each(cases)("MockProvider.createPayment(): %s", async (_name, request, code) => {
    const err = await new MockProvider({ successRate: 1 }).createPayment(request as CreatePaymentRequest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayKitError);
    expect(err).toMatchObject({ code });
  });
});

describe("IdempotentPaymentExecutor — the provider answered, then the store failed", () => {
  class FailingSetStore extends InMemoryIdempotencyStore {
    releases = 0;
    async set(): Promise<void> {
      throw new Error("redis down");
    }
    async release(key: string, token: string): Promise<void> {
      this.releases++;
      return super.release(key, token);
    }
  }
  const setup = () => {
    const store = new FailingSetStore();
    const provider = new KeyIgnoringProvider("succeeded");
    const executor = new IdempotentPaymentExecutor(provider, { store, waitTimeoutMs: 20, pollIntervalMs: 1 });
    return { store, provider, executor };
  };

  test("the caller gets a classified error carrying the provider's result, not a raw store error", async () => {
    const { provider, executor } = setup();
    const err = await executor.execute(makeRequest("k_charged")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentResultNotStoredError);
    expect(err).toBeInstanceOf(PayKitError);
    expect(err).toMatchObject({
      name: "PaymentResultNotStoredError",
      code: "PAYMENT_RESULT_NOT_STORED",
      provider: "mock",
      retryable: false,
      idempotencyKey: "k_charged",
      intent: { id: "ignoring_1", status: "succeeded", amount: { amount: 5000, currency: "USD" } },
    });
    expect((err as PaymentResultNotStoredError).cause).toMatchObject({ message: "redis down" });
    expect((err as Error).message).toContain("not a failed payment");
    expect((err as Error).message).toContain("redis down");
    expect(provider.creates).toBe(1);
  });

  test("the message carries the id and status, never the client secret", async () => {
    const provider = new MockProvider({ successRate: 1 });
    const executor = new IdempotentPaymentExecutor(provider, { store: new FailingSetStore() });
    const err = (await executor.execute(makeRequest("k_secret")).catch((e: unknown) => e)) as PaymentResultNotStoredError;
    expect(err.intent.clientSecret).toBeTruthy(); // the caller can still continue the payment
    expect(err.message).toContain(err.intent.id);
    expect(err.message).not.toContain(err.intent.clientSecret);
  });

  describe("the client secret stays out of anything that logs the error", () => {
    const stored = async () => {
      const provider = new MockProvider({ successRate: 1 });
      const executor = new IdempotentPaymentExecutor(provider, { store: new FailingSetStore() });
      const err = (await executor.execute(makeRequest("k_log")).catch((e: unknown) => e)) as PaymentResultNotStoredError;
      const secret = err.intent.clientSecret as string;
      expect(secret).toBeTruthy();
      return { err, secret };
    };

    test("it does not serialize, by JSON or a spread", async () => {
      const { err, secret } = await stored();
      expect(JSON.stringify(err)).not.toContain(secret);
      expect(JSON.stringify(err)).not.toContain("clientSecret");
      expect(JSON.stringify({ ...err })).not.toContain(secret);
      expect(Object.keys(err)).not.toContain("intent");
    });

    test("it does not appear via util.inspect, even with showHidden, nor via console.log's formats", async () => {
      const { err, secret } = await stored();
      for (const shown of [
        inspect(err),
        inspect(err, { depth: null }),
        inspect(err, { showHidden: true, depth: null }),
        format("%s %o %O %j", err, err, err, err),
      ]) {
        expect(shown).not.toContain(secret);
        expect(shown).not.toContain("clientSecret");
      }
    });

    test("the one inspect mode that shows it is the one that asks Node to call getters", async () => {
      const { err, secret } = await stored();
      expect(inspect(err, { getters: true, depth: null })).not.toContain(secret);
      expect(inspect(err, { showHidden: true, depth: null })).toContain("[intent]: [Getter]");
      expect(inspect(err, { showHidden: true, getters: true, depth: null })).toContain(secret);
    });

    test("explicit access still returns the whole result, and the id stays in what gets logged", async () => {
      const { err, secret } = await stored();
      expect(err.intent.clientSecret).toBe(secret);
      expect(err.intent).toMatchObject({ provider: "mock", status: "succeeded", amount: { amount: 5000, currency: "USD" } });
      expect(JSON.parse(JSON.stringify(err))).toMatchObject({ paymentIntentId: err.intent.id, code: "PAYMENT_RESULT_NOT_STORED" });
      expect(inspect(err)).toContain(err.intent.id);
    });
  });

  test("the marker stays: a retry under the key waits, and the provider is not called again", async () => {
    const { store, provider, executor } = setup();
    await expect(executor.execute(makeRequest("k_marker"))).rejects.toBeInstanceOf(PaymentResultNotStoredError);
    expect(store.releases).toBe(0);
    // A provider that ignores keys would charge twice here if the marker were released.
    await expect(executor.execute(makeRequest("k_marker"))).rejects.toMatchObject({ code: "IDEMPOTENCY_WAIT_TIMEOUT" });
    expect(provider.creates).toBe(1);
  });

  test("err.intent is the caller's own copy, like every result: changing it cannot reach what the provider holds", async () => {
    const provider = new KeyIgnoringProvider("succeeded");
    const held = await provider.createPayment(makeRequest("k_copy"));
    provider.createPayment = async () => held; // as MockProvider does: it keeps what it returns
    const err = (await new IdempotentPaymentExecutor(provider, { store: new FailingSetStore() })
      .execute(makeRequest("k_copy"))
      .catch((e: unknown) => e)) as PaymentResultNotStoredError;
    expect(err.intent).toEqual(held);
    err.intent.amount.amount = 1;
    expect(held.amount.amount).toBe(5000);
  });

  test("a failure before the provider call is not this error: nothing was charged", async () => {
    const store = new (class extends InMemoryIdempotencyStore {
      async get(): Promise<null> {
        throw new Error("redis down");
      }
    })();
    const provider = new KeyIgnoringProvider("succeeded");
    await expect(new IdempotentPaymentExecutor(provider, { store }).execute(makeRequest("k_get"))).rejects.toThrow(/^redis down$/);
    expect(provider.creates).toBe(0);
  });
});

describe("InMemoryIdempotencyStore.reserve — a live result blocks a second provider call", () => {
  test("a caller that read the store just before the winner wrote still cannot call the provider", async () => {
    // The race reserve()'s terminal check exists for: get() saw nothing, the
    // winner then wrote its result and cleared its marker, and only then does
    // this caller reach reserve(). Without the check it wins and charges again.
    const store = new (class extends InMemoryIdempotencyStore {
      staleReads = 0;
      async get(key: string) {
        if (this.staleReads > 0) {
          this.staleReads--;
          return null;
        }
        return super.get(key);
      }
    })();
    const provider = new KeyIgnoringProvider("succeeded");
    const executor = new IdempotentPaymentExecutor(provider, { store, pollIntervalMs: 1 });
    const first = await executor.execute(makeRequest("k_race"));
    store.staleReads = 1;
    const second = await executor.execute(makeRequest("k_race"));
    expect(provider.creates).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.metadata?._idempotency).toBe("in_flight_join");
  });

  test("directly: null while the result lives, a token once it has expired", async () => {
    const store = new InMemoryIdempotencyStore();
    const record = { intent: { id: "p" } as PaymentIntent, fingerprint: "f" };
    await store.set("live", record, 60_000);
    expect(await store.reserve("live")).toBeNull();
    await store.set("expired", record, -1);
    expect(await store.reserve("expired")).toEqual(expect.any(String));
  });
});

describe("IdempotentPaymentExecutor — retry backoff, exactly", () => {
  /** The sleeps of one execute() whose every attempt times out, with Math.random pinned. */
  async function sleepsWith(random: number, retry: Partial<RetryConfig>): Promise<number[]> {
    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;
    const timers = jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);
    const rand = jest.spyOn(Math, "random").mockReturnValue(random);
    try {
      const provider = new KeyIgnoringProvider("succeeded");
      provider.createPayment = async () => {
        throw new ProviderError("slow", "timeout", "mock", true);
      };
      await expect(new IdempotentPaymentExecutor(provider, { retry }).execute(makeRequest("k_backoff"))).rejects.toMatchObject({ code: "timeout" });
      return delays;
    } finally {
      timers.mockRestore();
      rand.mockRestore();
    }
  }
  const retry = { maxAttempts: 5, initialDelayMs: 100, backoffFactor: 10, maxDelayMs: 300 };

  test("delays grow by backoffFactor and stop at maxDelayMs", async () => {
    expect(await sleepsWith(1, retry)).toEqual([100, 300, 300, 300]);
  });

  test("full jitter: each sleep is in [delay/2, delay], the bottom when random is 0", async () => {
    expect(await sleepsWith(0, retry)).toEqual([50, 150, 150, 150]);
  });

  test("full jitter: halfway when random is 0.5", async () => {
    expect(await sleepsWith(0.5, retry)).toEqual([75, 225, 225, 225]);
  });
});

describe("IdempotentPaymentExecutor.isDuplicate — says whether a result is recorded, nothing more", () => {
  test("false before, false while the first call is in flight, true once recorded", async () => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1.0, latencyMs: 20 }));
    expect(await executor.isDuplicate("k_flight")).toBe(false);
    const first = executor.execute(makeRequest("k_flight"));
    await new Promise((r) => setTimeout(r, 2));
    expect(await executor.isDuplicate("k_flight")).toBe(false);
    await first;
    expect(await executor.isDuplicate("k_flight")).toBe(true);
  });

  test("the documented guard is execute(): a second call in flight joins the first", async () => {
    const provider = new KeyIgnoringProvider("succeeded");
    const executor = new IdempotentPaymentExecutor(provider, { pollIntervalMs: 1 });
    const [a, b] = await Promise.all([executor.execute(makeRequest("k_join")), executor.execute(makeRequest("k_join"))]);
    expect(a.id).toBe(b.id);
    expect(provider.creates).toBe(1);
  });
});

describe("the executor refuses durations it cannot honour, at construction", () => {
  const bad: [string, number][] = [
    ["NaN (Number(process.env.UNSET))", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["0", 0],
    ["-1", -1],
  ];
  describe.each(["ttlMs", "failedTtlMs", "waitTimeoutMs", "pollIntervalMs"])("%s", (name) => {
    test.each(bad)("refuses %s", (_label, value) => {
      expect(() => new IdempotentPaymentExecutor(new MockProvider(), { [name]: value })).toThrow(
        expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringContaining(name) }),
      );
    });

    test("control: a positive value builds an executor", () => {
      expect(() => new IdempotentPaymentExecutor(new MockProvider(), { [name]: 1 })).not.toThrow();
    });
  });

  test.each([
    ["initialDelayMs", Number.NaN],
    ["maxDelayMs", -1],
    ["backoffFactor", Number.POSITIVE_INFINITY],
  ])("refuses a retry %s of %s", (name, value) => {
    expect(() => new IdempotentPaymentExecutor(new MockProvider(), { retry: { [name]: value } })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringContaining(name) }),
    );
  });

  test("control: a retry delay of 0 is a legitimate choice", () => {
    expect(() => new IdempotentPaymentExecutor(new MockProvider(), { retry: { initialDelayMs: 0, maxDelayMs: 0 } })).not.toThrow();
  });
});

describe("a failed release never replaces the provider's error", () => {
  class ReleaseFails extends InMemoryIdempotencyStore {
    released = 0;
    async release(): Promise<void> {
      this.released++;
      throw new Error("redis down");
    }
  }
  const declining = (error: unknown): PaymentProvider_Interface => {
    const provider = new MockProvider();
    jest.spyOn(provider, "createPayment").mockRejectedValue(error);
    return provider;
  };
  const req = { amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_release" };

  test("a decline surfaces as the decline, with the store's failure attached", async () => {
    const decline = new ProviderError("Your card was declined.", "card_declined", "mock", false);
    const store = new ReleaseFails();
    const failure = await new IdempotentPaymentExecutor(declining(decline), { store }).execute(req).catch((e) => e);
    expect(failure).toBe(decline);
    expect(store.released).toBe(1);
    expect(failure.code).toBe("card_declined");
    expect((failure as { releaseError?: Error }).releaseError).toMatchObject({ message: "redis down" });
  });

  test.each([
    ["a frozen error", Object.freeze(new ProviderError("declined", "card_declined", "mock", false))],
    ["a thrown string", "declined"],
  ])("%s cannot carry it, so it is thrown as it came and the failure is logged", async (_name, thrown) => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failure = await new IdempotentPaymentExecutor(declining(thrown), { store: new ReleaseFails() }).execute(req).catch((e) => e);
      expect(failure).toBe(thrown);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toEqual([expect.stringContaining("order_release"), expect.objectContaining({ message: "redis down" })]);
    } finally {
      warn.mockRestore();
    }
  });

  test("control: a release that works attaches nothing", async () => {
    const decline = new ProviderError("declined", "card_declined", "mock", false);
    await new IdempotentPaymentExecutor(declining(decline)).execute(req).catch(() => {});
    expect((decline as unknown as { releaseError?: unknown }).releaseError).toBeUndefined();
  });
});

describe("metadata is data: a JSON __proto__ key never becomes a prototype", () => {
  const smuggled = () => JSON.parse('{"__proto__":{"isAdmin":"true"},"orderId":"o1"}') as Record<string, string>;
  const req = (): CreatePaymentRequest => ({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "order_proto", metadata: smuggled() });

  test("neither the first result nor a replay inherits from it", async () => {
    const executor = new IdempotentPaymentExecutor(new MockProvider({ successRate: 1 }));
    const first = await executor.execute(req());
    const replay = await executor.execute(req());
    for (const result of [first, replay]) {
      expect(Object.getPrototypeOf(result.metadata)).toBe(Object.prototype);
      expect(result.metadata!.isAdmin).toBeUndefined();
      expect(result.metadata!.orderId).toBe("o1");
    }
    expect(replay.metadata!._idempotency).toBe("cache_hit");
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
  });

  test("the key stays in the copy as plain data", async () => {
    const result = await new IdempotentPaymentExecutor(new MockProvider({ successRate: 1 })).execute(req());
    expect(Object.keys(result.metadata!).sort()).toEqual(["__proto__", "orderId"]);
  });
});

describe("an idempotency key must fit in an HTTP header", () => {
  test.each([
    ["CJK", "order_日本語"],
    ["an emoji", "order_💵"],
    ["Latin-1, whose bytes depend on the encoding", "order_é"],
    ["a newline (header injection)", "order_1\nX-Evil: 1"],
    ["a tab", "order\t1"],
    ["a NUL", "order\u00001"],
  ])("%s is refused before any store or provider access", async (_name, idempotencyKey) => {
    const provider = new MockProvider({ successRate: 1 });
    const create = jest.spyOn(provider, "createPayment");
    const store = new InMemoryIdempotencyStore();
    const reserve = jest.spyOn(store, "reserve");
    await expect(new IdempotentPaymentExecutor(provider, { store }).execute({ amount: { amount: 100, currency: "USD" }, idempotencyKey })).rejects.toMatchObject({
      code: "INVALID_IDEMPOTENCY_KEY",
      retryable: false,
    });
    expect(create).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("the provider and refund paths share the rule", async () => {
    const provider = new MockProvider({ successRate: 1 });
    await expect(provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "order_日本語" })).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    await expect(provider.refundPayment({ paymentId: "p", idempotencyKey: "refund_日本語" })).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
  });

  test("control: every printable ASCII character is accepted", async () => {
    const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join("");
    const inner = `k${printable}k`;
    const result = await new IdempotentPaymentExecutor(new MockProvider({ successRate: 1 })).execute({ amount: { amount: 100, currency: "USD" }, idempotencyKey: inner });
    expect(result.idempotencyKey).toBe(inner);
  });
});

describe("the short TTL covers every status in which no money moved", () => {
  // `cancelled` must expire like `failed`: a cancelled attempt charged nothing.
  class FixedStatusProvider extends MockProvider {
    creates = 0;
    constructor(private readonly status: PaymentStatus) {
      super({ successRate: 1 });
    }
    async createPayment(request: CreatePaymentRequest): Promise<PaymentIntent> {
      this.creates++;
      const created = new Date();
      return { id: `pay_${this.creates}`, idempotencyKey: request.idempotencyKey, provider: "mock", status: this.status, amount: request.amount, createdAt: created, updatedAt: created };
    }
  }

  async function callsAcross(status: PaymentStatus, elapsedMs: number): Promise<number> {
    const provider = new FixedStatusProvider(status);
    const executor = new IdempotentPaymentExecutor(provider);
    const req = makeRequest("order_ttl");
    await executor.execute(req);
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now + elapsedMs);
    try {
      await executor.execute(req);
    } finally {
      clock.mockRestore();
    }
    return provider.creates;
  }

  test.each(["failed", "cancelled"] as PaymentStatus[])("%s is replayed inside failedTtlMs and reaches the provider after it", async (status) => {
    expect(await callsAcross(status, 59_000)).toBe(1);
    expect(await callsAcross(status, 61_000)).toBe(2);
  });

  test.each(["succeeded", "pending", "processing"] as PaymentStatus[])("control: %s keeps the full ttlMs", async (status) => {
    expect(await callsAcross(status, 61_000)).toBe(1);
  });
});

describe("IdempotentPaymentExecutor — a shared store is scoped by provider name and scope", () => {
  const paying = (name: PaymentProvider = "mock") => Object.assign(new MockProvider({ successRate: 1 }), { name });

  test("two merchants on one store: the second gets its own payment, never the first's client secret", async () => {
    const store = new InMemoryIdempotencyStore();
    const [providerA, providerB] = [paying(), paying()];
    const a = new IdempotentPaymentExecutor(providerA, { store, scope: "merchant_a" });
    const b = new IdempotentPaymentExecutor(providerB, { store, scope: "merchant_b" });

    const paidA = await a.execute(makeRequest("order_1"));
    const paidB = await b.execute(makeRequest("order_1"));

    expect(paidB.clientSecret).not.toBe(paidA.clientSecret);
    expect(paidB.id).not.toBe(paidA.id);
    expect(paidB.metadata?._idempotency).toBeUndefined();
    expect(await providerA.listPayments()).toHaveLength(1);
    expect(await providerB.listPayments()).toHaveLength(1);
    expect(store.size).toBe(2);
  });

  test("test and live on one store stay apart, and each still replays its own", async () => {
    const store = new InMemoryIdempotencyStore();
    const test = new IdempotentPaymentExecutor(paying(), { store, scope: "test" });
    const live = new IdempotentPaymentExecutor(paying(), { store, scope: "live" });
    const inTest = await test.execute(makeRequest("order_2"));
    const inLive = await live.execute(makeRequest("order_2"));
    expect(inLive.id).not.toBe(inTest.id);
    expect((await test.execute(makeRequest("order_2"))).id).toBe(inTest.id);
    expect((await live.execute(makeRequest("order_2"))).id).toBe(inLive.id);
  });

  test("two providers by name stay apart with no scope at all", async () => {
    const store = new InMemoryIdempotencyStore();
    const [stripeNamed, mockNamed] = [paying("stripe"), paying("mock")];
    const first = await new IdempotentPaymentExecutor(stripeNamed, { store }).execute(makeRequest("order_3"));
    const second = await new IdempotentPaymentExecutor(mockNamed, { store }).execute(makeRequest("order_3"));
    expect(second.id).not.toBe(first.id);
    expect(await mockNamed.listPayments()).toHaveLength(1);
  });

  test("control: the same provider name and scope still share results, across executors", async () => {
    const store = new InMemoryIdempotencyStore();
    const provider = paying();
    const create = jest.spyOn(provider, "createPayment");
    const first = await new IdempotentPaymentExecutor(provider, { store, scope: "live" }).execute(makeRequest("order_4"));
    const second = await new IdempotentPaymentExecutor(paying(), { store, scope: "live" }).execute(makeRequest("order_4"));
    expect(second.id).toBe(first.id);
    expect(second.metadata?._idempotency).toBe("cache_hit");
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("control: with no scope, servers sharing a store and a provider name still share results", async () => {
    const store = new InMemoryIdempotencyStore();
    const first = await new IdempotentPaymentExecutor(paying(), { store }).execute(makeRequest("order_5"));
    const second = await new IdempotentPaymentExecutor(paying(), { store }).execute(makeRequest("order_5"));
    expect(second.id).toBe(first.id);
  });

  test("a conflict is per scope: the same key at another amount in another scope is not one", async () => {
    const store = new InMemoryIdempotencyStore();
    const a = new IdempotentPaymentExecutor(paying(), { store, scope: "a" });
    const b = new IdempotentPaymentExecutor(paying(), { store, scope: "b" });
    await a.execute(makeRequest("order_6", 5000));
    await expect(b.execute(makeRequest("order_6", 9999))).resolves.toMatchObject({ amount: { amount: 9999 } });
    await expect(a.execute(makeRequest("order_6", 9999))).rejects.toBeInstanceOf(IdempotencyError);
  });

  test("the conflict still names the caller's key, and the provider still receives it unchanged", async () => {
    const provider = paying();
    const create = jest.spyOn(provider, "createPayment");
    const executor = new IdempotentPaymentExecutor(provider, { scope: "live" });
    const paid = await executor.execute(makeRequest("order_7", 5000));
    expect(create.mock.calls[0][0].idempotencyKey).toBe("order_7");
    expect(paid.idempotencyKey).toBe("order_7");
    await expect(executor.execute(makeRequest("order_7", 9999))).rejects.toThrow("different parameters: order_7");
  });

  test("isDuplicate and invalidate act within the executor's own scope", async () => {
    const store = new InMemoryIdempotencyStore();
    const a = new IdempotentPaymentExecutor(paying(), { store, scope: "a" });
    const b = new IdempotentPaymentExecutor(paying(), { store, scope: "b" });
    await a.execute(makeRequest("order_8"));
    expect(await a.isDuplicate("order_8")).toBe(true);
    expect(await b.isDuplicate("order_8")).toBe(false);
    await b.invalidate("order_8");
    expect(await a.isDuplicate("order_8")).toBe(true);
    await a.invalidate("order_8");
    expect(await a.isDuplicate("order_8")).toBe(false);
  });

  test("an in-flight call in one scope does not hold up another scope's", async () => {
    const store = new InMemoryIdempotencyStore();
    const slow = Object.assign(new MockProvider({ successRate: 1, latencyMs: 40 }), { name: "mock" as const });
    const fast = paying();
    const running = new IdempotentPaymentExecutor(slow, { store, scope: "a" }).execute(makeRequest("order_9"));
    const other = new IdempotentPaymentExecutor(fast, { store, scope: "b", waitTimeoutMs: 1 }).execute(makeRequest("order_9"));
    await expect(other).resolves.toMatchObject({ idempotencyKey: "order_9" });
    expect(await fast.listPayments()).toHaveLength(1);
    await running;
  });

  test("names and keys that look alike under plain concatenation do not collide", async () => {
    const store = new InMemoryIdempotencyStore();
    const pairs: Array<[string, string | undefined, string]> = [
      ["a:b", "c", "k"],
      ["a", "b:c", "k"],
      ["a", "b", "c:k"],
      ["a", "null", "k"],
      ["a", undefined, "k"],
    ];
    const ids = new Set<string>();
    for (const [name, scope, key] of pairs) {
      ids.add((await new IdempotentPaymentExecutor(paying(name), { store, scope }).execute(makeRequest(key))).id);
    }
    expect(ids.size).toBe(pairs.length);
  });

  test("idempotencyStoreKey is exported, for whoever reads a store directly", async () => {
    expect(typeof idempotencyStoreKey).toBe("function");
    const store = new InMemoryIdempotencyStore();
    await new IdempotentPaymentExecutor(paying(), { store, scope: "live" }).execute(makeRequest("order_10"));
    expect(await store.has(idempotencyStoreKey("mock", "live", "order_10"))).toBe(true);
    expect(await store.has("order_10")).toBe(false);
  });

  test.each<[string, unknown]>([
    ["empty", ""],
    ["leading whitespace", " live"],
    ["trailing whitespace", "live "],
    ["a number", 7],
    ["null", null],
  ])("a scope that is %s is INVALID_CONFIG", (_name, scope) => {
    expect(() => new IdempotentPaymentExecutor(paying(), { scope: scope as string })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringContaining("scope") }),
    );
  });
});

describe("IdempotentPaymentExecutor — retryableErrors left undefined means the default", () => {
  const timesOutOnce = () => {
    const provider = new MockProvider({ successRate: 1 });
    const create = provider.createPayment.bind(provider);
    let calls = 0;
    jest.spyOn(provider, "createPayment").mockImplementation(async (request) => {
      if (++calls === 1) throw new ProviderError("socket timeout", "timeout", "mock", true);
      return create(request);
    });
    return { provider, calls: () => calls };
  };

  test("an explicit undefined retries a timeout, instead of turning it into a TypeError", async () => {
    const { provider, calls } = timesOutOnce();
    const executor = new IdempotentPaymentExecutor(provider, { retry: { retryableErrors: undefined, initialDelayMs: 1 } });
    await expect(executor.execute(makeRequest("order_undefined_list"))).resolves.toMatchObject({ status: "succeeded" });
    expect(calls()).toBe(2);
  });

  test("it is the default in full: an error the provider flags retryable is retried too", async () => {
    const provider = new MockProvider({ successRate: 1 });
    const create = provider.createPayment.bind(provider);
    let calls = 0;
    jest.spyOn(provider, "createPayment").mockImplementation(async (request) => {
      if (++calls === 1) throw new ProviderError("in use", "idempotency_key_in_use", "mock", true);
      return create(request);
    });
    const executor = new IdempotentPaymentExecutor(provider, { retry: { retryableErrors: undefined, initialDelayMs: 1 } });
    await expect(executor.execute(makeRequest("order_flagged"))).resolves.toMatchObject({ status: "succeeded" });
    expect(calls).toBe(2);
  });

  test("control: an explicit list is still exact, an empty one included", async () => {
    const { provider, calls } = timesOutOnce();
    const executor = new IdempotentPaymentExecutor(provider, { retry: { retryableErrors: [], initialDelayMs: 1 } });
    await expect(executor.execute(makeRequest("order_empty_list"))).rejects.toMatchObject({ code: "timeout" });
    expect(calls()).toBe(1);
  });

  test.each<[string, unknown]>([
    ["null", null],
    ["a string, which includes() would match by substring", "timeout"],
    ["a list holding a non-string", ["timeout", 5]],
  ])("%s is INVALID_CONFIG", (_name, retryableErrors) => {
    expect(() => new IdempotentPaymentExecutor(new MockProvider(), { retry: { retryableErrors: retryableErrors as string[] } })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringContaining("retryableErrors") }),
    );
  });
});
