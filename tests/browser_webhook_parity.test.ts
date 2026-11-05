/**
 * Parity test: the frontend's BrowserWebhookEngine (Web Crypto) must behave
 * exactly like the real Node-crypto WebhookEngine.
 *
 * The frontend ships a `BrowserWebhookEngine` (frontend/lib/sdk.ts) because the
 * real `WebhookEngine` uses Node's `crypto` module, which is not available in
 * the browser. This suite imports THAT class — not a copy of its algorithm —
 * (jest maps its `paykit` import to `src/index.ts`) and runs it on Node's Web
 * Crypto, the same `crypto.subtle` API the browser uses. Every verdict below is
 * asserted against both engines, so the reimplementation cannot drift from the
 * shipped primitive without a red test — a browser-only test would pass even if
 * the shipped Node engine broke.
 */

import { createHmac, webcrypto } from "crypto";

import { WebhookEngine } from "../src/webhooks/handler";
import { checkTimestampFreshness } from "../src/webhooks/freshness";
import { PayKitError, WebhookSignatureError } from "../src/types";
import {
  BrowserWebhookEngine,
  WebhookSignatureError as BrowserWebhookSignatureError,
} from "../frontend/lib/sdk";
import { paymentIntentSucceeded } from "./fixtures/stripe_events";

// Node 20+ exposes Web Crypto as `globalThis.crypto`; Node 18 only behind a
// flag. The browser engine reads `globalThis.crypto`, so provide it on 18.
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

describe("BrowserWebhookEngine parity with real WebhookEngine", () => {
  const secret = "whsec_demo_secret_key_for_playground_only";
  const ts = 1_700_000_000;
  const rawBody = JSON.stringify({
    id: "evt_parity",
    type: "payment.succeeded",
    livemode: false,
    created: ts,
    data: { object: { id: "pay_xyz789", amount: 4999, currency: "usd" } },
  });

  it("produces a signature identical to the real Node engine", async () => {
    const real = new WebhookEngine();
    const realSig = real.computeSignature(rawBody, secret, ts);
    const browserSig = await new BrowserWebhookEngine().computeSignature(rawBody, secret, ts);
    expect(browserSig).toBe(realSig);
  });

  it("browser-computed signatures verify against the real engine", async () => {
    // toleranceSeconds: 0 disables the replay-window check — this test asserts
    // signature-algorithm parity, not timestamp freshness (which has its own tests),
    // and uses a fixed historical `ts`.
    const real = new WebhookEngine({ toleranceSeconds: 0 });
    const browserSig = await new BrowserWebhookEngine().computeSignature(rawBody, secret, ts);
    expect(real.verifyStripeSignature(rawBody, browserSig, secret)).toBe(true);
  });

  it("real-engine signatures verify against the browser engine", async () => {
    const realSig = new WebhookEngine().computeSignature(rawBody, secret, ts);
    const browser = new BrowserWebhookEngine();
    expect(await browser.verifyStripeSignature(rawBody, realSig, secret, ts)).toBe(true);
  });

  it("detects tampered payloads (the signature does not match)", async () => {
    // toleranceSeconds: 0 disables the replay-window check. Otherwise the fixed
    // historical `ts` is rejected as stale before the signature matters, and
    // this test would pass even if the HMAC comparison accepted everything.
    const real = new WebhookEngine({ toleranceSeconds: 0 });
    const browser = new BrowserWebhookEngine({ toleranceSeconds: 0 });
    const browserSig = await browser.computeSignature(rawBody, secret, ts);
    const tampered = rawBody.replace("pay_xyz789", "TAMPERED_ID");
    expect(real.verifyStripeSignature(tampered, browserSig, secret)).toBe(false);
    expect(await browser.verifyStripeSignature(tampered, browserSig, secret)).toBe(false);
  });
});

