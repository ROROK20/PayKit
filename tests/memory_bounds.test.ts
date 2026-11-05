/**
 * Memory-bound tests for the in-memory stores.
 *
 * The in-memory idempotency store, the executor's conflict-detection map, and
 * the webhook engine's processed-ID set would each grow without limit in a
 * long-running process. These tests pin the three mechanisms that bound them:
 *   1. InMemoryIdempotencyStore — opportunistic expiry sweep + hard entry cap,
 *      and the guarantee that neither evicts an in-flight reservation.
 *   2. IdempotentPaymentExecutor — holds NO per-key state any more: the
 *      conflict fingerprint lives in the store record, so it is bounded by the
 *      store's bounds and lives exactly as long as the cached result.
 *   3. WebhookEngine.processedIds — bounded FIFO that evicts the oldest ID once
 *      full, while still deduplicating recently-seen replays.
 */

import {
  IdempotencyRecord,
  InMemoryIdempotencyStore,
  IdempotentPaymentExecutor,
} from "../src/payments/idempotent";
import { MockProvider } from "../src/providers/mock";
import { WebhookEngine } from "../src/webhooks/handler";
import { CreatePaymentRequest, IdempotencyError } from "../src/types";

function request(key: string, amount = 5000): CreatePaymentRequest {
  return { amount: { amount, currency: "USD" }, idempotencyKey: key, description: "bounds" };
}

function intent(id: string): IdempotencyRecord {
  return {
    intent: {
      id,
      idempotencyKey: id,
      provider: "mock",
      status: "succeeded",
      amount: { amount: 5000, currency: "USD" },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    fingerprint: `fp_${id}`,
  };
}

function webhookPayload(id: string, type = "payment.succeeded"): string {
  return JSON.stringify({
    id,
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "pay_1" } },
  });
}

describe("InMemoryIdempotencyStore — expiry sweep", () => {
  test("opportunistic sweep evicts expired write-once-never-read keys", async () => {
    // sweepEvery=4: the sweep runs on the 4th write. Every entry is written
    // already-expired (negative TTL) and never fetched, so no same-key get()
    // can reclaim it: only the sweep can.
    const store = new InMemoryIdempotencyStore({ sweepEvery: 4, maxEntries: 0 });
    for (let i = 0; i < 3; i++) {
      await store.set(`k${i}`, intent(`k${i}`), -1);
    }
    // Not swept yet (3 writes < sweepEvery). Entries are expired-but-present.
    expect(store.size).toBe(3);

    await store.set("k3", intent("k3"), -1); // 4th write triggers the sweep
    expect(store.size).toBe(0); // all expired entries reclaimed in bulk
  });

  test("sweep leaves still-live entries in place", async () => {
    const store = new InMemoryIdempotencyStore({ sweepEvery: 2, maxEntries: 0 });
    await store.set("live", intent("live"), 60_000); // valid for 60s
    await store.set("dead", intent("dead"), -1); // triggers sweep on write #2
    expect(store.size).toBe(1);
    expect(await store.get("live")).not.toBeNull();
    expect(await store.get("dead")).toBeNull();
  });

  test("sweepExpired() can be forced explicitly", async () => {
    const store = new InMemoryIdempotencyStore({ sweepEvery: 0, maxEntries: 0 });
    await store.set("a", intent("a"), -1);
    await store.set("b", intent("b"), -1);
    expect(store.size).toBe(2); // sweepEvery=0 → no incidental sweep
    store.sweepExpired();
    expect(store.size).toBe(0);
  });
});

