# PayKit Usage Guide

Concrete, copy-paste examples for each PayKit component. Every snippet below is
grounded in the public API exported from `paykit`. For a runnable end-to-end
script, see [`examples/basic_payment.ts`](../examples/basic_payment.ts).

## Installation

```bash
# Not on the npm registry yet: install from git (npm builds dist/ via the
# package's `prepare` script) — see the README's Installation section.
npm install github:ROROK20/PayKit
# Optional: only if you use the Stripe provider
npm install stripe
```

```typescript
import {
  MockProvider,
  StripeProvider,
  IdempotentPaymentExecutor,
  InMemoryIdempotencyStore,
  WebhookEngine,
  ReconciliationEngine,
  FraudDetector,
  PayKitError,
  WebhookSignatureError,
  type IdempotencyStore,
  type IdempotencyRecord,
  type PaymentIntent,
  type InternalRecord,
  type ProviderRecord,
  type FraudRule,
} from "paykit";
```

## 1. Create a payment (with a provider)

The `MockProvider` is great for local development and tests — no network, no
keys. Swap in `StripeProvider` for production.

```typescript
const provider = new MockProvider({ successRate: 1.0 });

const payment = await provider.createPayment({
  amount: { amount: 4999, currency: "USD" }, // $49.99, in cents
  idempotencyKey: "order_abc_001",
  description: "Premium subscription",
  metadata: { orderId: "ord_001", userId: "usr_42" },
});

console.log(payment.id, payment.status); // "mock_pay_..." "succeeded"
```

