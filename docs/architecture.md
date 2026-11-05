# PayKit Architecture

PayKit is a composable TypeScript SDK for payments infrastructure. It is built
around a small set of independent components that share a common type system and
a provider abstraction. There is no global state and no required runtime
dependency — components are plain classes you instantiate and wire together.

## Design principles

- **Composable, not a framework.** Each component (`IdempotentPaymentExecutor`,
  `WebhookEngine`, `ReconciliationEngine`, `FraudDetector`) is usable on its own.
- **Provider-agnostic.** Business logic talks to `PaymentProvider_Interface`, not
  to Stripe directly. Swap `MockProvider` for `StripeProvider` without touching
  callers.
- **Pluggable storage.** Idempotency state goes through the `IdempotencyStore`
  interface; the default is in-memory, but Redis (or any backend) can be dropped
  in.
- **Zero required dependencies.** `stripe` is an optional peer dependency. The
  webhook engine uses only the Node `crypto` module.

## Component overview

```
                         ┌──────────────────────────┐
                         │   src/types/index.ts     │
                         │  Money, PaymentIntent,   │
                         │  WebhookEvent, Fraud*,   │
                         │  Reconciliation*, Errors │
                         └────────────┬─────────────┘
                                      │ shared types
        ┌───────────────┬─────────────┼──────────────┬────────────────┐
        ▼               ▼             ▼              ▼                ▼
┌───────────────┐ ┌───────────┐ ┌──────────┐ ┌───────────────┐ ┌────────────┐
│ Idempotent    │ │ Webhook   │ │ Fraud    │ │ Reconciliation│ │ Providers  │
│ PaymentExec.  │ │ Engine    │ │ Detector │ │ Engine        │ │ Mock/Stripe│
│ payments/     │ │ webhooks/ │ │ fraud/   │ │ reconciliation│ │ providers/ │
└──────┬────────┘ └───────────┘ └──────────┘ └───────────────┘ └─────┬──────┘
       │                                                              │
       │  wraps a PaymentProvider_Interface ──────────────────────────┘
       ▼
┌───────────────┐
│ IdempotencyStore (interface)                                  │
│  default: InMemoryIdempotencyStore  ·  pluggable: Redis, etc. │
└───────────────────────────────────────────────────────────────┘
```

All public symbols are re-exported from `src/index.ts`, the package barrel.

## Components

### 1. Provider abstraction (`src/providers/`)

`PaymentProvider_Interface` defines the contract every provider implements:
`createPayment`, `capturePayment`, `cancelPayment`, `refundPayment`,
`getPayment`, and `listPayments`. `createPayment` **must honour
`idempotencyKey`**: the same key and request again returns the original
payment, the same key with a different request throws `IdempotencyError`, for
at least the executor's `ttlMs`. The executor re-sends a key after ambiguous
failures (a timeout can arrive after the charge), and only the provider can
deduplicate those.

A provider's `name` is any string (`readonly name = "adyen"` type-checks); the
known names are kept for autocomplete.

- **`MockProvider`** — fully in-memory implementation with a configurable
  `successRate`, simulated `latencyMs`, and per-idempotency-key status
  `overrides`. It honours idempotency keys as the contract below requires,
  the way Stripe does. Used by the test suite and the demo frontend.
- **`StripeProvider`** — wraps the official `stripe` SDK behind the same
  interface. The SDK is loaded lazily, so PayKit installs and bundles without
  it: the CJS build uses its module's own `require` (so require hooks and test
  mocks apply), the ESM build a native dynamic `import()` (opaque to bundlers).
  `config.Stripe` injects the constructor instead, and `ready()` reports
  whether a client was built. Only a missing `stripe` package
  (or secret key) degrades to a warning plus `NOT_INITIALIZED`; any other load
  error surfaces. `scripts/test-dist.mjs` (`npm run test:dist`, run in CI)
  checks this against the built package from real CJS and ESM consumers.
  Without a `paymentMethodId` it creates an unconfirmed PaymentIntent for
  Stripe.js to confirm in the browser; with one it confirms server-side —
  `allow_redirects: "never"` when no `returnUrl` is given (Stripe requires a
  `return_url` to confirm otherwise), `off_session=true` for `offSession`
  charges of a saved method. `paymentIntentCreateParams` in
  `src/providers/stripe.ts` is the single mapping; the README tabulates it.