describe("InMemoryIdempotencyStore — hard entry cap", () => {
  test("maxEntries evicts oldest-inserted entries first", async () => {
    // sweepEvery=0 isolates the cap from the sweep. Write 5 live entries into a
    // cap of 3 → the two oldest (k0, k1) are dropped, newest three survive.
    const store = new InMemoryIdempotencyStore({ maxEntries: 3, sweepEvery: 0 });
    for (let i = 0; i < 5; i++) {
      await store.set(`k${i}`, intent(`k${i}`), 60_000);
    }
    expect(store.size).toBe(3);
    expect(await store.get("k0")).toBeNull(); // oldest — evicted
    expect(await store.get("k1")).toBeNull(); // evicted
    expect(await store.get("k2")).not.toBeNull();
    expect(await store.get("k3")).not.toBeNull();
    expect(await store.get("k4")).not.toBeNull(); // newest — kept
  });

  test("maxEntries=0 disables the cap (unbounded)", async () => {
    const store = new InMemoryIdempotencyStore({ maxEntries: 0, sweepEvery: 0 });
    for (let i = 0; i < 50; i++) {
      await store.set(`k${i}`, intent(`k${i}`), 60_000);
    }
    expect(store.size).toBe(50);
  });

  test("bounding NEVER evicts an in-flight reservation (race guarantee holds)", async () => {
    // Reserve a key, then flood the store far past the cap. The reservation is
    // tracked separately from cached results, so it must still block a second
    // reserve of the same key — otherwise a concurrent caller could double-charge.
    const store = new InMemoryIdempotencyStore({ maxEntries: 2, sweepEvery: 1 });
    expect(await store.reserve("in_flight")).toEqual(expect.any(String));
    for (let i = 0; i < 20; i++) {
      await store.set(`flood${i}`, intent(`flood${i}`), 60_000);
    }
    expect(store.size).toBe(2); // cap enforced on cached results
    // The reservation survived the flood: a second reserve still loses.
    expect(await store.reserve("in_flight")).toBeNull();
  });
});

describe("IdempotentPaymentExecutor — conflict detection lives in the store record", () => {
  const provider = () => new MockProvider({ successRate: 1.0 });

  test("no separate, smaller cap: a conflicting reuse is still rejected after 1,000 other keys", async () => {
    // The fingerprint is stored with the result, so the store's bound is the
    // only one: a fingerprint evicted on its own would let conflicting reuse
    // silently get the cached result.
    const executor = new IdempotentPaymentExecutor(provider());
    await executor.execute(request("early_key", 5000));
    for (let i = 0; i < 1000; i++) {
      await executor.execute(request(`filler_${i}`));
    }
    await expect(executor.execute(request("early_key", 9999))).rejects.toThrow(IdempotencyError);
  });

  test("a store-evicted key falls through to the provider, whose key dedup is the backstop: same request → same payment, different request → rejected", async () => {
    // A second charge for a reused key is possible only with a provider that
    // ignores idempotency keys. Stripe rejects a reused key with different
    // parameters and replays the original payment for the same parameters, and
    // the provider contract requires exactly that.
    const store = new InMemoryIdempotencyStore({ maxEntries: 2, sweepEvery: 0 });
    const mock = provider();
    const executor = new IdempotentPaymentExecutor(mock, { store });
    const first = await executor.execute(request("cap_k0", 5000));
    await executor.execute(request("cap_k1", 5000));
    await executor.execute(request("cap_k2", 5000));
    expect(store.size).toBe(2); // cap_k0's record (result + fingerprint) evicted
    const createSpy = jest.spyOn(mock, "createPayment");

    // PayKit has forgotten cap_k0, so both calls reach the provider.
    await expect(executor.execute(request("cap_k0", 9999))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      provider: "mock",
    });
    const replay = await executor.execute(request("cap_k0", 5000));
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(replay.id).toBe(first.id); // the original payment, not a new one
    expect(await mock.listPayments({ limit: 100 })).toHaveLength(3); // no fourth charge
    await expect(executor.execute(request("cap_k2", 9999))).rejects.toThrow(IdempotencyError);
  });

  test("a cached decline guards its key for exactly failedTtlMs; after that the key reaches the provider, which replays the decline", async () => {
    // With Stripe (and MockProvider) the same key replays the original decline
    // after the TTL; a declined card is retried with a NEW key.
    const mock = new MockProvider({ successRate: 0.0 });
    const executor = new IdempotentPaymentExecutor(mock, {
      retry: { maxAttempts: 1 },
      failedTtlMs: 40,
    });
    const declined = await executor.execute(request("declined_key", 5000));
    expect(declined.status).toBe("failed");
    const createSpy = jest.spyOn(mock, "createPayment");

    // Inside failedTtlMs PayKit's store answers: the conflict never reaches the provider.
    await expect(executor.execute(request("declined_key", 6000))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      provider: undefined,
    });
    expect(createSpy).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 60));
    // Past it, the provider answers: a different request is its conflict...
    await expect(executor.execute(request("declined_key", 6000))).rejects.toMatchObject({ provider: "mock" });
    // ...and the same request replays the original decline.
    const again = await executor.execute(request("declined_key", 5000));
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(again).toMatchObject({ id: declined.id, status: "failed" });
  });
});

