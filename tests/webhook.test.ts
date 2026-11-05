/**
 * Tests for webhook engine.
 */

import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";

import { WebhookEngine } from "../src/webhooks/handler";
import { customEvent, normalizeStripeEventType } from "../src/webhooks/events";
import { parseStripeSignatureHeader } from "../src/webhooks/signature";
import { WebhookEvent, WebhookSignatureError } from "../src/types";
import { disputeClosed, paymentIntentSucceeded, stripeEvent } from "./fixtures/stripe_events";

const SECRET = "whsec_test_secret_key_for_testing";

function makeWebhookPayload(type = "payment.succeeded", id = "evt_test_1"): string {
  return JSON.stringify({
    id,
    type,
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: "pay_123", amount: 5000, currency: "usd" } },
  });
}

/** Deliver a payload the way production does: signed with SECRET, fresh timestamp. */
function deliver(engine: WebhookEngine, rawBody: string) {
  const ts = Math.floor(Date.now() / 1000);
  return engine.process({
    rawBody,
    signature: engine.computeSignature(rawBody, SECRET, ts),
    secret: SECRET,
    provider: "stripe",
    timestamp: ts,
  });
}

describe("WebhookEngine", () => {
  let engine: WebhookEngine;

  beforeEach(() => {
    engine = new WebhookEngine({ maxRetries: 1 });
  });

  test("fails closed: a configured secret with a missing or empty signature is rejected", async () => {
    let called = 0;
    engine.on("payment.succeeded", async () => { called++; });
    for (const signature of [undefined, ""]) {
      const err = await engine
        .process({ rawBody: makeWebhookPayload("payment.succeeded", "evt_nosig"), signature, secret: SECRET, provider: "stripe" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).reason).toBe("missing_signature");
    }
    expect(called).toBe(0);
  });

  test("fails closed: no secret configured (e.g. an unset env var) is rejected by default", async () => {
    let called = 0;
    engine.on("*", async () => { called++; });
    const payload = makeWebhookPayload("payment.succeeded", "evt_nosecret");
    const ts = Math.floor(Date.now() / 1000);
    for (const secret of [process.env["PAYKIT_TEST_DEFINITELY_UNSET_SECRET"], ""]) {
      const err = await engine
        .process({ rawBody: payload, signature: engine.computeSignature(payload, SECRET, ts), secret, provider: "stripe", timestamp: ts })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).reason).toBe("missing_secret");
    }
    expect(called).toBe(0);
  });

  test("allowUnsigned: true is the only way to process without a secret — and never relaxes a configured one", async () => {
    const demo = new WebhookEngine({ maxRetries: 1, allowUnsigned: true });
    let called = 0;
    demo.on("payment.succeeded", async () => { called++; });
    const result = await demo.process({ rawBody: makeWebhookPayload("payment.succeeded", "evt_demo"), provider: "stripe" });
    expect(result.processed).toBe(true);
    expect(called).toBe(1);

    await expect(
      demo.process({ rawBody: makeWebhookPayload("payment.succeeded", "evt_demo2"), secret: SECRET, provider: "stripe" }),
    ).rejects.toMatchObject({ reason: "missing_signature" });
    expect(called).toBe(1);
  });

  test("runs multiple handlers for same event", async () => {
    const payload = makeWebhookPayload("payment.succeeded", "evt_multi");
    let count = 0;
    engine.on("payment.succeeded", async () => { count++; });
    engine.on("payment.succeeded", async () => { count++; });
    const result = await deliver(engine, payload);
    expect(result.handlersRun).toBe(2);
    expect(count).toBe(2);
  });

  test("wildcard handler runs for any event type", async () => {
    const payload = makeWebhookPayload("refund.created", "evt_wild");
    let wildcardCalled = false;
    engine.on("*", async () => { wildcardCalled = true; });
    await deliver(engine, payload);
    expect(wildcardCalled).toBe(true);
  });

  test("deduplicates events with same ID", async () => {
    const payload = makeWebhookPayload("payment.succeeded", "evt_dup");
    let callCount = 0;
    engine.on("payment.succeeded", async () => { callCount++; });

    await deliver(engine, payload);
    const second = await deliver(engine, payload);

    expect(callCount).toBe(1); // only ran once
    expect(second.processed).toBe(false);
  });

  test("concurrent deliveries of one event id dispatch exactly once (in-flight reservation)", async () => {
    // Hold the handler open so every delivery overlaps the first one's await —
    // the window in which a check-then-mark-after-await would let all of them
    // through.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    engine.on("payment.succeeded", async () => { calls++; await gate; });

    const payload = makeWebhookPayload("payment.succeeded", "evt_concurrent");
    const pending = Array.from({ length: 5 }, () => deliver(engine, payload));
    await new Promise((r) => setImmediate(r)); // let every call reach the gate
    release();
    const results = await Promise.all(pending);

    expect(calls).toBe(1);
    expect(results.filter((r) => r.processed)).toHaveLength(1);
    expect(results.filter((r) => r.error === "in_flight")).toHaveLength(4);
    // The reservation is released and the id is remembered: a late redelivery
    // is now a plain duplicate.
    expect((await deliver(engine, payload)).error).toBe("duplicate_event");
    expect(calls).toBe(1);
  });

  test("control: an in-flight event does not block a different event id", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    engine.on("payment.succeeded", async (event) => { seen.push(event.id); await gate; });

    const a = deliver(engine, makeWebhookPayload("payment.succeeded", "evt_a"));
    const b = deliver(engine, makeWebhookPayload("payment.succeeded", "evt_b"));
    await new Promise((r) => setImmediate(r));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.processed, rb.processed]).toEqual([true, true]);
    expect(seen.sort()).toEqual(["evt_a", "evt_b"]);
  });

  test("computes and verifies HMAC signature", async () => {
    const payload = makeWebhookPayload("payment.succeeded", "evt_sig");
    const ts = Math.floor(Date.now() / 1000);
    const sig = engine.computeSignature(payload, SECRET, ts);

    let handled = false;
    engine.on("payment.succeeded", async () => { handled = true; });

    const result = await engine.process({
      rawBody: payload,
      signature: sig,
      secret: SECRET,
      provider: "stripe",
      timestamp: ts,
    });

    expect(result.processed).toBe(true);
    expect(handled).toBe(true);
  });

  test("throws WebhookSignatureError on bad signature", async () => {
    const payload = makeWebhookPayload("payment.succeeded", "evt_badsig");
    await expect(
      engine.process({
        rawBody: payload,
        signature: "t=123,v1=invalidsignature",
        secret: SECRET,
        provider: "stripe",
      })
    ).rejects.toThrow(WebhookSignatureError);
  });

  test("rejects a well-formed, same-length (64-hex) but wrong v1 signature", async () => {
    // Guards the constant-time byte comparison itself. "invalidsignature" in
    // the test above is not 64 lowercase hex characters, so the strict format
    // check in _safeHexEqual rejects it before crypto.timingSafeEqual ever runs
    // (and its t=123 is also stale). Here the forged digest is well-formed and
    // the timestamp is fresh, so the timing-safe compare is the only check
    // that can reject it.
    const payload = makeWebhookPayload("payment.succeeded", "evt_samelen_forged");
    const ts = Math.floor(Date.now() / 1000);
    const genuine = engine.computeSignature(payload, SECRET, ts).split(",v1=")[1];
    // Flip the final nibble: still 64 valid hex chars, wrong in a single byte.
    const forged = genuine.slice(0, -1) + (genuine.endsWith("0") ? "1" : "0");
    expect(genuine).toMatch(/^[0-9a-f]{64}$/);
    expect(forged).toMatch(/^[0-9a-f]{64}$/);
    expect(forged).not.toBe(genuine);

    let handled = 0;
    engine.on("payment.succeeded", async () => { handled++; });

    const err = await engine
      .process({
        rawBody: payload,
        signature: `t=${ts},v1=${forged}`,
        secret: SECRET,
        provider: "stripe",
        timestamp: ts,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookSignatureError);
    expect((err as Error).message).toContain("signature_mismatch");
    expect(handled).toBe(0);

    // Control: the genuine digest in the identical header, with the same event
    // ID, is accepted. The rejection above is therefore down to the forged
    // bytes alone, and it did not mark the event ID as processed.
    const ok = await engine.process({
      rawBody: payload,
      signature: `t=${ts},v1=${genuine}`,
      secret: SECRET,
      provider: "stripe",
      timestamp: ts,
    });
    expect(ok.processed).toBe(true);
    expect(handled).toBe(1);
  });

  test("accepts ANY matching v1 — Stripe sends one per secret while an endpoint secret is rolled", async () => {
    const OLD = "whsec_old_secret_being_rolled";
    const NEW = "whsec_new_secret_after_roll";
    const payload = makeWebhookPayload("payment.succeeded", "evt_rotation");
    const ts = Math.floor(Date.now() / 1000);
    const v1 = (secret: string) => engine.computeSignature(payload, secret, ts).split(",v1=")[1];
    // Stripe's order during a roll: the header lists a signature per active secret.
    const header = `t=${ts},v1=${v1(OLD)},v1=${v1(NEW)}`;

    for (const [secret, id] of [[NEW, "evt_rot_new"], [OLD, "evt_rot_old"]] as const) {
      const body = payload.replace("evt_rotation", id);
      const sig = `t=${ts},v1=${engine.computeSignature(body, OLD, ts).split(",v1=")[1]},v1=${engine.computeSignature(body, NEW, ts).split(",v1=")[1]}`;
      const r = await engine.process({ rawBody: body, signature: sig, secret, provider: "stripe", timestamp: ts });
      expect(r.processed).toBe(true);
    }
    // Neither secret matching is still a mismatch.
    await expect(
      engine.process({ rawBody: payload, signature: header, secret: "whsec_unrelated", provider: "stripe", timestamp: ts }),
    ).rejects.toMatchObject({ reason: "signature_mismatch" });
  });

  test.each([
    ["trailing non-hex junk", (hex: string) => `${hex}zz`],
    ["a 65th hex character (odd nibble Buffer.from drops)", (hex: string) => `${hex}0`],
    ["uppercase hex", (hex: string) => hex.toUpperCase()],
    ["a 63-character prefix", (hex: string) => hex.slice(0, 63)],
  ])("rejects a valid digest mangled by %s", async (_label, mangle) => {
    let handled = 0;
    engine.on("payment.succeeded", async () => { handled++; });
    const payload = makeWebhookPayload("payment.succeeded", "evt_mangled");
    const ts = Math.floor(Date.now() / 1000);
    const genuine = engine.computeSignature(payload, SECRET, ts).split(",v1=")[1];
    const err = await engine
      .process({ rawBody: payload, signature: `t=${ts},v1=${mangle(genuine)}`, secret: SECRET, provider: "stripe", timestamp: ts })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookSignatureError);
    expect((err as WebhookSignatureError).reason).toBe("signature_mismatch");
    expect(handled).toBe(0);
  });

  test("generic HMAC path (non-Stripe): sha256=<hex> of the raw body; tamper and junk rejected", async () => {
    const crypto = await import("crypto");
    const payload = JSON.stringify({ id: "evt_generic", type: "transfer.completed" });
    const hex = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
    let handled = 0;
    engine.on(customEvent("transfer.completed"), async () => { handled++; });

    const ok = await engine.process({ rawBody: payload, signature: `sha256=${hex}`, secret: SECRET, provider: "mock" });
    expect(ok.processed).toBe(true);
    for (const [body, sig] of [
      [payload.replace("completed", "reversed"), `sha256=${hex}`],
      [payload.replace("evt_generic", "evt_generic2"), `sha256=${hex}zz`],
    ]) {
      await expect(engine.process({ rawBody: body, signature: sig, secret: SECRET, provider: "mock" })).rejects.toMatchObject({
        reason: "signature_mismatch",
      });
    }
    expect(handled).toBe(1);
  });

  test("documented limit: the generic HMAC path has no replay window — only event-id dedup stops a replay", async () => {
    const crypto = await import("crypto");
    const payload = JSON.stringify({ id: "evt_generic_replay", type: "transfer.completed" });
    const signature = `sha256=${crypto.createHmac("sha256", SECRET).update(payload).digest("hex")}`;
    const aDayLater = Math.floor(Date.now() / 1000) + 86_400;

    // "now" a day later: the Stripe path would reject a day-old signature, the
    // generic path cannot tell — nothing time-bound is signed.
    const first = await engine.process({ rawBody: payload, signature, secret: SECRET, provider: "mock", timestamp: aDayLater });
    expect(first.processed).toBe(true);
    const replay = await engine.process({ rawBody: payload, signature, secret: SECRET, provider: "mock", timestamp: aDayLater });
    expect(replay.error).toBe("duplicate_event");
    // A fresh engine (restart, another instance) has no dedup memory: the replay is accepted.
    const elsewhere = await new WebhookEngine({ maxRetries: 1 }).process({ rawBody: payload, signature, secret: SECRET, provider: "mock" });
    expect(elsewhere.processed).toBe(true);
  });

  test("documented limit: a Plaid-style JWT verification header is not supported and fails closed", async () => {
    let handled = 0;
    engine.on("*", async () => { handled++; });
    const plaidJwt = "eyJhbGciOiJFUzI1NiIsImtpZCI6IjZjNTUxNmUxIiwidHlwIjoiSldUIn0.eyJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJl";
    await expect(
      engine.process({
        rawBody: JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" }),
        signature: plaidJwt,
        secret: SECRET,
        provider: "plaid",
      }),
    ).rejects.toMatchObject({ reason: "signature_mismatch" });
    expect(handled).toBe(0);
  });

  test("dead-letters events when handler keeps failing", async () => {
    const payload = makeWebhookPayload("payment.failed", "evt_deadletter");
    engine.on("payment.failed", async () => {
      throw new Error("Handler always fails");
    });

    await deliver(engine, payload);
    expect(engine.getDeadLetters()).toHaveLength(1);
    expect(engine.getDeadLetters()[0].error).toBe("Handler always fails");
  });

  test("a handler that exhausts its retries is NOT acked (processed false, handler_failed)", async () => {
    engine.on("payment.succeeded", async () => {
      throw new Error("db unavailable");
    });
    const result = await deliver(engine, makeWebhookPayload("payment.succeeded", "evt_unacked"));
    expect(result).toMatchObject({
      processed: false,
      error: "handler_failed",
      handlersRun: 0,
      handlersFailed: 1,
    });
    expect(engine.getDeadLetters()).toHaveLength(1);
  });

  test("a failed event is not marked processed: the redelivery runs again and is acked once the handler recovers", async () => {
    // The fulfilment-loss scenario: if the failed delivery were remembered as
    // processed, the provider's retry would be swallowed as a duplicate and
    // the order would never be fulfilled.
    let attempts = 0;
    const fulfilled: string[] = [];
    engine.on("payment.succeeded", async (event) => {
      attempts++;
      if (attempts === 1) throw new Error("transient outage");
      fulfilled.push(event.id);
    });
    const payload = makeWebhookPayload("payment.succeeded", "evt_redelivered");

    const first = await deliver(engine, payload);
    expect(first.error).toBe("handler_failed");

    const redelivery = await deliver(engine, payload);
    expect(redelivery.processed).toBe(true);
    expect(fulfilled).toEqual(["evt_redelivered"]);

    const third = await deliver(engine, payload);
    expect(third.error).toBe("duplicate_event");
    expect(attempts).toBe(2);
  });

  test("one failing handler fails the whole event; successful handlers are counted", async () => {
    engine.on("payment.succeeded", async () => {});
    engine.on("*", async () => {
      throw new Error("audit log down");
    });
    const result = await deliver(engine, makeWebhookPayload("payment.succeeded", "evt_partial"));
    expect(result).toMatchObject({ processed: false, error: "handler_failed", handlersRun: 1, handlersFailed: 1 });
  });

  test("a real Stripe payment_intent.succeeded event runs the documented payment.succeeded handler", async () => {
    // README/usage/examples register "payment.succeeded"; Stripe sends
    // "payment_intent.succeeded". Before normalisation this ran 0 handlers.
    const seen: WebhookEvent[] = [];
    engine.on("payment.succeeded", async (event, data: any) => {
      seen.push(event);
      expect(data.object.id).toBe("pi_3QeXampleLkdIwHu7ix0s1Xn0bq");
    });
    const result = await deliver(engine, JSON.stringify(paymentIntentSucceeded("evt_real_pi")));
    expect(result).toMatchObject({ processed: true, handlersRun: 1, eventType: "payment.succeeded" });
    expect(seen[0].type).toBe("payment.succeeded");
    expect(seen[0].providerType).toBe("payment_intent.succeeded");
  });

  test("handlers on the raw Stripe name still run; a handler under both names runs once", async () => {
    let raw = 0;
    let both = 0;
    const onBoth = async () => { both++; };
    engine.on("payment_intent.succeeded", async () => { raw++; });
    engine.on(["payment.succeeded", "payment_intent.succeeded"], onBoth);
    engine.on("*", onBoth);
    const result = await deliver(engine, JSON.stringify(paymentIntentSucceeded("evt_both_names")));
    expect(result.handlersRun).toBe(2);
    expect([raw, both]).toEqual([1, 1]);
  });

  test("charge.dispute.closed maps to dispute.won / dispute.lost by status; other statuses keep Stripe's name", async () => {
    const types: string[] = [];
    engine.on("*", async (event) => { types.push(event.type); });
    await deliver(engine, JSON.stringify(disputeClosed("won", "evt_dp_won")));
    await deliver(engine, JSON.stringify(disputeClosed("lost", "evt_dp_lost")));
    await deliver(engine, JSON.stringify(disputeClosed("warning_closed", "evt_dp_warn")));
    expect(types).toEqual(["dispute.won", "dispute.lost", "charge.dispute.closed"]);
  });

  test.each([
    ["payment_intent.succeeded", "payment.succeeded"],
    ["payment_intent.payment_failed", "payment.failed"],
    ["payment_intent.processing", "payment.processing"],
    ["payment_intent.canceled", "payment.cancelled"],
    ["charge.dispute.created", "dispute.created"],
    ["charge.dispute.updated", "dispute.updated"],
  ])("%s reaches a handler registered under %s", async (stripeType, paykitType) => {
    const seen: { type: string; providerType?: string }[] = [];
    engine.on(customEvent(paykitType), async (event) => { seen.push({ type: event.type, providerType: event.providerType }); });
    await deliver(engine, JSON.stringify(stripeEvent(stripeType, { id: "obj_1" }, `evt_map_${stripeType}`)));
    expect(seen).toEqual([{ type: paykitType, providerType: stripeType }]);
    expect(normalizeStripeEventType(stripeType, {})).toBe(paykitType);
  });

  test.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "a type named %s is an unmapped name, not a lookup into Object.prototype",
    async (name) => {
      expect(normalizeStripeEventType(name, {})).toBe(name);
      const types: unknown[] = [];
      engine.on("*", async (event) => { types.push(event.type); });
      await deliver(engine, JSON.stringify(stripeEvent(name, { id: "obj_1" }, `evt_proto_${name}`)));
      expect(types).toEqual([name]);
    },
  );

  test("unmapped Stripe types pass through under their Stripe name", async () => {
    const types: string[] = [];
    engine.on("*", async (event) => { types.push(`${event.type}|${event.providerType}`); });
    await deliver(engine, JSON.stringify(stripeEvent("refund.created", { id: "re_1", object: "refund" }, "evt_re")));
    await deliver(engine, JSON.stringify(stripeEvent("charge.refunded", { id: "ch_1", object: "charge" }, "evt_chr")));
    expect(types).toEqual(["refund.created|refund.created", "charge.refunded|charge.refunded"]);
  });

  test("event type not registered does not throw", async () => {
    const payload = makeWebhookPayload("dispute.created", "evt_nohandler");
    const result = await deliver(engine, payload);
    expect(result.processed).toBe(true);
    expect(result.handlersRun).toBe(0);
  });

  test("off removes handlers", async () => {
    let called = false;
    engine.on("payment.succeeded", async () => { called = true; });
    engine.off("payment.succeeded");

    const payload = makeWebhookPayload("payment.succeeded", "evt_off");
    await deliver(engine, payload);
    expect(called).toBe(false);
  });

  test("clears processed cache", async () => {
    const payload = makeWebhookPayload("payment.succeeded", "evt_cache");
    let count = 0;
    engine.on("payment.succeeded", async () => { count++; });

    await deliver(engine, payload);
    engine.clearProcessedCache();
    await deliver(engine, payload);

    expect(count).toBe(2); // processed twice after cache clear
  });

  test("invalid JSON throws PayKitError", async () => {
    await expect(deliver(engine, "not json {{{")).rejects.toThrow("Invalid JSON");
  });
});