`MockProvider` honours idempotency keys the way Stripe does — every provider
must (see [Idempotent payments](#2-idempotent-payments)): calling
`createPayment` again with `order_abc_001` returns this same payment, and the
same key with a different request throws `IdempotencyError`.

Production wiring:

```typescript
const stripe = new StripeProvider({
  secretKey: process.env.STRIPE_SECRET_KEY,
  // Optional. Pinned unless overridden: apiVersion "2024-06-20",
  // timeoutMs 20_000 and maxNetworkRetries 1 (stripe-node's own defaults are
  // 80 s and, in current versions, 2) — see the Redis sizing note below.
  // Stripe, // optional: the SDK constructor (import Stripe from "stripe")
});
await stripe.ready(); // true once loaded; false (and a warning) without a key
                      // or without the stripe package; throws on a broken install
```

`stripe` is loaded lazily the first time a provider is constructed: the
CommonJS build (`dist/index.js`) loads it through its own module's `require`
(so require hooks and `jest.mock("stripe")` apply), the ES-module build
(`dist/index.mjs`) with a dynamic `import()` — there is nothing to configure
for either. Only "the `stripe` package is not
installed" becomes a warning plus `NOT_INITIALIZED` on every call; any other
load failure (a missing dependency of stripe, a corrupted install) is thrown
from `ready()` and from every call as the original error.

Unlike `MockProvider`, which settles every payment at once, Stripe charges
nothing until a payment method is confirmed. What `StripeProvider` sends and
returns per request shape (full table: README, "What a Stripe payment
returns"):

- **No `paymentMethodId`** — an unconfirmed intent: status `pending` (Stripe's
  `requires_payment_method`) with `clientSecret` (Stripe's `client_secret`).
  Return that, not the PaymentIntent id, to the browser for Stripe.js to
  confirm.
- **`paymentMethodId`** — confirmed server-side (`confirm=true`). Without a
  `returnUrl` the adapter sends `automatic_payment_methods.allow_redirects:
  "never"` (Stripe otherwise requires a `return_url` to confirm), so only
  non-redirect methods such as cards qualify. Result: `succeeded`,
  `processing`, or `pending` when Stripe needs 3-D Secure (`requires_action`:
  pass `clientSecret` to `stripe.handleNextAction()`); a decline throws a
  non-retryable `ProviderError` (`card_declined`).
- **`paymentMethodId` + `returnUrl`** — also sends `return_url`; redirect-based
  methods are allowed.
- **`paymentMethodId` + `offSession: true`** — a saved method charged while the
  customer is away (`off_session=true`); pass its `customerId` too. A bank that
  demands authentication makes Stripe decline with `authentication_required`.
- **`captureMethod: "manual"`, with any of these** — authorizes now and leaves
  the money to `provider.capturePayment(id)`. The result reads `"processing"`
  (Stripe's `requires_capture`) until then. Without it there is nothing to capture.
- **`returnUrl` or `offSession` without `paymentMethodId`** — throws
  `INVALID_REQUEST` before any API call (Stripe accepts both only when
  confirming); pass a return URL to `stripe.confirmPayment()` in the browser
  instead.

`refundPayment` requires an `idempotencyKey` (`INVALID_IDEMPOTENCY_KEY` without one):
derive it from your refund request — a support ticket, a refunds-table row —
so a retried refund refunds once; never from the clock, nor from (payment,
amount) alone, which would merge two legitimate equal partial refunds. It
refunds in full when `amount` is omitted; a partial `amount`
must be a positive integer of minor units (`INVALID_AMOUNT` otherwise — `0` is
an error, not a full refund) in the payment's own currency, which
`StripeProvider` checks by reading the PaymentIntent first (`INVALID_REQUEST`
on a mismatch, before any refund is created). Refund results report
`succeeded`, `pending` (including Stripe's `requires_action`), `failed` or
`cancelled`. Stripe errors that cannot succeed
on an identical retry — a reused idempotency key (`IdempotencyError`), bad
credentials (`authentication_error`), missing permissions
(`permission_error`) — are not retryable. Stripe's `idempotency_key_in_use`
(the key's first request is still executing, e.g. after a client-side
timeout) is the exception: a retryable `ProviderError`, so the executor
re-sends under the same key and receives the original result. Other Stripe
error codes: a stripe-node timeout is `timeout` and a connection failure
`network_error` (both a `StripeConnectionError`, both retryable — the charge
may have happened, and the same key makes the re-send safe), a
`StripeAPIError` is `server_error` (retryable), and an error that is not a
Stripe API outcome at all is `unknown` and not retried. All of these, and
`idempotency_key_in_use`, carry `outcomeUnknown: true`: a payment may exist, so
never move to a new key without checking. After a `server_error` the same key
may keep answering 500, so reconcile against Stripe first (the README's "A Stripe
500 leaves the outcome unknown" gives the steps; that replay comes from
stripe-node's source and has not been observed against live Stripe).

## 2. Idempotent payments

Wrap any provider in `IdempotentPaymentExecutor`. The same `idempotencyKey`
returns the cached result instead of charging twice. Retries re-send the same
key — a timeout can arrive after the charge — so the provider must honour it:
`StripeProvider` forwards it to Stripe and `MockProvider` deduplicates, and a
custom provider must too (see
[what PayKit guarantees](../README.md#what-paykit-guarantees-and-what-it-relies-on-the-provider-for)).
`execute()` first requires an idempotency key (`assertIdempotencyKey`: a
non-empty string of printable ASCII, no surrounding whitespace, at most 255
characters —
`INVALID_IDEMPOTENCY_KEY` otherwise; a key-less request would share one slot
with every other key-less request, handing one customer another's
PaymentIntent and `clientSecret`). It then validates the money with the
exported `assertValidMoney`:
the amount must be a positive integer number of minor units no larger than
`Number.MAX_SAFE_INTEGER` (`INVALID_AMOUNT` for `0`, `49.99`, negatives,
`1e21`), and the currency a three-letter code such as `USD` or `usd`
(`INVALID_CURRENCY` for `"usd "`, `"X"`, `"US$"`) — before any provider call.
A `succeeded`, `pending` or `processing` result is replayed for `ttlMs`, a
`failed`/`cancelled` one for `failedTtlMs` (60s); a declined card is retried
with a new key.

```typescript
const executor = new IdempotentPaymentExecutor(provider, {
  retry: {
    maxAttempts: 3,
    initialDelayMs: 200,
    maxDelayMs: 5000,
    backoffFactor: 2,
    // These four are the default. Passing the option makes the list EXACT:
    // only listed codes are retried, even if an error says retryable: true.
    // Left out, errors flagged retryable (e.g. idempotency_key_in_use) retry too.
    retryableErrors: ["rate_limit", "network_error", "timeout", "server_error"],
  },
  ttlMs: 86_400_000, // 24h key TTL
});

const p1 = await executor.execute({
  amount: { amount: 9999, currency: "USD" },
  idempotencyKey: "sub_monthly_usr42_jan",
});

// Network blip? Retry safely with the SAME key:
const p2 = await executor.execute({
  amount: { amount: 9999, currency: "USD" },
  idempotencyKey: "sub_monthly_usr42_jan",
});

console.assert(p1.id === p2.id);                    // true — charged once
console.log(p2.metadata?._idempotency);             // "cache_hit"

// Is a result recorded for this key? False while the first call is still in
// flight, so this is not a guard against charging twice: execute() is.
await executor.isDuplicate("sub_monthly_usr42_jan"); // true

// Drop PayKit's cached result for the key (use with caution). This does NOT
// force a re-charge: the next execute() with the key reaches the provider,
// which — honouring the key — returns the original payment. New charge, new key.
// A call still in flight for the key keeps its reservation, so invalidating
// mid-call never starts a second provider call alongside it.
await executor.invalidate("sub_monthly_usr42_jan");
```

If the provider answers and the store then fails, `execute()` throws
`PaymentResultNotStoredError` with the provider's result in `err.intent`. That is
not a failed payment: keep `err.paymentIntentId`, and don't retry under a new key.
Logging the error can't leak the client secret, because `err.intent` is reached only
by name; don't log `err.intent` itself. The
key stays reserved, so a retry under the same key waits for it.

Reusing a key with **any** different request field (amount, currency,
description, metadata, customer, payment method, return URL, `offSession`,
`captureMethod`) throws
`IdempotencyError` — from any executor sharing the store, because the request
fingerprint is stored next to the cached result. Metadata key order and
currency case do not count as differences.

### Plugging in Redis

The default `InMemoryIdempotencyStore` is fine for a single process. For
production, implement `IdempotencyStore` — **all six methods**. If one store
serves several accounts of a provider (test and live, two merchants), give each
executor its own `scope`, or the second is handed the first's result. Keys reach
the store as `idempotencyStoreKey(providerName, scope, key)`. `reserve` and
`release` are not optional extras: they are how the one-call-in-flight
guarantee survives multiple processes, and a store missing them fails to compile.

`reserve(key)` must be **one atomic command**. Redis `SET … NX PX` is exactly
that primitive: the write lands only if the key is absent, so of two simultaneous
retries exactly one wins and only that one calls the provider. The tempting
`exists()` → `set()` version is the double-charge race itself — between the two
round-trips both callers observe "absent" and both charge the card.

```typescript
import { randomUUID } from "node:crypto";

// Prefix of every in-flight marker; the rest is that reservation's token.
// A marker is never a terminal result.
const PENDING = "__paykit_pending__:";
const DEL_IF_EQUAL =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const DEL_IF_NOT_PENDING =
  'local v = redis.call("get", KEYS[1]) if v and string.sub(v, 1, #ARGV[1]) ~= ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private redis: Redis,
    private pendingTtlMs = 180_000,
  ) {}

  async get(key: string): Promise<IdempotencyRecord | null> {
    const raw = await this.redis.get(key);
    // A pending marker means "in flight", not "done" — the caller must wait.
    if (!raw || raw.startsWith(PENDING)) return null;
    const record = JSON.parse(raw) as IdempotencyRecord;
    // JSON turns Dates into ISO strings; revive the two the SDK types as Date.
    record.intent.createdAt = new Date(record.intent.createdAt);
    record.intent.updatedAt = new Date(record.intent.updatedAt);
    return record;
  }

  async set(key: string, record: IdempotencyRecord, ttlMs = 86_400_000): Promise<void> {
    // Writing the terminal result replaces this key's pending marker. The
    // record carries the request fingerprint too — persist all of it, so
    // every server can reject a conflicting reuse of the key.
    await this.redis.set(key, JSON.stringify(record), "PX", ttlMs);
  }

  async delete(key: string): Promise<void> {
    // Drop a terminal result only. A pending marker belongs to the call that
    // is executing; deleting it would let a second caller reserve the key and
    // charge concurrently (IdempotencyStore.delete's contract).
    await this.redis.eval(DEL_IF_NOT_PENDING, 1, key, PENDING);
  }

  async has(key: string): Promise<boolean> {
    // Deliberately routed through get(): a pending marker is not a duplicate.
    return (await this.get(key)) !== null;
  }

  async reserve(key: string): Promise<string | null> {
    // NX = "only if absent": "OK" for the single winner, null for losers. The
    // marker is a fresh token, which the executor hands back to release().
    const token = `${PENDING}${randomUUID()}`;
    const won = await this.redis.set(key, token, "PX", this.pendingTtlMs, "NX");
    return won === "OK" ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    // Compare-and-delete in one round trip: remove the key only while it
    // still holds THIS reservation's token — never a newer reservation that
    // replaced an expired marker, never a terminal result.
    await this.redis.eval(DEL_IF_EQUAL, 1, key, token);
  }
}

const executor = new IdempotentPaymentExecutor(provider, {
  store: new RedisIdempotencyStore(redis),
});
```

Three operational notes:

- **Size `pendingTtlMs` above the whole retry envelope, not just one provider
  call.** `execute()` retries internally, so a single reservation can span every
  attempt, and stripe-node re-sends inside each attempt. Budget
  `maxAttempts × ((1 + maxNetworkRetries) × timeoutMs + SDK retry sleeps)` plus
  the executor's backoff sum. `StripeProvider` sets stripe-node's `timeout` and
  `maxNetworkRetries` explicitly — defaults 20 s and 1 (stripe-node alone would
  use 80 s and, in current versions, 2), configurable as `timeoutMs` /
  `maxNetworkRetries` — and stripe-node sleeps 0.5 s before that retry. The
  executor defaults (`maxAttempts: 3`, `initialDelayMs: 200`,
  `backoffFactor: 2`, jitter in `[base/2, base]`) add at most ~600 ms of
  backoff. Together: 3 × (2 × 20 s + 0.5 s) + 0.6 s ≈ 122 s, so the example's
  180 s default clears the shipped defaults; recompute if you change any of
  them. The TTL exists only so a crashed process cannot pin a key forever; if
  it expires while a charge is still in flight, a later caller can win a fresh
  reservation for that same key.
- **Every marker is its reservation's own token.** If a reservation does
  outlive its TTL, the sequence is: A reserves → A's marker expires → B
  reserves and writes its own marker → A's provider call fails and A releases.
  With one shared marker value, A's release would delete **B's** reservation
  and a third caller could charge. Here `reserve()` returns the token it
  wrote, the executor hands exactly that token to `release(key, token)`, and
  the compare-and-delete only matches A's own marker — A's late release is a
  no-op against B's. `get()`/`has()` treat any `PENDING`-prefixed value as
  in flight, and `delete()` leaves such values in place.
- **Syntax is `ioredis`.** On `node-redis` v4 the reservation is
  `set(key, token, { PX: pendingTtlMs, NX: true })`, which returns `"OK"` or
  `null` the same way, and `eval(script, { keys: [key], arguments: [token] })`.

## 3. Webhooks

Register handlers, then feed raw request bodies to `process()`. Signatures are
verified with timing-safe HMAC-SHA256, and verification **fails closed**: a
call with a `secret` but no signature throws `WebhookSignatureError`
(`reason: "missing_signature"`), and a call with no `secret` at all — an unset
env var included — throws `reason: "missing_secret"`. Processing unsigned
events requires the explicit opt-in `new WebhookEngine({ allowUnsigned: true })`
(local demos and tests only; it never relaxes a secret you pass).

Register handlers under PayKit's event names. A Stripe event arrives as e.g.
`payment_intent.succeeded`; the engine sets `event.type` to `payment.succeeded`,
keeps `event.providerType === "payment_intent.succeeded"`, and runs handlers
registered under either name (and `*`), each once. Mapped: `payment_intent.
{succeeded,payment_failed,processing,canceled}` → `payment.{succeeded,failed,
processing,cancelled}`, `charge.dispute.{created,updated}` → `dispute.{created,
updated}`, `charge.dispute.closed` → `dispute.won` / `dispute.lost` by status.
Every other Stripe type (`refund.created`, `charge.refunded`, …) keeps its name.

`on()` is typed to catch a misspelt name: it takes a known name (the canonical
ones, the Stripe names behind them, `refund.created`, `refund.updated`,
`refund.failed`, `charge.refunded`), `*`, or `customEvent(name)` for anything
else, including a name held in a `string` variable. An event no handler matches
returns `processed: true`, `handlersRun: 0`, `unhandled: true`: acknowledge it,
and log it, since the provider stops retrying once you do. `refund.succeeded` is
accepted too, but never fires for Stripe, which has no such event: use
`refund.updated`, `refund.failed` or `charge.refunded` there.

```typescript
const engine = new WebhookEngine({ maxRetries: 3, initialDelayMs: 500 });

// Stripe: payment_intent.succeeded. `data` is `unknown` until you say what you
// read from it, a compile-time claim rather than a runtime check.
engine.on<{ object: { id: string } }>("payment.succeeded", async (event, data) => {
  await fulfillOrder(data.object.id); // data.object is the PaymentIntent
});

engine.on(["dispute.created", "dispute.lost"], async (event, data) => {
  await escalateToSupport(data);
});

// Wildcard handler runs for every event, so with one registered, nothing is ever
// `unhandled`:
engine.on("*", async (event) => {
  await auditLog.record(event.type, event.id);
});
```

> **Concurrent deliveries dispatch once.** `process()` reserves the event id
> synchronously before the first handler runs; an overlapping delivery of the
> same id returns `{ processed: false, error: "in_flight" }` without running
> anything.
>
> **No event id, no processing.** A verified payload with no `id` (non-Stripe:
> no `id` or `eventId`) throws `PayKitError` with `code: "INVALID_PAYLOAD"`;
> the engine never invents an id, which would defeat deduplication.
>
> **Deduplication is bounded and in-memory.** The engine remembers the most
> recent `maxProcessedIds` event IDs (default 10,000) in a FIFO — memory stays
> flat, but an event replayed after that many *other* distinct events have been
> seen is not recognized as a duplicate. Size `maxProcessedIds` above the
> number of distinct events you expect inside your provider's retry window
> (Stripe retries for up to ~3 days). The engine has no pluggable store: for
> strict, durable or cross-instance exactly-once effects, record processed
> events in your own database from the handler, keyed on
> `webhookDedupKey(provider, id)` (ids are unique only per provider), and skip
> the work when the key already exists.

> **Non-Stripe providers use a generic `sha256=<hex>` HMAC of the raw body with
> no signed timestamp — there is no replay window on that path, only event-id
> dedup.** It is not Plaid's (JWT) or Wise's (RSA) scheme; PayKit ships no
> adapter for either, so their real webhooks will fail verification.

In a route handler — **always use the raw body** for signature verification:

```typescript
// Express
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const result = await engine.process({
      rawBody: req.body.toString(),
      signature: req.headers["stripe-signature"] as string,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
      provider: "stripe",
    });
    if (result.processed || result.error === "duplicate_event") {
      return res.json({ received: true }); // done, or already done
    }
    // "handler_failed" (a handler exhausted its retries) or "in_flight"
    // (another delivery of this id is still running): answer non-2xx so the
    // provider redelivers later rather than considering it done.
    res.status(503).json({ received: false, error: result.error });
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      return res.status(400).send("Invalid signature");
    }
    res.status(500).send("Webhook error");
  }
});
```

Inspect events whose handlers exhausted all retries:

```typescript
const failed = engine.getDeadLetters();
// [{ event, error, failedAt }, ...]
```

A dead-lettered event is **not acknowledged**: `process()` returns
`{ processed: false, error: "handler_failed", handlersFailed }` and does not
remember the id, so the provider's redelivery dispatches again. Delivery is
therefore at-least-once — make handlers idempotent.

The dead-letter list is in memory and bounded: one entry per failed delivery
(whole event included), most recent `maxDeadLetters` kept (default 1,000; `0`
for unbounded), oldest dropped first. For a durable record, persist failures
from your route.

### Constructing a signed test webhook

```typescript
// Never hardcode a real webhook secret — read it from the environment. The
// literal fallback here is only so this snippet runs standalone in a demo.
const secret = process.env.WEBHOOK_SECRET ?? "whsec_demo_only_do_not_commit_real_secrets";

const body = JSON.stringify({
  id: "evt_test_1",
  object: "event",
  type: "payment_intent.succeeded", // the name Stripe really sends
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: "pi_123", object: "payment_intent" } },
});

const signature = engine.computeSignature(body, secret);

await engine.process({
  rawBody: body,
  signature,
  secret,
  provider: "stripe",
});
```

## 4. Reconciliation

Compare your database against the provider's records. By default
`ProviderRecord.status` is a payment outcome (PayKit `PaymentStatus`, Stripe
PaymentIntent / Charge status), so `pending` means not paid. For Stripe
balance transactions — whose `pending` means charged but funds not yet
available — construct the engine with
`providerRecordType: "balance_transaction"`; their `pending` and `available`
then both count as succeeded.

A status disagreement is always reported: `refunded` is not `succeeded`, and a
Stripe PaymentIntent or Charge stays `succeeded` after a refund. So give records
`amountRefunded` (a Charge's `amount_refunded`) next to the raw status: a
`succeeded` row with a total above 0 reads as refunded, and the totals are
compared. A `partially_refunded` pair that does not state one on both sides is
`refund_unverified`, never a clean match. Give records a `reference` (your order
id) and two charges for one order are flagged as a possible double charge, and a
pair whose references differ is a `reference_mismatch`. `report.outcome`
is the verdict for code, and only `"perfect"` is an all-clear: both sides empty
is `"nothing_to_reconcile"`, one side empty is the error state
`"provider_records_empty"` / `"internal_records_empty"`. The README's
[Reconciliation](../README.md#reconciliation) section has the full status table,
and says exactly what `"perfect"` compares and what it does not.

```typescript
const internal: InternalRecord[] = [
  { id: "i1", providerPaymentId: "pay_001", amount: { amount: 4999, currency: "USD" }, status: "succeeded", createdAt: new Date() },
  { id: "i2", providerPaymentId: "pay_002", amount: { amount: 9999, currency: "USD" }, status: "succeeded", createdAt: new Date() },
];

const providerRecords: ProviderRecord[] = [
  { id: "pay_001", amount: { amount: 4999, currency: "USD" }, status: "succeeded", createdAt: new Date() },
  { id: "pay_phantom", amount: { amount: 2500, currency: "USD" }, status: "succeeded", createdAt: new Date() },
];

const reconciler = new ReconciliationEngine({
  provider: "stripe",
  fuzzyDate: true, // match within ±1 day when no provider id is set
  // toleranceAmount defaults to 0: amounts (minor units) must match exactly.
  // Opt in, e.g. `toleranceAmount: 1`, only if your ledger rounds differently
  // from the provider's — it hides every discrepancy up to that size.
});

const report = reconciler.reconcile(internal, providerRecords);

console.log(report.summary);
// "Matched 1/2. 1 internal record unmatched. 1 provider record unmatched. Review required."
// (i2 names pay_002, which the provider does not have: it is reported, never
//  re-matched to pay_phantom by amount.)

for (const m of report.matches) {
  if (m.status !== "matched") {
    console.warn(m.status, m.internalId, m.providerId, m.notes);
  }
}
```

## 5. Fraud detection

A weighted, pluggable rule engine with seven built-in rules —
`high_amount_new_account`, `new_payment_method_high_amount`, `high_velocity`,
`round_number_amount`, `missing_user_agent`, `very_high_amount`,
`anonymous_transaction` (`detector.getRules()` lists them) — and your own via
`addRule()`. `high_velocity` fires when `previousPaymentCount` exceeds 10:
PayKit counts nothing and applies no window, so pass the customer's payment
count over the window you mean (e.g. the last 24 h). No built-in rule reads
`ipAddress` or `deviceFingerprint`; there are no device, IP or geographic
checks unless you add them. The built-in
amount thresholds are minor units with no FX conversion, tuned for 2-decimal
currencies (100,000 = $1,000.00 but ¥100,000); reason strings render them in
the payment's currency.

Above `reviewAmountCeiling` (default 10,000,000 minor units, $100,000.00 in USD)
the recommendation is at least `"review"` whatever the score, since the amount
rules alone cannot get a known customer there. Set your own with
`new FraudDetector({ reviewAmountCeiling })`; it is minor units with no FX
conversion, and `riskScore` and `riskLevel` are left as the rules made them.
Above `reviewVelocityCeiling` (default 50) the same goes for
`previousPaymentCount`, at any amount: card testing is many tiny charges the amount
rules never see. Pass a count over your window, not a lifetime count.

`check()` fails closed on input it cannot score: score 100, `"critical"`,
`"decline"`, with the field named in `reasons`. That covers an amount that is
not a non-negative safe integer, an `accountAgeDays` that is not a finite
number >= 0 (an age computed from a missing date is `NaN`), and a
`previousPaymentCount` that is not a non-negative safe integer. Leave a field
out when you have no such signal: its rule then stays silent.

```typescript
const detector = new FraudDetector();

const highRiskCountry: FraudRule = (ctx) => ({
  name: "high_risk_country",
  triggered: (ctx.metadata?.country ?? "") === "XX",
  weight: 35,
  reason: "Transaction from a high-risk jurisdiction",
});
detector.addRule(highRiskCountry);

const ctx = {
  amount: { amount: 500_000, currency: "USD" }, // $5,000
  customerId: "cus_abc",
  userAgent: "Mozilla/5.0",
  accountAgeDays: 1,
  isNewPaymentMethod: true,
  previousPaymentCount: 12, // payments in YOUR velocity window
};
const result = detector.check(ctx);

console.log(result.riskScore);      // 85
console.log(result.riskLevel);      // "critical"
console.log(result.recommendation); // "decline"
console.log(result.signals.filter((s) => s.triggered).map((s) => s.name)); // ["high_amount_new_account","new_payment_method_high_amount","high_velocity","round_number_amount"]

// Refuse the charge before it reaches the provider:
const allowed = result.recommendation !== "decline";
console.log(allowed);               // false

// Score many at once (same customer, a $25 payment):
const results = detector.checkBatch([ctx, { ...ctx, amount: { amount: 2_500, currency: "USD" } }]);
console.log(results.map((r) => r.recommendation)); // ["decline","approve"]
```

The printed values are this block's real output, checked by
`tests/docs_examples.test.ts`, which runs it (verified 2026-11-04):
30 + 25 + 20 + 10 from the four triggered rules (`high_risk_country` stays off —
no `metadata.country`); the $25 payment trips only `high_velocity` (20).

## 6. Error handling

All PayKit errors extend `PayKitError`, which carries a `code`, an optional
`provider`, and a `retryable` flag. A `ProviderError` from Stripe keeps
Stripe's own `code` (`card_declined`, `resource_missing`,
`charge_already_refunded`, …) and, when Stripe names one, the offending
request parameter in `param`.

```typescript
import { PayKitError, IdempotencyError, WebhookSignatureError, ProviderError } from "paykit";

try {
  await executor.execute(request);
} catch (err) {
  if (err instanceof ProviderError && err.retryable) {
    // safe to retry
  } else if (err instanceof IdempotencyError) {
    // same key, different parameters — raised by PayKit's store check, or by
    // Stripe itself (err.provider === "stripe"); never retried automatically
  } else if (err instanceof PayKitError) {
    console.error(err.code, err.provider, err.message);
  } else {
    throw err;
  }
}
```

## Next steps

- Architecture and data-flow overview: [architecture.md](architecture.md)
- Runnable demo: [`examples/basic_payment.ts`](../examples/basic_payment.ts) and
  [`examples/nextjs_integration.ts`](../examples/nextjs_integration.ts) —
  its `getSession()` auth stub refuses every caller until you replace it;
  authentication and authorization are the integrator's job
- Interactive playground, from the repo root:
  `npm install && cd frontend && npm install && npm run dev` →
  http://localhost:3005