describe("WebhookEngine — bounded processedIds FIFO", () => {
  test("evicts the oldest processed ID once the cap is exceeded, but still dedupes recent replays", async () => {
    // Cap of 3. Process 3 distinct events, then a 4th — which evicts the oldest
    // (evt1). A replay of the still-remembered evt4 is deduped; a replay of the
    // evicted evt1 is NOT (its dedup memory was reclaimed). This is the honest
    // consequence of a bounded window, asserted directly.
    // allowUnsigned: these tests pin the dedup FIFO, not signature checks
    // (covered in webhook.test.ts), so they opt in to unsigned delivery.
    const engine = new WebhookEngine({ maxProcessedIds: 3, maxRetries: 1, allowUnsigned: true });
    let handlerRuns = 0;
    engine.on("payment.succeeded", async () => {
      handlerRuns++;
    });

    for (const id of ["evt1", "evt2", "evt3"]) {
      const r = await engine.process({ rawBody: webhookPayload(id), provider: "stripe" });
      expect(r.processed).toBe(true);
    }
    expect(handlerRuns).toBe(3);

    // 4th distinct event → FIFO full, oldest (evt1) evicted.
    const fourth = await engine.process({ rawBody: webhookPayload("evt4"), provider: "stripe" });
    expect(fourth.processed).toBe(true);
    expect(handlerRuns).toBe(4);

    // Recent replay (evt4 still in the window) → deduped, handler does NOT run.
    const replayRecent = await engine.process({ rawBody: webhookPayload("evt4"), provider: "stripe" });
    expect(replayRecent.processed).toBe(false);
    expect(replayRecent.error).toBe("duplicate_event");
    expect(handlerRuns).toBe(4);

    // Replay of the evicted evt1 → not deduped, handler runs again.
    const replayOld = await engine.process({ rawBody: webhookPayload("evt1"), provider: "stripe" });
    expect(replayOld.processed).toBe(true);
    expect(handlerRuns).toBe(5);
  });

  test("maxProcessedIds=0 keeps the unbounded (grow-forever) behavior", async () => {
    const engine = new WebhookEngine({ maxProcessedIds: 0, maxRetries: 1, allowUnsigned: true });
    engine.on("*", async () => {});
    for (let i = 0; i < 200; i++) {
      await engine.process({ rawBody: webhookPayload(`u${i}`), provider: "stripe" });
    }
    // Every one of the 200 remains remembered → the very first is still deduped.
    const replayFirst = await engine.process({ rawBody: webhookPayload("u0"), provider: "stripe" });
    expect(replayFirst.processed).toBe(false);
  });
});

describe("WebhookEngine — bounded dead-letter list", () => {
  async function failDeliveries(engine: WebhookEngine, ids: string[]): Promise<void> {
    engine.on("payment.succeeded", async () => {
      throw new Error("handler down");
    });
    for (const id of ids) {
      const r = await engine.process({ rawBody: webhookPayload(id), provider: "stripe" });
      expect(r.error).toBe("handler_failed");
    }
  }
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `evt_dead_${i}`);

  test("maxDeadLetters keeps the most recent entries and drops the oldest first", async () => {
    const engine = new WebhookEngine({ maxRetries: 1, allowUnsigned: true, maxDeadLetters: 2 });
    await failDeliveries(engine, ["evt_a", "evt_b", "evt_c"]);
    expect(engine.getDeadLetters().map((d) => d.event.id)).toEqual(["evt_b", "evt_c"]);
  });

  test("the default bound is 1,000 entries", async () => {
    const engine = new WebhookEngine({ maxRetries: 1, allowUnsigned: true });
    await failDeliveries(engine, ids(1_005));
    const dead = engine.getDeadLetters();
    expect(dead).toHaveLength(1_000);
    expect(dead[0].event.id).toBe("evt_dead_5");
  });

  test("maxDeadLetters=0 keeps every entry (unbounded, opt-in)", async () => {
    const engine = new WebhookEngine({ maxRetries: 1, allowUnsigned: true, maxDeadLetters: 0 });
    await failDeliveries(engine, ids(1_005));
    expect(engine.getDeadLetters()).toHaveLength(1_005);
  });
});
