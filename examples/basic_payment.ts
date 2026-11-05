/**
 * PayKit — Basic payment flow example.
 *
 * Demonstrates: create, refund, list using MockProvider.
 * Replace MockProvider with StripeProvider for production — but note that
 * MockProvider settles every payment at once, while StripeProvider without a
 * paymentMethodId returns "pending" (Stripe's requires_payment_method) until
 * the customer confirms in the browser. See "What a Stripe payment returns"
 * in the README.
 */

import {
  MockProvider,
  IdempotentPaymentExecutor,
  FraudDetector,
  WebhookEngine,
  ReconciliationEngine,
  InternalRecord,
  ProviderRecord,
} from "../src/index";

export async function main(): Promise<void> {
  console.log("=== PayKit Demo ===\n");

  // ─── 1. Basic Payment ───────────────────────────────────────────────────────
  console.log("1. Creating payment...");
  const provider = new MockProvider({ successRate: 1.0 });
  const payment = await provider.createPayment({
    amount: { amount: 4999, currency: "USD" }, // $49.99
    idempotencyKey: "order_abc_001",
    description: "Premium subscription",
    metadata: { orderId: "ord_001", userId: "usr_42" },
  });
  console.log(`   ✓ Payment ${payment.id}: ${payment.status} — $${payment.amount.amount / 100}`);

  // ─── 2. Idempotent Executor ─────────────────────────────────────────────────
  console.log("\n2. Testing idempotency...");
  const executor = new IdempotentPaymentExecutor(provider);

  const p1 = await executor.execute({
    amount: { amount: 9999, currency: "USD" },
    idempotencyKey: "sub_monthly_usr42_jan",
  });
  const p2 = await executor.execute({
    amount: { amount: 9999, currency: "USD" },
    idempotencyKey: "sub_monthly_usr42_jan", // same key!
  });
  console.log(`   ✓ p1.id === p2.id: ${p1.id === p2.id} (no double charge)`);
  // The real flag — a fallback here would print "cache_hit" even if it were missing.
  console.log(`   ✓ Cache hit flag: ${p2.metadata?._idempotency}`);

  // ─── 3. Fraud Detection ─────────────────────────────────────────────────────
  console.log("\n3. Fraud detection...");
  const detector = new FraudDetector();

  const safeResult = detector.check({
    amount: { amount: 4999, currency: "USD" },
    customerId: "cus_123",
    userAgent: "Mozilla/5.0",
    accountAgeDays: 180,
    isNewPaymentMethod: false,
    previousPaymentCount: 5,
  });
  console.log(`   Safe payment: ${safeResult.recommendation} (score=${safeResult.riskScore})`);

  const riskyResult = detector.check({
    amount: { amount: 500_000, currency: "USD" }, // $5,000
    accountAgeDays: 1,
    isNewPaymentMethod: true,
    previousPaymentCount: 12,
  });
  console.log(`   Risky payment: ${riskyResult.recommendation} (score=${riskyResult.riskScore})`);
  if (riskyResult.reasons.length > 0) {
    console.log(`   Top reason: ${riskyResult.reasons[0]}`);
  }

  // ─── 4. Webhook Processing ──────────────────────────────────────────────────
  console.log("\n4. Webhook processing...");
  const engine = new WebhookEngine();

  const fulfilled: string[] = [];
  // Registered under PayKit's canonical name; Stripe sends
  // "payment_intent.succeeded", which the engine maps to it.
  engine.on("payment.succeeded", async (event, data: any) => {
    fulfilled.push(data.object?.id ?? "unknown");
  });

  // Shaped like the Event object Stripe actually delivers.
  const webhookPayload = JSON.stringify({
    id: "evt_001",
    object: "event",
    type: "payment_intent.succeeded",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: { id: "pi_xyz", object: "payment_intent", amount: 4999, currency: "usd", status: "succeeded" },
    },
  });

  // Demo-only secret. In production read it from the environment
  // (process.env.STRIPE_WEBHOOK_SECRET). Verification fails closed: an
  // unsigned or wrongly-signed delivery throws WebhookSignatureError here.
  const webhookSecret = "whsec_demo_only_do_not_commit_real_secrets";
  const result = await engine.process({
    rawBody: webhookPayload,
    signature: engine.computeSignature(webhookPayload, webhookSecret),
    secret: webhookSecret,
    provider: "stripe",
  });
  console.log(`   ✓ Webhook ${result.eventType} processed: ${result.handlersRun} handlers run`);
  console.log(`   ✓ Fulfilled order for payment: ${fulfilled[0]}`);

  // ─── 5. Reconciliation ──────────────────────────────────────────────────────
  console.log("\n5. Payment reconciliation...");
  const internal: InternalRecord[] = [
    { id: "i1", providerPaymentId: "pay_001", amount: { amount: 4999, currency: "USD" }, status: "succeeded", createdAt: new Date() },
    { id: "i2", providerPaymentId: "pay_002", amount: { amount: 9999, currency: "USD" }, status: "succeeded", createdAt: new Date() },
    { id: "i3", providerPaymentId: "pay_003", amount: { amount: 1999, currency: "USD" }, status: "succeeded", createdAt: new Date() },
  ];
  const providerRecords: ProviderRecord[] = [
    { id: "pay_001", amount: { amount: 4999, currency: "USD" }, status: "succeeded", createdAt: new Date() },
    { id: "pay_002", amount: { amount: 9999, currency: "USD" }, status: "succeeded", createdAt: new Date() },
    // pay_003 missing from provider (might not have settled yet)
    { id: "pay_phantom", amount: { amount: 2500, currency: "USD" }, status: "succeeded", createdAt: new Date() },
  ];

  const reconciler = new ReconciliationEngine({ provider: "stripe" });
  const report = reconciler.reconcile(internal, providerRecords);
  console.log(`   ✓ Matched: ${report.matched}/${report.totalInternal}`);
  console.log(`   ⚠ Unmatched internal: ${report.unmatchedInternal}`);
  console.log(`   ⚠ Unmatched provider: ${report.unmatchedProvider}`);
  console.log(`   Summary: ${report.summary}`);

  // ─── 6. Refund ──────────────────────────────────────────────────────────────
  console.log("\n6. Processing refund...");
  const refund = await provider.refundPayment({
    paymentId: payment.id,
    reason: "requested_by_customer",
    idempotencyKey: "refund_ticket_4711", // from YOUR refund request, so a retry refunds once
  });
  console.log(`   ✓ Refund ${refund.refundId}: ${refund.status}`);

  console.log("\n=== Demo complete ===");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