### 2. Idempotent payment executor (`src/payments/idempotent.ts`)

Wraps any provider and adds two guarantees:

1. **One call in flight per key; recorded results replayed.** Before calling
   the provider, `execute()` looks up the `idempotencyKey` in an
   `IdempotencyStore`. A hit returns the cached `PaymentIntent` (tagged
   `metadata._idempotency = "cache_hit"`) instead of re-charging; a miss must
   win the store's atomic `reserve` — which returns a token unique to that
   reservation, the only thing that can `release` it — before it calls the
   provider. Results in
   which money may have moved (`succeeded`, `pending`, `processing`) are kept
   for `ttlMs`, `failed`/`cancelled` for `failedTtlMs`. Re-sends — retries
   after a timeout, a key released by a hard failure, an expired record — rely
   on the provider honouring the key (the contract above); together that is
   at-most-once charging per key while the key is remembered (the store's
   `ttlMs`, 24 h by default; Stripe at least 24 h) — beyond that, durable order
   state must guard retries.
2. **Retry with exponential backoff.** Provider errors marked `retryable` (or
   whose `code` is in `retryableErrors`) are retried up to `maxAttempts`, with
   the delay growing by `backoffFactor` up to `maxDelayMs`.

Storage is abstracted by `IdempotencyStore` (`get`/`set`/`delete`/`has` plus
the atomic `reserve`/`release`). A record is `{ intent, fingerprint }`: the
fingerprint is the canonical form of every request field, stored with the
result, so any executor sharing the store rejects a conflicting reuse of a key
with `IdempotencyError`, and the check lives exactly as long as the result.
Records are stored under `idempotencyStoreKey(provider.name, scope, key)`, so one
store can serve several providers, and with a `scope` several accounts of one
provider (test and live, two merchants), without any of them seeing another's
result; the provider itself still receives the bare key. The
default `InMemoryIdempotencyStore` keeps entries with a TTL (24h default);
production deployments implement the interface against Redis.

### 3. Webhook engine (`src/webhooks/handler.ts`)

Ingests raw webhook payloads and dispatches them to registered handlers.

- **Signature verification (fail closed).** `_verifySignature` validates
  Stripe's `t=...,v1=...` HMAC-SHA256 format (any matching `v1`, parsed by the
  shared `src/webhooks/signature.ts`) and, for other providers, a generic
  `sha256=` HMAC format with no signed timestamp (so no replay window, and not
  Plaid's or Wise's own scheme),
  requiring exactly 64 lowercase hex characters and comparing with
  `crypto.timingSafeEqual` to avoid timing attacks. A bad
  signature, a missing signature when a secret is configured, or a missing
  secret raises `WebhookSignatureError` (with a `reason`) before any handler
  runs; only `new WebhookEngine({ allowUnsigned: true })` processes events
  without a secret.
- **Deduplicated processing.** Each event — keyed by provider and `id`
  (`webhookDedupKey`; ids are unique only per provider) — is reserved in an in-flight set
  synchronously (no `await` between check and reserve) before any handler
  runs, then remembered in a bounded processed-id FIFO. A concurrent delivery
  of the same id returns `processed: false, error: "in_flight"`; a later one
  returns `error: "duplicate_event"`. Both hold per process only. An event
  with no id (non-Stripe: no `id` or `eventId`) is rejected as
  `INVALID_PAYLOAD` by the shared `webhookEventId` rule — never given an
  invented one, which would make every redelivery look new.
- **Handler dispatch.** Register handlers with `on(type, handler)` by exact event
  type, an array of types, or `"*"` (wildcard). Stripe types are mapped to
  PayKit names by `normalizeStripeEventType` (`src/webhooks/events.ts`, shared
  with the browser engine) — `payment_intent.succeeded` → `payment.succeeded`
  — with the original kept in `event.providerType`; handlers under either name
  and `*` run, each at most once. Handlers run with retry/backoff.
- **Dead-letter tracking, no false acks.** When all retries for a handler
  fail, the event is recorded (`getDeadLetters()`; an in-memory FIFO of the
  most recent `maxDeadLetters`, default 1,000), `process()` returns
  `processed: false, error: "handler_failed"`, and the id is not remembered,
  so a provider redelivery dispatches again (at-least-once; handlers must be
  idempotent).
