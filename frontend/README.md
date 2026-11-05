# PayKit Playground

Interactive SDK playground — test idempotent payments, webhook signature verification, and fraud detection entirely in the browser.

From the repo root:

```bash
npm install      # the SDK first: its toolchain, and the dist/ the playground imports
cd frontend
npm install      # links the local `paykit` package
npm run dev
```

Open http://localhost:3005

The order matters. The playground depends on the SDK as `file:..`, and npm runs
the SDK's `prepare` script (`npm run build`) through that link, so
`npm install` here without the root install fails with
`sh: tsup: command not found`.

## Features

### Payments Tab
- Live charge form with configurable amount, idempotency key, description
- Trigger same key twice → a cache HIT, read from the result's own
  `metadata._idempotency`, and the provider-call count does not move
- Drop the idempotency cache and charge again → a MISS: the provider is called,
  and replays the same payment because it honours the key too
- Recent payment log with status, cache result and provider calls per charge
- Reset clears the provider and every cached key, not just the one in the form

### Webhooks Tab
- Simulate webhook events with real Stripe event types — the handler is
  registered under PayKit's name (`payment_intent.succeeded` → `payment.succeeded`)
- HMAC-SHA256 signing via Web Crypto API (no backend)
- "Tamper body" checkbox to test signature failure
- Untick "Sign" to send an unsigned delivery: the receiver still holds its
  secret, so it is rejected (`missing_signature`) — verification fails closed
- Event deduplication by ID
- Handler execution log

### Fraud Tab
- Live risk scoring with 7 built-in rules
- Color-coded risk score (0-100)
- Per-rule breakdown showing which rules triggered
- Approve / Review / Decline recommendation

Reconciliation has no tab: run it from the README's section or `npm run example`.

By default all of it runs client-side. The payments and fraud tabs run the PayKit
SDK's own classes, with payments going to its `MockProvider`, so nothing is charged.
The webhooks tab runs `BrowserWebhookEngine`, a Web Crypto reimplementation built on
the SDK's shared helpers and held to the Node engine by a parity test
(`tests/browser_webhook_parity.test.ts`).