describe("replay-window parity (shared checkTimestampFreshness)", () => {
  const secret = "whsec_demo_secret_key_for_playground_only";
  const rawBody = JSON.stringify({ id: "evt_replay", type: "payment.succeeded" });
  const now = 1_700_000_000;
  const browser = new BrowserWebhookEngine({ toleranceSeconds: 300 });

  it("accepts a validly-signed payload inside the window", async () => {
    const sig = await browser.computeSignature(rawBody, secret, now - 200);
    expect(await browser.verifyStripeSignature(rawBody, sig, secret, now)).toBe(true);
  });

  it("rejects a validly-signed payload outside the window (replay)", async () => {
    const sig = await browser.computeSignature(rawBody, secret, now - 301);
    expect(await browser.verifyStripeSignature(rawBody, sig, secret, now)).toBe(false);
  });

  it("rejects future-dated timestamps beyond tolerance", async () => {
    const sig = await browser.computeSignature(rawBody, secret, now + 301);
    expect(await browser.verifyStripeSignature(rawBody, sig, secret, now)).toBe(false);
  });

  it("matches the Node engine verdict on the same stale payload", async () => {
    // Node's verifyStripeSignature reads the real clock internally, so sign
    // with a timestamp 400s in the actual past (tolerance 300s) — stale for
    // both engines regardless of the milliseconds this test takes.
    const wallNow = Math.floor(Date.now() / 1000);
    const staleTs = wallNow - 400;
    const sig = await browser.computeSignature(rawBody, secret, staleTs);
    const real = new WebhookEngine({ toleranceSeconds: 300 });
    const nodeVerdict = real.verifyStripeSignature(rawBody, sig, secret);
    const browserVerdict = await browser.verifyStripeSignature(rawBody, sig, secret, wallNow);
    expect(browserVerdict).toBe(nodeVerdict);
    expect(browserVerdict).toBe(false);
  });

  it("shared checkTimestampFreshness: boundary + invalid + disabled", () => {
    expect(checkTimestampFreshness(String(now - 300), 300, now).ok).toBe(true); // boundary inclusive
    expect(checkTimestampFreshness(String(now - 301), 300, now)).toEqual({
      ok: false,
      reason: "timestamp_outside_tolerance",
    });
    expect(checkTimestampFreshness("not-a-number", 300, now)).toEqual({
      ok: false,
      reason: "invalid_timestamp",
    });
    expect(checkTimestampFreshness("0", 0, now).ok).toBe(true); // 0 disables
  });
});

/**
 * One table, two engines. Each row is a delivery; both engines must reach the
 * same verdict — "processed" (handler ran) or "rejected:<reason>" (handler did
 * NOT run) — and that verdict must be the expected one.
 */