- **Test helper.** `computeSignature()` produces a valid Stripe-style signature
  for constructing test webhooks.

### 4. Reconciliation engine (`src/reconciliation/engine.ts`)

Compares internal database records (`InternalRecord[]`) against provider
settlement records (`ProviderRecord[]`) and returns a `ReconciliationReport`.

Matching runs in three phases:

0. **Validation.** Records whose amount is not a safe integer, whose
   currency is not three letters, whose id/status/`createdAt` is missing, or
   whose `amountRefunded` is unusable or contradicts their own status are
   reported `invalid` and take no part in matching.
1. **Exact match** by `providerPaymentId`. Each provider record can be claimed
   once — a second claimant is `duplicate` — and an id the provider does not
   have is `unmatched_internal`, never re-matched elsewhere.
2. **Fuzzy match** by amount + date proximity (±1-day window with
   `fuzzyDate`, identical timestamps without), only for internal records that
   carry no `providerPaymentId`. Amounts must be equal unless an opt-in
   `toleranceAmount` (default `0`, minor units) is set — in every comparison,
   not just this one. Pairing is one optimal assignment over all eligible
   pairs — the most pairs, then the smallest total time distance — solved
   exactly per connected component (Hungarian algorithm), from a canonical
   ordering so the result never depends on input order.
3. **Remainder** is classified `unmatched_internal` or `unmatched_provider`.

Every pair is compared on currency (case-insensitive ISO code), amount, status
outcome, refunded total and `reference`, yielding `currency_mismatch`,
`amount_mismatch`, `status_mismatch`, `refund_mismatch`, `refund_unverified` or
`reference_mismatch`. Status outcomes (succeeded / refunded / partially refunded /
failed / money in flight or on hold / nothing taken yet) span the PayKit and
Stripe payment vocabularies. A refund is an outcome of its own, since a Stripe
PaymentIntent stays `succeeded` after one and so cannot confirm it: a row's
`amountRefunded` does, and a partially refunded pair that does not state it on
both sides is `refund_unverified`. With
`providerRecordType: "balance_transaction"` a provider
`pending`/`available` — fund availability — counts as succeeded. It also flags
likely **duplicates**: a second claimant of one provider charge, and — only
among records with no `providerPaymentId` — same amount + currency + UTC day
in the internal set (UTC, so the verdict is time-zone independent; a record
identified by its own charge is never flagged). **Possible double charges** are
charges sharing a `reference` (the provider row's own, else its claimant's)
that may hold money, which includes a debit in flight and a live hold; each one
after the earliest is flagged.

`report.outcome` is the verdict for code: `perfect`, `review_required`,
`nothing_to_reconcile` (both sides empty) or, as error states,
`internal_records_empty` / `provider_records_empty`. The `summary` reads "Perfect
reconciliation" only for `perfect`, and the README lists exactly what that did and
did not compare.

### 5. Fraud detector (`src/fraud/detector.ts`)

A weighted rule engine. Each rule is a `FraudRule` — a pure function from
`FraudContext` to a `FraudSignal` (`{ name, triggered, weight, reason }`).

- Ships with seven built-in rules (high amount on new account, new payment
  method + large amount, velocity, round-number amounts, missing user agent,
  very high amount, anonymous transaction). "Velocity" is the caller-supplied
  `previousPaymentCount` over the caller's own window — PayKit counts nothing
  itself — and no built-in rule reads `ipAddress`, `deviceFingerprint` or a
  location. `getRules()` lists the rules by signal name.
- `addRule()` refuses a rule whose weight (evaluated once on a minimal
  context) is not finite, is negative or exceeds 100; at `check()` time a
  triggered signal with such a weight fails closed (100 / critical / decline).
- `check()` also fails closed on input it cannot score: a bad amount or
  currency, or a present `accountAgeDays` / `previousPaymentCount` that is not
  a usable number. Comparisons with `NaN` are false, so a `NaN` age would
  otherwise read as no risk. An absent field just leaves its rule silent.
