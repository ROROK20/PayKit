# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The playground's form fields fit what they hold.** The event-type select is as wide as its widest option at every width (it cut `payment_intent.payment_failed` short from 1180px, and with a mouse at 768px), and in Safari as tall as the other fields (it was 21px). The Description field's default no longer scrolls inside it at 1180px (by 43px on a touch screen).

## [0.1.0] — first public release

2026-11-04. A source release: install from this repository. The package is not on npm.

### What ships

- **`IdempotentPaymentExecutor`**: one provider call in flight per key, recorded results replayed, conflicting reuse rejected, retries with backoff that re-send the key. Takes a pluggable `IdempotencyStore`; `InMemoryIdempotencyStore` is included.
- **`WebhookEngine`**: HMAC-SHA256 verification that fails closed, a replay window on Stripe signatures, in-memory deduplication, retries, handler timeouts and dead letters.
- **`ReconciliationEngine`**: matches your records against a provider's and reports amount, status, refund, reference and duplicate disagreements. Fuzzy matching is an exact best assignment, independent of input order.
- **`FraudDetector`**: seven built-in rules, custom rules, and review ceilings on amount and velocity.
- **`StripeProvider`** and **`MockProvider`** behind `PaymentProvider_Interface`.
- **A Next.js playground** that runs the SDK in the browser against the mock provider: `docker compose up --build`, or `make demo-local`.
- No required runtime dependencies. `stripe` is an optional peer dependency. CJS, ESM and type declarations are built by `npm run build`.

### Behaviours to know

- **At-most-once is per key, within a window.** PayKit's store remembers a result for `ttlMs` (24 h by default) and Stripe keeps a key for at least 24 h. Once both have forgotten it, the same key can create a new charge, so anything retried later needs your own durable state.
- **A failed attempt is not always a failed payment.** A provider error with `outcomeUnknown: true` means a payment may exist. Re-send the same key for `timeout`, `network_error` and `idempotency_key_in_use`. After a Stripe `server_error` or an `unknown` error, reconcile before using any new key.
- **`PaymentResultNotStoredError` is not a failed payment.** The provider answered and only the store write failed, so the money may have moved.
- **Webhook delivery is at-least-once.** A failed event is never acknowledged, so handlers that succeeded run again on redelivery. Write handlers to be idempotent.
- **Unsigned webhooks need `allowUnsigned: true`.** A missing secret or signature otherwise throws `WebhookSignatureError` before any handler runs.
- **Only `report.outcome === "perfect"` is an all-clear.** Empty input, invalid records and any disagreement read as something else.
- **Invalid settings throw `INVALID_CONFIG` at construction**, such as a `NaN` from an unset environment variable.

### Known limits

- **Not run against live Stripe.** The adapter is tested against the real stripe-node through a scripted HTTP transport, with no network. stripe-node's account of a 500 replaying under the same key comes from its source, and has not been observed.
- **Webhook deduplication is per process.** It is in memory with no pluggable store. Across instances or restarts, make handlers idempotent against your own database.
- **No production store ships.** Redis appears as a documented example, not a built-in.
- **Two accounts on one store need a `scope`.** PayKit cannot detect a missing one.
- **Non-Stripe webhooks use a generic HMAC with no replay window.** Plaid and Wise signature schemes and adapters are not implemented.
- **`perfect` does not cover** fees, net amounts, payouts, disputes, a payment missing from both exports, or a refund no record states. A lost dispute still reads `perfect`.
- **Fraud scoring is a small rule engine, not a model.** Its amount thresholds are minor units with no FX conversion, set for 2-decimal currencies, and it does not read IP or device signals.
- **`BrowserWebhookEngine` is a reimplementation for the playground**, parity-tested against the real engine, with no retries, timeout or memory bounds.
- **No third-party security audit has been done.** See [SECURITY.md](SECURITY.md).