describe("process() verdict parity — fail-closed gate, tamper, replay", () => {
  const SECRET = "whsec_parity_table_secret";
  const NOW = Math.floor(Date.now() / 1000);
  const UNSET_ENV_SECRET = process.env["PAYKIT_TEST_DEFINITELY_UNSET_SECRET"];

  type Row = {
    name: string;
    allowUnsigned?: boolean;
    secret: string | undefined;
    sign: "valid" | "none" | "empty" | "tampered" | "stale";
    expected: string;
  };

  const rows: Row[] = [
    { name: "valid signature", secret: SECRET, sign: "valid", expected: "processed" },
    { name: "secret configured, no signature header", secret: SECRET, sign: "none", expected: "rejected:missing_signature" },
    { name: "secret configured, empty signature header", secret: SECRET, sign: "empty", expected: "rejected:missing_signature" },
    { name: "no secret (env var unset), signed anyway", secret: UNSET_ENV_SECRET, sign: "valid", expected: "rejected:missing_secret" },
    { name: "empty-string secret, unsigned", secret: "", sign: "none", expected: "rejected:missing_secret" },
    { name: "allowUnsigned + no secret", allowUnsigned: true, secret: undefined, sign: "none", expected: "processed" },
    { name: "allowUnsigned never relaxes a configured secret", allowUnsigned: true, secret: SECRET, sign: "none", expected: "rejected:missing_signature" },
    { name: "body tampered after signing", secret: SECRET, sign: "tampered", expected: "rejected:signature_mismatch" },
    { name: "signature older than the replay window", secret: SECRET, sign: "stale", expected: "rejected:timestamp_outside_tolerance" },
  ];

  async function deliver(
    engine: WebhookEngine | BrowserWebhookEngine,
    row: Row,
    eventId: string,
  ): Promise<string> {
    let handled = 0;
    engine.on("payment.succeeded", async () => {
      handled++;
    });
    const rawBody = JSON.stringify({ id: eventId, type: "payment.succeeded", data: { object: { id: "pi_1" } } });
    const signTs = row.sign === "stale" ? NOW - 301 : NOW;
    const signed = await engine.computeSignature(rawBody, SECRET, signTs);
    const signature = row.sign === "none" ? undefined : row.sign === "empty" ? "" : signed;
    const body = row.sign === "tampered" ? rawBody.replace("pi_1", "pi_TAMPERED") : rawBody;
    try {
      const result = await engine.process({ rawBody: body, signature, secret: row.secret, provider: "stripe", timestamp: NOW });
      return result.processed && handled === 1 ? "processed" : `unexpected:${JSON.stringify(result)}`;
    } catch (err) {
      const isSigError = err instanceof WebhookSignatureError || err instanceof BrowserWebhookSignatureError;
      if (!isSigError) return `threw:${(err as Error).message}`;
      return handled === 0 ? `rejected:${(err as { reason?: string }).reason}` : "rejected-after-handler-ran";
    }
  }

  test.each(rows)("$name -> $expected (both engines)", async (row) => {
    const node = await deliver(new WebhookEngine({ maxRetries: 1, allowUnsigned: row.allowUnsigned }), row, `evt_node_${row.name}`);
    const browser = await deliver(new BrowserWebhookEngine({ allowUnsigned: row.allowUnsigned }), row, `evt_browser_${row.name}`);
    expect({ node, browser }).toEqual({ node: row.expected, browser: row.expected });
  });
});

describe("dedup parity — synchronous in-flight reservation (no await between check and reserve)", () => {
  const SECRET = "whsec_parity_dedup_secret";

  test.each([
    ["Node WebhookEngine", () => new WebhookEngine({ maxRetries: 1 })],
    ["BrowserWebhookEngine", () => new BrowserWebhookEngine()],
  ] as const)("%s: 5 concurrent deliveries of one id dispatch once", async (_name, make) => {
    const engine = make();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    engine.on("payment.succeeded", async () => { calls++; await gate; });

    const now = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({ id: "evt_parity_race", type: "payment.succeeded", data: {} });
    const signature = await engine.computeSignature(rawBody, SECRET, now);
    const pending = Array.from({ length: 5 }, () =>
      engine.process({ rawBody, signature, secret: SECRET, provider: "stripe", timestamp: now }),
    );
    // The browser engine awaits Web Crypto before its dedup check, so give
    // every call time to get past verification and reach the reservation.
    await new Promise((r) => setTimeout(r, 200));
    release();
    const results = await Promise.all(pending);

    expect(calls).toBe(1);
    expect(results.filter((r) => r.processed)).toHaveLength(1);
    expect(results.filter((r) => r.error === "in_flight")).toHaveLength(4);
  });
});

describe("failure parity — a failed event is not acked and is redelivered", () => {
  const SECRET = "whsec_parity_failure_secret";

  test.each([
    ["Node WebhookEngine", () => new WebhookEngine({ maxRetries: 1 })],
    ["BrowserWebhookEngine", () => new BrowserWebhookEngine()],
  ] as const)("%s: handler_failed, then processed, then duplicate_event", async (_name, make) => {
    const engine = make();
    let attempts = 0;
    engine.on("payment.succeeded", async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient outage");
    });
    const rawBody = JSON.stringify({ id: "evt_parity_fail", type: "payment.succeeded", data: {} });
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const now = Math.floor(Date.now() / 1000);
      const signature = await engine.computeSignature(rawBody, SECRET, now);
      const r = await engine.process({ rawBody, signature, secret: SECRET, provider: "stripe", timestamp: now });
      outcomes.push(r.processed ? "processed" : String(r.error));
    }
    expect(outcomes).toEqual(["handler_failed", "processed", "duplicate_event"]);
    expect(attempts).toBe(2);
  });
});