- Two hard ceilings sit outside the rules: above `reviewAmountCeiling` (default
  10,000,000 minor units) or `reviewVelocityCeiling` (default 50 payments in the
  caller's window) the recommendation is at least `review`, whatever the score.
  Score and level are not touched.
- `addRule()` appends custom rules; `clearBuiltInRules()` removes only the
  defaults — custom rules stay, whether added before or after it.
- `check()` sums the weights of triggered signals (capped at 100), maps the score
  to a `riskLevel` (low/medium/high/critical) and a `recommendation`
  (approve/review/decline). `checkBatch()` evaluates many contexts at once.

### 6. Type system & errors (`src/types/index.ts`)

A single module defines all shared types — `Money`, `PaymentIntent`,
`WebhookEvent`, the reconciliation and fraud types, and the
`PaymentProvider_Interface`. Errors form a hierarchy rooted at `PayKitError`
(carrying `code`, `provider`, and a `retryable` flag), with
`IdempotencyError`, `PaymentResultNotStoredError`, `WebhookSignatureError`, and
`ProviderError` subclasses.

## Typical data flow (charge → webhook → reconcile)

```
1. Client calls IdempotentPaymentExecutor.execute(request)
        │  cache miss → provider.createPayment() (retried on transient errors)
        ▼
2. Provider (Stripe) processes the charge and later emits a webhook
        │
        ▼
3. WebhookEngine.process({ rawBody, signature, secret, provider })
        │  verify HMAC → dedupe by (provider, event id) → dispatch handlers (with retry)
        ▼
4. Your handler updates the internal DB / fulfills the order
        │
        ▼ (nightly batch)
5. ReconciliationEngine.reconcile(internalRecords, providerRecords)
        │  matched / unmatched / amount_mismatch / duplicate
        ▼
6. FraudDetector.check(context) can gate steps 1–4 with an approve/review/decline
```

## Demo frontend (`frontend/`)

A Next.js 15 app (dev port `3005`) that exposes an interactive playground for
payments, webhooks, and fraud scoring; reconciliation has no tab. It is **not** a
re-implementation and it is **not** independent of the package:
`frontend/package.json` declares `"paykit": "file:.."`, so `lib/sdk.ts` re-exports
`MockProvider`, `IdempotentPaymentExecutor`, `InMemoryIdempotencyStore` and
`FraudDetector` straight from the compiled `dist/` — the playground runs the
literal shipped code. The payments tab wraps `MockProvider` only to count its
`createPayment` calls, and reports the executor's own `metadata._idempotency`.

The one exception is the webhook engine. `WebhookEngine` (above) uses Node's
`crypto.createHmac` / `crypto.timingSafeEqual`, which do not exist in a browser.
Rather than ship a Node polyfill into the client bundle, `lib/sdk.ts` provides
`BrowserWebhookEngine`, which is not the shipped code: it reimplements dispatch and
deduplication around the package's shared helpers, with the same public surface
(`on` / `off` / `process` / `computeSignature` / `verifyStripeSignature`), the
same `t=<ts>,v1=<hex>` signature scheme over `${ts}.${rawBody}`, the same
dedup-by-event-id and handler selection, and the same shared
`checkTimestampFreshness` replay-window check — computing the HMAC with Web
Crypto (`subtle.sign`) instead of Node `crypto`.

What they share is pinned by the SDK's own parity suite:
`tests/browser_webhook_parity.test.ts` imports the real `BrowserWebhookEngine`
(jest maps its `paykit` import to `src/`) and runs one verdict table — valid,
unsigned, no secret, tampered, stale — against both engines, and a signature
produced in either verifies in the other.

It is deliberately less than the Node engine, because it only serves the
playground. Do not treat a result there as proof of these three:

- **No retries or timeout.** Each handler runs once, with no `maxRetries`,
  backoff, `handlerTimeoutMs` or `signal`. A failure is dead-lettered at once.
- **One signature scheme.** It applies the Stripe scheme to every `provider`.
  The Node engine verifies other providers with a generic `sha256=<hex>` HMAC
  of the raw body.
- **No memory bounds.** There is no `maxProcessedIds` or `maxDeadLetters`.

The playground runs entirely in-memory with no real credentials. This mirrors
the architecture diagram in the [README](../README.md#web-demo--frontend).

See [usage.md](usage.md) for concrete, copy-paste API examples.
