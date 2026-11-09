# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

Please do not report vulnerabilities through public issues, pull requests or
discussions. Email **[rskv.khiani@gmail.com](mailto:rskv.khiani@gmail.com)**
with a description and its impact, steps to reproduce or a proof of concept, and
the affected version and configuration.

You can expect an acknowledgment within 48 hours and a triage within 7 days. A fix
is coordinated with you and prioritized by severity. Please allow time for a fix
before any public disclosure; reporters are credited unless they prefer otherwise.

In scope: the SDK in `src/`, webhook signature verification, idempotency and replay
protection, and the package as built by `npm run build`. The playground in
`frontend/` runs in memory with no real credentials, so report issues there as
normal bugs unless they enable a vulnerability in the SDK.

## Assurance

No third-party security audit has been done. CI runs the type check, lint, the jest
suite with coverage thresholds, the built-package test (`test:dist`), and the
frontend lint and build on every push to `main` or `develop` and every pull request
to `main`. The browser driver (`e2e/smoke.mjs`) is not in CI: it is run by hand,
because it needs a Chromium download and a free port 3005.

## Dependency audit

Measured 2026-11-04 with npm 10.9.2 and Node 23.9 on the committed lockfiles.
Advisory databases move faster than this code, so re-run these yourself.

| Command | What it covers | Critical | High | Moderate | Low |
|---|---|---|---|---|---|
| `npm audit --omit=dev` | what the SDK ships | 0 | 0 | 0 | 0 |
| `npm audit` | SDK with its dev toolchain | 0 | 0 | 6 | 8 |
| `cd frontend && npm audit --omit=dev` | playground runtime | 0 | 0 | 0 | 0 |
| `cd frontend && npm audit` | playground with its dev toolchain | 0 | 0 | 6 | 0 |

The SDK has no required runtime dependencies; `stripe` is an optional peer. The
root's 14 rows come from three advisories, because npm counts every package an
advisory reaches. The frontend's 6 are the same `minimatch` advisory.

| Advisory | Severity | Where | Fix npm offers (root) |
|---|---|---|---|
| `minimatch` 7.0.0–11.0.0, GHSA-g3hv-75wg-m249 (DoS via globparts amplification) | moderate | `@typescript-eslint` | a semver-major downgrade of `@typescript-eslint` |
| `deepmerge` 4.2.0–4.3.1, GHSA-gcqx-w48m-w2h4 (prototype poisoning in `mergeObject()`) | low | jest's config chain, ts-jest | semver-major downgrades of jest and ts-jest |
| `esbuild` 0.27.3–0.28.0, GHSA-g7r4-m6w7-qqqr (file read via the dev server on Windows) | low | inside tsup | non-breaking |

None of these is reachable from `dist/`: they concern glob patterns, config merging
and esbuild's dev server, all at build or test time. No fix has been applied. The real
remedy is a toolchain major upgrade (eslint 9 with typescript-eslint 8, a current jest
and ts-jest). In `frontend/`, npm offers a non-breaking `npm audit fix` for its 6 rows;
it changes the lockfile and has not been verified to clear them.

The frontend's override of Next's pinned `postcss` (`"overrides": {"next": {"postcss":
"$postcss"}}`) is deliberate: the version Next 15.x pins carries high-severity
advisories.

## Notes for deployers

- **Webhook verification fails closed.** A missing or empty signature or secret (say,
  an unset environment variable) throws `WebhookSignatureError` before any handler runs.
  `{ allowUnsigned: true }` is the only way to process unsigned events, and it never
  relaxes a secret you pass.
- **Signatures are compared in constant time and parsed strictly.** A digest must be
  exactly 64 lowercase hex characters. Every `v1=` in a Stripe header is checked, so an
  endpoint secret can be rolled.
- **Non-Stripe webhooks have no replay window.** The generic path verifies a plain
  `sha256=<hex>` HMAC of the raw body with no signed timestamp, so a captured request
  stays valid and only bounded in-memory deduplication stops a replay. Plaid's JWT and
  Wise's RSA schemes are not implemented and fail verification.
- **Webhook deduplication is per process.** Across instances or restarts, enforce
  exactly-once effects in your handlers against your own database.
- **Treat the idempotency store as a payment credential.** A cached Stripe intent
  includes its `clientSecret`. Two accounts of one provider sharing a store are told
  apart only by `scope`; without one, the second receives the first's result, and
  PayKit cannot detect that.
- **Keep client secrets out of logs.** A decline's `ProviderError` carries the
  PaymentIntent's id, not its secret. `PaymentResultNotStoredError.intent` holds the
  secret but is not an own property, so `JSON.stringify`, `util.inspect` and a spread
  do not reach it. Two exceptions: `util.inspect` with `showHidden` and `getters`
  together prints it, and `err.cause` is whatever your store threw.
- **A Stripe 500 can leave a payment's outcome unknown.** stripe-node's source says
  Stripe would typically replay a 500 under the same key, and a new key can charge twice.
  The error carries `outcomeUnknown: true`, and the README says how to reconcile first.
  This has not been observed against live Stripe.
- **Unusable keys and settings are refused.** A key must be non-empty printable ASCII of
  at most 255 characters without surrounding whitespace (`INVALID_IDEMPOTENCY_KEY`).
  Durations and `toleranceSeconds` that are `NaN`, infinite or out of range throw
  `INVALID_CONFIG`, so `Number(process.env.UNSET)` cannot disable a check.
- **Authentication and authorization are yours.** `examples/nextjs_integration.ts`
  shows where those checks go.
- **No secrets are committed.** `.env` is git-ignored; only `.env.example` placeholders
  are tracked.