describe("event-name parity — real Stripe types reach PayKit handlers in both engines", () => {
  const SECRET = "whsec_parity_names_secret";

  test.each([
    ["Node WebhookEngine", () => new WebhookEngine({ maxRetries: 1 })],
    ["BrowserWebhookEngine", () => new BrowserWebhookEngine()],
  ] as const)("%s: payment_intent.succeeded -> payment.succeeded handler, raw type kept", async (_name, make) => {
    const engine = make();
    const seen: string[] = [];
    engine.on("payment.succeeded", async (event) => { seen.push(`${event.type}|${event.providerType}`); });
    const rawBody = JSON.stringify(paymentIntentSucceeded("evt_parity_names"));
    const now = Math.floor(Date.now() / 1000);
    const signature = await engine.computeSignature(rawBody, SECRET, now);
    const r = await engine.process({ rawBody, signature, secret: SECRET, provider: "stripe", timestamp: now });
    expect(r.processed).toBe(true);
    expect(seen).toEqual(["payment.succeeded|payment_intent.succeeded"]);
  });
});

describe("signature-header parity — rotated secrets and strict digest format", () => {
  const SECRET = "whsec_parity_header_secret";
  const OTHER = "whsec_parity_previous_secret";

  type HeaderRow = [name: string, expected: string, build: (v1: (secret: string) => string, ts: number) => string];
  const rows: HeaderRow[] = [
    ["second v1 matches (secret being rolled)", "processed", (v1, ts) => `t=${ts},v1=${v1(OTHER)},v1=${v1(SECRET)}`],
    ["only the other secret's v1", "rejected:signature_mismatch", (v1, ts) => `t=${ts},v1=${v1(OTHER)}`],
    ["valid digest + trailing junk", "rejected:signature_mismatch", (v1, ts) => `t=${ts},v1=${v1(SECRET)}zz`],
    ["valid digest + 65th hex char", "rejected:signature_mismatch", (v1, ts) => `t=${ts},v1=${v1(SECRET)}0`],
    ["uppercase digest", "rejected:signature_mismatch", (v1, ts) => `t=${ts},v1=${v1(SECRET).toUpperCase()}`],
    ["no v1 at all", "rejected:malformed_signature_header", (_v1, ts) => `t=${ts},v0=abc`],
  ];

  test.each(rows)("%s -> %s (both engines)", async (name, expected, build) => {
    const verdicts: string[] = [];
    for (const engine of [new WebhookEngine({ maxRetries: 1 }), new BrowserWebhookEngine()]) {
      const rawBody = JSON.stringify({ id: `evt_hdr_${name}`, type: "payment.succeeded", data: {} });
      const ts = Math.floor(Date.now() / 1000);
      const sigs = new Map<string, string>();
      for (const sec of [SECRET, OTHER]) {
        sigs.set(sec, (await engine.computeSignature(rawBody, sec, ts)).split(",v1=")[1]);
      }
      let handled = 0;
      engine.on("payment.succeeded", async () => { handled++; });
      try {
        const r = await engine.process({
          rawBody,
          signature: build((sec) => sigs.get(sec)!, ts),
          secret: SECRET,
          provider: "stripe",
          timestamp: ts,
        });
        verdicts.push(r.processed && handled === 1 ? "processed" : `unexpected:${r.error}`);
      } catch (err) {
        verdicts.push(handled === 0 ? `rejected:${(err as { reason?: string }).reason}` : "rejected-after-handler-ran");
      }
    }
    expect(verdicts).toEqual([expected, expected]);
  });
});