describe("WebhookEngine — an event with no id is rejected, never given an invented one", () => {
  // A substitute such as `evt_${Date.now()}` would be a fresh id on every
  // delivery, so a redelivered event would never be recognised as a duplicate.
  test.each([
    ["no id", { type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } }],
    ["an empty id", { id: "", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } }],
    ["a non-string id", { id: { nested: true }, type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } }],
  ])("a signed Stripe event with %s is INVALID_PAYLOAD on every delivery and runs no handler", async (_label, body) => {
    const engine = new WebhookEngine({ maxRetries: 1 });
    let handled = 0;
    engine.on("*", async () => {
      handled++;
    });
    const rawBody = JSON.stringify(body);
    for (let delivery = 0; delivery < 2; delivery++) {
      await expect(deliver(engine, rawBody)).rejects.toMatchObject({ code: "INVALID_PAYLOAD", provider: "stripe" });
    }
    expect(handled).toBe(0);
  });

  test("generic provider: neither id nor eventId → rejected; eventId and numeric ids are used and deduplicated", async () => {
    const crypto = await import("crypto");
    const engine = new WebhookEngine({ maxRetries: 1 });
    const seen: string[] = [];
    engine.on("*", async (event) => {
      seen.push(event.id);
    });
    const send = (body: object) => {
      const rawBody = JSON.stringify(body);
      const signature = `sha256=${crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;
      return engine.process({ rawBody, signature, secret: SECRET, provider: "mock" });
    };

    await expect(send({ type: "transfer.completed" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD", provider: "mock" });
    await send({ eventId: "wh_77", type: "transfer.completed" });
    await send({ id: 12345, type: "transfer.completed" });
    expect(seen).toEqual(["wh_77", "12345"]);
    expect((await send({ id: 12345, type: "transfer.completed" })).error).toBe("duplicate_event");
  });
});

describe("WebhookEngine config is validated at construction", () => {
  test.each([
    [{ maxRetries: 0 }, /maxRetries must be an integer >= 1/],
    [{ maxRetries: -1 }, /maxRetries/],
    [{ maxRetries: 1.5 }, /maxRetries/],
    [{ initialDelayMs: Number.NaN }, /initialDelayMs/],
    [{ initialDelayMs: -5 }, /initialDelayMs/],
    [{ maxProcessedIds: -1 }, /maxProcessedIds/],
    [{ maxDeadLetters: 2.5 }, /maxDeadLetters/],
  ])("%o throws INVALID_CONFIG", (config, message) => {
    expect(() => new WebhookEngine(config)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringMatching(message) }));
  });

  test("maxRetries: 1 runs a handler exactly once (it was maxRetries: 0 that never ran it)", async () => {
    const engine = new WebhookEngine({ maxRetries: 1, allowUnsigned: true });
    let runs = 0;
    engine.on("*", async () => {
      runs++;
    });
    const result = await engine.process({ rawBody: JSON.stringify({ id: "evt_once", type: "x" }), provider: "stripe" });
    expect(result).toMatchObject({ processed: true, handlersRun: 1 });
    expect(runs).toBe(1);
  });
});

describe("WebhookEngine — a Stripe-Signature header with two timestamps", () => {
  const body = JSON.stringify({ id: "evt_two_t", type: "payment.succeeded" });

  test("the first t= is the one read", () => {
    expect(parseStripeSignatureHeader("t=1,t=2,v1=abc")).toEqual({ timestamp: "1", signatures: ["abc"] });
  });

  test("a later t= is ignored: the signature is still checked against the first", () => {
    const engine = new WebhookEngine();
    const now = Math.floor(Date.now() / 1000);
    const [t, v1] = engine.computeSignature(body, SECRET, now).split(",");
    expect(engine.verifyStripeSignature(body, `${t},t=${now + 1000},${v1}`, SECRET)).toBe(true);
    // And a stale signature gains nothing from a fresh timestamp appended after it.
    const [staleT, staleV1] = engine.computeSignature(body, SECRET, now - 10_000).split(",");
    expect(engine.verifyStripeSignature(body, `${staleT},t=${now},${staleV1}`, SECRET)).toBe(false);
  });
});

describe("WebhookEngine handler retry-with-backoff", () => {
  test("a failing handler is retried with jittered, doubling delays, then succeeds", async () => {
    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;
    const spy = jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);
    try {
      // handlerTimeoutMs: 0 so the only timers captured are the backoff sleeps.
      const engine = new WebhookEngine({ maxRetries: 3, initialDelayMs: 100, allowUnsigned: true, handlerTimeoutMs: 0 });
      let attempts = 0;
      engine.on("*", async () => {
        attempts++;
        if (attempts < 3) throw new Error(`transient ${attempts}`);
      });
      const result = await engine.process({ rawBody: JSON.stringify({ id: "evt_backoff", type: "x" }), provider: "stripe" });
      expect(result).toMatchObject({ processed: true, handlersRun: 1 });
      expect(attempts).toBe(3);
      // Two sleeps between three attempts: full jitter in [d/2, d], d doubling from 100.
      expect(delays).toHaveLength(2);
      expect(delays[0]).toBeGreaterThanOrEqual(50);
      expect(delays[0]).toBeLessThanOrEqual(100);
      expect(delays[1]).toBeGreaterThanOrEqual(100);
      expect(delays[1]).toBeLessThanOrEqual(200);
      expect(engine.getDeadLetters()).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test.each([
    [0, [50, 100]],
    [0.5, [75, 150]],
    [1, [100, 200]],
  ])("the jitter, exactly: with Math.random pinned at %p the sleeps are %j", async (random, expected) => {
    const delays: number[] = [];
    const realSetTimeout = global.setTimeout;
    const timers = jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);
    const rand = jest.spyOn(Math, "random").mockReturnValue(random);
    try {
      const engine = new WebhookEngine({ maxRetries: 3, initialDelayMs: 100, allowUnsigned: true, handlerTimeoutMs: 0 });
      engine.on("*", async () => {
        throw new Error("down");
      });
      await engine.process({ rawBody: JSON.stringify({ id: "evt_jitter", type: "x" }), provider: "stripe" });
      expect(delays).toEqual(expected);
    } finally {
      timers.mockRestore();
      rand.mockRestore();
    }
  });

  test("when every attempt fails, the event is dead-lettered after maxRetries attempts and not acknowledged", async () => {
    const engine = new WebhookEngine({ maxRetries: 2, initialDelayMs: 1, allowUnsigned: true });
    let attempts = 0;
    engine.on("*", async () => {
      attempts++;
      throw new Error("down");
    });
    const result = await engine.process({ rawBody: JSON.stringify({ id: "evt_dead", type: "x" }), provider: "stripe" });
    expect(result).toMatchObject({ processed: false, error: "handler_failed", handlersFailed: 1 });
    expect(attempts).toBe(2);
    expect(engine.getDeadLetters().map((d) => d.error)).toEqual(["down"]);
  });
});

describe("WebhookEngine handler timeout — a slow handler never runs twice at once, and its real outcome is recorded", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const body = (id: string) => JSON.stringify({ id, type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });

  test("an overlapping redelivery: one copy only, in_flight while it runs, and a late success is acknowledged", async () => {
    const engine = new WebhookEngine({ handlerTimeoutMs: 100, initialDelayMs: 10, allowUnsigned: true });
    let running = 0;
    let maxConcurrent = 0;
    let starts = 0;
    engine.on("payment.succeeded", async () => {
      starts++;
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await sleep(400); // slow fulfilment, e.g. a shipping API
      running--;
    });
    const t0 = Date.now();
    const first = await engine.process({ rawBody: body("evt_slow"), provider: "stripe" });
    expect(first.error).toBe("in_flight"); // non-2xx: the provider will redeliver
    expect(Date.now() - t0).toBeLessThan(350); // process() stopped waiting at the timeout
    const during = await engine.process({ rawBody: body("evt_slow"), provider: "stripe" });
    expect(during.error).toBe("in_flight");
    await sleep(450); // the original attempt finishes — successfully
    const after = await engine.process({ rawBody: body("evt_slow"), provider: "stripe" });
    expect(after.error).toBe("duplicate_event"); // its success was recorded: acknowledged, not re-run
    expect({ starts, maxConcurrent }).toEqual({ starts: 1, maxConcurrent: 1 });
    expect(engine.getDeadLetters()).toHaveLength(0);
  });

  test("handlerTimeoutMs bounds one attempt, not process(): at the defaults, 25 s failures hold the response past 75 s", async () => {
    jest.useFakeTimers();
    try {
      const engine = new WebhookEngine({ allowUnsigned: true });
      let attempts = 0;
      engine.on("*", async () => {
        attempts++;
        await new Promise((_, reject) => setTimeout(() => reject(new Error("slow failure")), 25_000));
      });
      let answer: unknown;
      const answered = engine.process({ rawBody: body("evt_total_time"), provider: "stripe" }).then((r) => {
        answer = r;
      });
      await jest.advanceTimersByTimeAsync(74_000);
      expect(attempts).toBe(3);
      expect(answer).toBeUndefined();
      await jest.advanceTimersByTimeAsync(3_000); // 3 x 25 s, plus at most 1.5 s of backoff
      await answered;
      expect(answer).toMatchObject({ processed: false, error: "handler_failed" });
    } finally {
      jest.useRealTimers();
    }
  });

  test("a timed-out attempt that later fails is retried only after it settled, then dead-lettered with its real error", async () => {
    const engine = new WebhookEngine({ handlerTimeoutMs: 50, maxRetries: 2, initialDelayMs: 1, allowUnsigned: true });
    let running = 0;
    let maxConcurrent = 0;
    let starts = 0;
    engine.on("*", async () => {
      starts++;
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      try {
        if (starts === 1) {
          await sleep(150);
          throw new Error("slow failure");
        }
        throw new Error("fast failure");
      } finally {
        running--;
      }
    });
    expect((await engine.process({ rawBody: body("evt_late_fail"), provider: "stripe" })).error).toBe("in_flight");
    await sleep(250);
    expect(engine.getDeadLetters().map((d) => d.error)).toEqual(["fast failure"]);
    expect({ starts, maxConcurrent }).toEqual({ starts: 2, maxConcurrent: 1 });
    // Released after the failure, so the provider's redelivery dispatches again.
    const redelivery = await engine.process({ rawBody: body("evt_late_fail"), provider: "stripe" });
    expect(redelivery.error).toBe("handler_failed");
    expect(starts).toBe(4);
  });

  test("the attempt's signal is aborted at the timeout, so a handler can stop its own work", async () => {
    const engine = new WebhookEngine({ handlerTimeoutMs: 30, maxRetries: 1, allowUnsigned: true });
    let aborted = false;
    engine.on("*", async (_event, _data, { signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        });
      });
    });
    expect((await engine.process({ rawBody: body("evt_abort"), provider: "stripe" })).error).toBe("in_flight");
    await sleep(20);
    expect(aborted).toBe(true);
    expect(engine.getDeadLetters().map((d) => d.error)).toEqual(["handler exceeded handlerTimeoutMs (30ms)"]);
    // It settled (rejected), so the event is free again.
    expect((await engine.process({ rawBody: body("evt_abort"), provider: "stripe" })).error).toBe("in_flight");
  });

  test("a handler that never settles is never started twice: the event stays in_flight in this process", async () => {
    const engine = new WebhookEngine({ handlerTimeoutMs: 20, maxRetries: 3, initialDelayMs: 1, allowUnsigned: true });
    let starts = 0;
    engine.on("*", () => {
      starts++;
      return new Promise<void>(() => {}); // ignores its signal, never settles
    });
    for (let i = 0; i < 3; i++) {
      expect((await engine.process({ rawBody: body("evt_hung"), provider: "stripe" })).error).toBe("in_flight");
      await sleep(30);
    }
    expect(starts).toBe(1);
  });

  test("a handler that finishes in time is unaffected", async () => {
    const engine = new WebhookEngine({ handlerTimeoutMs: 1_000, allowUnsigned: true });
    engine.on("*", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const result = await engine.process({ rawBody: JSON.stringify({ id: "evt_quick", type: "x" }), provider: "stripe" });
    expect(result).toMatchObject({ processed: true, handlersRun: 1 });
  });

  test.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY]])("handlerTimeoutMs %p is INVALID_CONFIG", (handlerTimeoutMs) => {
    expect(() => new WebhookEngine({ handlerTimeoutMs })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
});

describe("WebhookEngine — a handler under the wrong name cannot lose events quietly", () => {
  const repo = path.join(__dirname, "..");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    skipLibCheck: true,
    baseUrl: repo,
    paths: { paykit: ["src/index.ts"] },
    typeRoots: [path.join(repo, "node_modules", "@types")],
    types: ["node"],
  };
  const PRELUDE = `import { WebhookEngine, customEvent } from "paykit";
const engine = new WebhookEngine();
const handler = async () => {};
export { engine, handler, customEvent };
`;

  function withSnippet<R>(code: string, use: (file: string) => R): R {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paykit-webhook-types-"));
    const file = path.join(dir, "snippet.ts");
    try {
      fs.writeFileSync(file, PRELUDE + code);
      return use(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** What `tsc --strict` says about a snippet: empty means it compiles. */
  const compileErrors = (code: string): string[] =>
    withSnippet(code, (file) => {
      const program = ts.createProgram([file], options);
      return ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    });

  test.each([
    ["the Stripe name, misspelt", 'engine.on("payment_intent.suceeded", handler);'],
    ["the canonical name, misspelt", 'engine.on("payment.succeded", handler);'],
    ["a misspelt name in an array", 'engine.on(["payment.succeeded", "dispute.craeted"], handler);'],
    ["off() with a misspelt name", 'engine.off("payment.succeded");'],
    ["a plain string variable", 'const name: string = "payment.succeeded"; engine.on(name, handler);'],
  ])("does not compile: %s", (_name, line) => {
    expect(compileErrors(line).join("\n")).toMatch(/not assignable/);
  });

  test("compiles: known names, arrays, the wildcard, custom events, a handler's types", () => {
    expect(
      compileErrors(`
engine.on("payment.succeeded", handler);
engine.on("payment_intent.succeeded", handler);
engine.on(["dispute.created", "charge.dispute.closed", "refund.updated", "charge.refunded"], handler);
engine.on("*", handler);
engine.on(customEvent("invoice.paid"), handler);
engine.on(["payment.failed", customEvent("transfer.completed")], handler);
const computed: string = "x" + "y";
engine.on(customEvent(computed), handler);
engine.off("payment.succeeded");
engine.off(customEvent("invoice.paid"));
engine.off("*");
engine.on<{ object: { id: string } }>("payment.succeeded", async (_event, data, { signal }) => {
  const id: string = data.object.id;
  signal.throwIfAborted();
  void id;
});
`),
    ).toEqual([]);
  });

  test("autocomplete still offers the known names, Stripe's and PayKit's", () => {
    const code = 'engine.on("");\n';
    const entries = withSnippet(code, (file) => {
      const text = fs.readFileSync(file, "utf8");
      const service = ts.createLanguageService({
        getCompilationSettings: () => options,
        getScriptFileNames: () => [file],
        getScriptVersion: () => "1",
        getScriptSnapshot: (name) => (fs.existsSync(name) ? ts.ScriptSnapshot.fromString(fs.readFileSync(name, "utf8")) : undefined),
        getCurrentDirectory: () => repo,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: fs.existsSync,
        readFile: (name) => fs.readFileSync(name, "utf8"),
      });
      const position = text.lastIndexOf('engine.on("') + 'engine.on("'.length;
      return service.getCompletionsAtPosition(file, position, {})?.entries.map((e) => e.name) ?? [];
    });
    expect(entries).toEqual(expect.arrayContaining(["payment.succeeded", "payment_intent.succeeded", "dispute.lost", "*"]));
  });

  test("the typo'd delivery is told apart: unhandled, handlersRun 0, and it still acknowledges", async () => {
    const engine = new WebhookEngine();
    let ran = 0;
    engine.on(customEvent("payment_intent.suceeded"), async () => { ran++; });
    const result = await deliver(engine, makeWebhookPayload("payment_intent.succeeded", "evt_typo"));
    expect(result).toEqual({ processed: true, eventId: "evt_typo", eventType: "payment.succeeded", handlersRun: 0, unhandled: true });
    expect(ran).toBe(0);
  });

  test("a wildcard handler is a match: with one registered, nothing is ever unhandled", async () => {
    const engine = new WebhookEngine({ allowUnsigned: true });
    const seen: string[] = [];
    engine.on("*", async (event) => {
      seen.push(event.id);
    });
    const result = await engine.process({ rawBody: JSON.stringify({ id: "evt_any", type: "nobody.listens" }), provider: "stripe" });
    expect(result).toEqual({ processed: true, eventId: "evt_any", eventType: "nobody.listens", handlersRun: 1 });
    expect(seen).toEqual(["evt_any"]);
  });

  test("control: a delivery a handler ran for carries no unhandled flag; nor does a failed one", async () => {
    const engine = new WebhookEngine({ maxRetries: 1 });
    engine.on("payment.succeeded", async () => {});
    engine.on("payment.failed", async () => { throw new Error("boom"); });
    const ran = await deliver(engine, makeWebhookPayload("payment.succeeded", "evt_ran"));
    expect(ran).toEqual({ processed: true, eventId: "evt_ran", eventType: "payment.succeeded", handlersRun: 1 });
    const failed = await deliver(engine, makeWebhookPayload("payment.failed", "evt_failed"));
    expect(failed.processed).toBe(false);
    expect(failed.unhandled).toBeUndefined();
  });

  test("customEvent returns the name unchanged and it dispatches", async () => {
    expect(customEvent("invoice.paid")).toBe("invoice.paid");
    const engine = new WebhookEngine();
    let ran = 0;
    engine.on(customEvent("invoice.paid"), async () => { ran++; });
    const result = await deliver(engine, makeWebhookPayload("invoice.paid", "evt_custom"));
    expect(result).toMatchObject({ processed: true, handlersRun: 1 });
    expect(result.unhandled).toBeUndefined();
    expect(ran).toBe(1);
  });
});