describe("event-id parity — no id means rejected, in both engines", () => {
  const SECRET = "whsec_parity_id_secret";

  test.each([
    ["Node WebhookEngine", () => new WebhookEngine({ maxRetries: 1 })],
    ["BrowserWebhookEngine", () => new BrowserWebhookEngine()],
  ] as const)("%s: a signed Stripe event without an id is refused and runs no handler", async (_name, make) => {
    const engine = make();
    let handled = 0;
    engine.on("*", async () => {
      handled++;
    });
    const rawBody = JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
    const ts = Math.floor(Date.now() / 1000);
    const signature = await engine.computeSignature(rawBody, SECRET, ts);
    await expect(
      engine.process({ rawBody, signature, secret: SECRET, provider: "stripe", timestamp: ts }),
    ).rejects.toThrow(/has no id/);
    expect(handled).toBe(0);
  });
});

describe("dedup-scope parity — event ids are unique per provider, not globally", () => {
  test.each([
    ["Node WebhookEngine", () => new WebhookEngine({ maxRetries: 1, allowUnsigned: true })],
    ["BrowserWebhookEngine", () => new BrowserWebhookEngine({ allowUnsigned: true })],
  ] as const)("%s: another provider's evt_1 does not swallow Stripe's evt_1; Stripe's own redelivery still does", async (_name, make) => {
    const engine = make();
    let stripeRan = 0;
    engine.on("payment.succeeded", async () => {
      stripeRan++;
    });
    const stripeBody = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });

    const wise = await engine.process({ rawBody: JSON.stringify({ id: "evt_1", type: "transfer" }), provider: "wise" });
    const first = await engine.process({ rawBody: stripeBody, provider: "stripe" });
    const redelivery = await engine.process({ rawBody: stripeBody, provider: "stripe" });

    expect(wise.processed).toBe(true);
    expect(first).toMatchObject({ processed: true, eventId: "evt_1", handlersRun: 1 });
    expect(redelivery).toMatchObject({ processed: false, eventId: "evt_1", error: "duplicate_event" });
    expect(stripeRan).toBe(1);
  });
});

describe("no-handler parity — both engines report a delivery nothing ran for", () => {
  it.each([
    ["node", () => new WebhookEngine({ allowUnsigned: true })],
    ["browser", () => new BrowserWebhookEngine({ allowUnsigned: true })],
  ] as const)("%s: unhandled when no handler matched, absent when one ran", async (_name, build) => {
    const engine = build();
    const body = JSON.stringify({ id: "evt_none", type: "payment.succeeded" });
    expect(await engine.process({ rawBody: body, provider: "stripe" })).toEqual({
      processed: true,
      eventId: "evt_none",
      eventType: "payment.succeeded",
      handlersRun: 0,
      unhandled: true,
    });
    engine.on("payment.failed", async () => {});
    const ran = await engine.process({ rawBody: JSON.stringify({ id: "evt_one", type: "payment.failed" }), provider: "stripe" });
    expect(ran).toEqual({ processed: true, eventId: "evt_one", eventType: "payment.failed", handlersRun: 1 });
  });
});

describe("payload-shape parity — a signed body that is valid JSON but not an object is refused cleanly", () => {
  const SECRET = "whsec_parity_shape_secret";

  test.each([
    ["Node WebhookEngine", () => new WebhookEngine({ maxRetries: 1 })],
    ["BrowserWebhookEngine", () => new BrowserWebhookEngine()],
  ] as const)("%s: null, [], 42 and a JSON string are payload errors, never a TypeError", async (_name, make) => {
    const engine = make();
    let handled = 0;
    engine.on("*", async () => {
      handled++;
    });
    const ts = Math.floor(Date.now() / 1000);
    for (const rawBody of ["null", "[]", "42", '"evt_1"']) {
      const signature = await engine.computeSignature(rawBody, SECRET, ts);
      const err = await engine
        .process({ rawBody, signature, secret: SECRET, provider: "stripe", timestamp: ts })
        .catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(TypeError);
      expect((err as Error).message).toBe("Webhook body must be a JSON object");
      if (engine instanceof WebhookEngine) {
        expect(err).toBeInstanceOf(PayKitError);
        expect(err).toMatchObject({ code: "INVALID_PAYLOAD", provider: "stripe" });
      }
    }
    expect(handled).toBe(0);
  });
});

describe("replay-window config parity — an invalid toleranceSeconds is refused, never a silent 'accept any age'", () => {
  const unsetEnv = Number(process.env["PAYKIT_TEST_DEFINITELY_UNSET_TOLERANCE"]); // NaN

  test.each([
    ["NaN from Number(unset env var)", unsetEnv],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative value", -1],
    ["more than a day", 86_401],
    ["a numeric string", "300" as unknown as number],
  ])("%s throws at construction in both engines", (_name, toleranceSeconds) => {
    expect(() => new WebhookEngine({ toleranceSeconds })).toThrow(
      expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringContaining("toleranceSeconds") }),
    );
    expect(() => new BrowserWebhookEngine({ toleranceSeconds })).toThrow(/toleranceSeconds/);
  });

  test("the shared freshness check fails closed for an invalid tolerance, rather than accepting every age", () => {
    const thirtyDaysAgo = String(1_700_000_000 - 30 * 86_400);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(checkTimestampFreshness(thirtyDaysAgo, bad, 1_700_000_000)).toEqual({ ok: false, reason: "invalid_tolerance" });
    }
    expect(checkTimestampFreshness(thirtyDaysAgo, 0, 1_700_000_000)).toEqual({ ok: true }); // 0 still disables, explicitly
    expect(checkTimestampFreshness(thirtyDaysAgo, 300, 1_700_000_000)).toEqual({ ok: false, reason: "timestamp_outside_tolerance" });
  });

  test("a validly signed 30-day-old event is rejected with the default tolerance in both engines", async () => {
    const secret = "whsec_parity_tolerance";
    const old = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const rawBody = JSON.stringify({ id: "evt_old", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
    for (const engine of [new WebhookEngine({ maxRetries: 1 }), new BrowserWebhookEngine()]) {
      const signature = await engine.computeSignature(rawBody, secret, old);
      await expect(engine.process({ rawBody, signature, secret, provider: "stripe" })).rejects.toMatchObject({
        reason: "timestamp_outside_tolerance",
      });
    }
  });
});

describe("what the browser engine deliberately does NOT share (docs/architecture.md says so)", () => {
  const body = JSON.stringify({ id: "evt_diff", type: "payment_intent.succeeded", data: { object: {} } });

  test("a failing handler runs once in the browser and maxRetries times in Node", async () => {
    const count = async (engine: { on(type: "*", h: () => Promise<void>): unknown; process(o: { rawBody: string; provider: "stripe" }): Promise<unknown> }) => {
      let runs = 0;
      engine.on("*", async () => {
        runs++;
        throw new Error("down");
      });
      await engine.process({ rawBody: body, provider: "stripe" });
      return runs;
    };
    expect(await count(new BrowserWebhookEngine({ allowUnsigned: true }))).toBe(1);
    expect(await count(new WebhookEngine({ allowUnsigned: true, maxRetries: 3, initialDelayMs: 1 }))).toBe(3);
  });

  test("a non-Stripe provider gets the Stripe scheme in the browser and the generic HMAC in Node", async () => {
    const secret = "whsec_parity";
    const generic = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const node = await new WebhookEngine().process({ rawBody: body, signature: generic, secret, provider: "plaid" });
    expect(node.processed).toBe(true);
    await expect(new BrowserWebhookEngine().process({ rawBody: body, signature: generic, secret, provider: "plaid" })).rejects.toThrow();
    const stripeSigned = await new BrowserWebhookEngine().computeSignature(body, secret);
    expect((await new BrowserWebhookEngine().process({ rawBody: body, signature: stripeSigned, secret, provider: "plaid" })).processed).toBe(true);
  });
});
