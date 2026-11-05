/**
 * PayKit — Next.js App Router integration example.
 *
 * Shows how to wire PayKit into Next.js API routes for:
 * - Payment checkout
 * - Webhook ingestion
 * - Refunds
 *
 * This is a reference — copy into your Next.js project as needed, AND wire
 * your own authentication and authorization: `getSession()` below is a stub
 * that refuses every caller unless `PAYKIT_EXAMPLE_DEMO_AUTH=1` (set only by
 * this repo's tests). PayKit itself never knows who is calling; deciding who
 * may pay for an order or refund one is the integrator's job.
 */

import {
  StripeProvider,
  IdempotentPaymentExecutor,
  WebhookEngine,
  FraudDetector,
  PayKitError,
  ProviderError,
  PaymentResultNotStoredError,
  WebhookSignatureError,
  FraudContext,
} from "../src/index";

// ── Singletons (initialize once, reuse across requests) ─────────────────────

const stripeProvider = new StripeProvider({
  secretKey: process.env["STRIPE_SECRET_KEY"],
});

const executor = new IdempotentPaymentExecutor(stripeProvider, {
  // Default retryableErrors: rate limits, timeouts, network and server errors,
  // plus anything the provider flags retryable — all re-sent under the same
  // idempotency key. Pass a list only to narrow that set (it is then exact).
  retry: { maxAttempts: 3, initialDelayMs: 200, maxDelayMs: 2000, backoffFactor: 2 },
});

const fraudDetector = new FraudDetector();

const webhookEngine = new WebhookEngine();

// Register webhook handlers once at startup
webhookEngine.on("payment.succeeded", async (_event, data: any) => {
  const paymentId = data?.object?.id;
  console.log(`[Webhook] Payment succeeded: ${paymentId}`);
  // await fulfillOrder(paymentId);
  // await sendConfirmationEmail(paymentId);
});

webhookEngine.on("payment.failed", async (_event, data: any) => {
  const paymentId = data?.object?.id;
  console.log(`[Webhook] Payment failed: ${paymentId}`);
  // await notifyCustomer(paymentId, 'payment_failed');
});

webhookEngine.on("refund.created", async (_event, data: any) => {
  console.log(`[Webhook] Refund created: ${data?.object?.id}`);
  // await updateOrderStatus(data.object.payment_intent, 'refunded');
});

// ── Authentication and authorization: YOUR job ──────────────────────────────
//
// PayKit does not know who is calling. Every route below must first establish
// the caller (your session/auth system) and then check that the caller may
// touch the resource: their own order, a refund only by an authorised role.
// The two stubs here exist so the example runs; they FAIL CLOSED until you
// replace them — copied into a project unchanged, they refuse every request.

/** The authenticated caller, as YOUR auth system knows them. */
export interface SessionUser {
  userId: string;
  /** The Stripe Customer this user pays as. */
  customerId: string;
  role: "customer" | "support";
}

/**
 * STUB — replace with your authentication (NextAuth `getServerSession`,
 * Clerk `auth()`, a verified session cookie, …). As shipped it recognises two
 * demo tokens ONLY when `PAYKIT_EXAMPLE_DEMO_AUTH=1` (this repo's tests set
 * it); otherwise every caller is unauthenticated, so an unwired copy of this
 * file serves nobody rather than everybody.
 */
export async function getSession(sessionToken: string | null | undefined): Promise<SessionUser | null> {
  if (process.env["PAYKIT_EXAMPLE_DEMO_AUTH"] !== "1" || !sessionToken) return null;
  const demo: Record<string, SessionUser> = {
    demo_session_customer_1: { userId: "user_1", customerId: "cus_1", role: "customer" },
    demo_session_customer_5: { userId: "user_5", customerId: "cus_5", role: "customer" },
    demo_session_customer_7: { userId: "user_7", customerId: "cus_7", role: "customer" },
    demo_session_customer_9: { userId: "user_9", customerId: "cus_9", role: "customer" },
    demo_session_support: { userId: "agent_7", customerId: "cus_staff", role: "support" },
  };
  return demo[sessionToken] ?? null;
}

// ── Orders, risk profiles and refund tickets: YOUR database (stubs) ─────────
//
// The example's own records decide what may happen — never the provider's
// idempotency memory alone. Stripe forgets an idempotency key after about
// 24 hours; an order marked paid, or a refund ticket marked done, does not.

/** What the server knows about an order. The browser never supplies these. */
export interface Order {
  orderId: string;
  amountCents: number;
  currency: string;
  customerId: string;
  /** open → (review) → paid. Set by YOUR checkout and webhook handlers. */
  status: "open" | "held_for_review" | "paid";
  /** Set when checkout created the PaymentIntent, so a later checkout reuses it. */
  paymentIntentId?: string;
}

/**
 * STUB — replace with your database. The price and the customer come from
 * HERE, never from the request body: a browser that can post `amount` can set
 * its own price. (A Map so the example can persist what checkout learns.)
 */
const ORDERS = new Map<string, Order>([
  ["ord_1", { orderId: "ord_1", amountCents: 4999, currency: "USD", customerId: "cus_1", status: "open" }],
  ["ord_2", { orderId: "ord_2", amountCents: 12_000, currency: "USD", customerId: "cus_2", status: "open" }],
  ["ord_3", { orderId: "ord_3", amountCents: 4999, currency: "USD", customerId: "cus_1", status: "paid", paymentIntentId: "pi_paid_3" }],
  ["ord_5", { orderId: "ord_5", amountCents: 60_000, currency: "USD", customerId: "cus_5", status: "open" }],
  ["ord_7", { orderId: "ord_7", amountCents: 4999, currency: "USD", customerId: "cus_7", status: "open" }],
  ["ord_9", { orderId: "ord_9", amountCents: 150_000, currency: "USD", customerId: "cus_9", status: "open" }],
]);

export async function findOrder(orderId: string): Promise<Order | null> {
  return ORDERS.get(orderId) ?? null;
}

/** What your systems know about the customer, for the fraud check. */
export interface RiskProfile {
  accountAgeDays: number;
  /** Payments by this customer in YOUR velocity window (here: the last 24 h). */
  paymentsLast24h: number;
  /** Is the payment method on file new for this customer? */
  isNewPaymentMethod: boolean;
}

/** STUB — replace with real lookups (account table, payments table, saved methods). */
const RISK_PROFILES = new Map<string, RiskProfile>([
  ["cus_1", { accountAgeDays: 400, paymentsLast24h: 1, isNewPaymentMethod: false }],
  ["cus_2", { accountAgeDays: 90, paymentsLast24h: 0, isNewPaymentMethod: false }],
  ["cus_5", { accountAgeDays: 2, paymentsLast24h: 12, isNewPaymentMethod: false }], // scores "review"
  ["cus_7", { accountAgeDays: NaN, paymentsLast24h: 1, isNewPaymentMethod: false }], // an age computed from a missing date: declined
  ["cus_9", { accountAgeDays: 1, paymentsLast24h: 15, isNewPaymentMethod: true }], // scores "decline"
]);

export async function findRiskProfile(customerId: string): Promise<RiskProfile | null> {
  return RISK_PROFILES.get(customerId) ?? null;
}

/** A refund your support process approved — created server-side, not by the caller. */
export interface RefundTicket {
  ticketId: string;
  orderId: string;
  /** Minor units; omitted = the rest of the order. */
  amountCents?: number;
}

/** STUB — replace with your refunds table / ticketing system. */
const REFUND_TICKETS: ReadonlyMap<string, RefundTicket> = new Map([
  ["rt_100", { ticketId: "rt_100", orderId: "ord_3", amountCents: 1500 }],
  ["rt_101", { ticketId: "rt_101", orderId: "ord_3", amountCents: 9000 }], // more than the order: refused
  ["rt_102", { ticketId: "rt_102", orderId: "ord_1", amountCents: 100 }], // order not paid: refused
  ["rt_103", { ticketId: "rt_103", orderId: "ord_3", amountCents: 500 }],
  ["rt_104", { ticketId: "rt_104", orderId: "ord_3", amountCents: 300 }],
]);

export async function findRefundTicket(ticketId: string): Promise<RefundTicket | null> {
  return REFUND_TICKETS.get(ticketId) ?? null;
}

/**
 * STUB — the latest refund attempt per ticket (your refunds table). Only a
 * `succeeded` refund closes a ticket; `pending` stays pending (money is
 * committed, so it counts against the cap, and asking again would not help);
 * a `failed` or `cancelled` one moved no money and the ticket may be retried
 * under a new attempt key.
 */
interface IssuedRefund {
  orderId: string;
  attempt: number;
  refundId: string;
  amountCents: number;
  status: "succeeded" | "pending" | "failed" | "cancelled";
}
const ISSUED_REFUNDS = new Map<string, IssuedRefund>();
/**
 * The detail goes to your logs, never into a response: a message can carry a
 * provider's request detail or an idempotency key, and the browser gets neither.
 */
function logFailure(route: string, err: unknown): void {
  const code = err instanceof PayKitError ? err.code : "unknown";
  console.error(`[${route}] ${code}: ${err instanceof Error ? err.message : String(err)}`);
}

function refundedSoFar(orderId: string): number {
  let total = 0;
  for (const r of ISSUED_REFUNDS.values()) {
    if (r.orderId === orderId && (r.status === "succeeded" || r.status === "pending")) total += r.amountCents;
  }
  return total;
}

// ── Route Handlers ───────────────────────────────────────────────────────────

/**
 * POST /api/payments/checkout
 *
 * Create a payment intent for the SIGNED-IN customer's own order, priced by
 * the SERVER. The client sends only the order id; the session token, user
 * agent and IP come from the request.
 *
 * Authorization: no session → 401; an order that does not exist or belongs to
 * another customer → the same 404, so order ids cannot be probed. Only then
 * is the `clientSecret` — which lets its holder confirm the payment — returned.
 *
 * Order state comes first: a paid order → 409 (never charged twice, however
 * long ago); an order with a PaymentIntent already → that one is retrieved
 * and its client secret returned (not a second PaymentIntent); fraud
 * "decline" → 402; fraud "review" → the order is held (202) and NOT charged
 * until a human approves it. Fraud signals come from your systems
 * (`findRiskProfile`), not from constants.
 *
 * Idempotent: safe to retry with the same orderId. Retrying means sending the
 * SAME request under the same key, so the request holds only values fixed by
 * the order (amount, currency, customer, order id) — nothing that varies per
 * attempt. The fraud score changes with the user agent; in the metadata it
 * would make a legitimate retry a different request, which the executor
 * rejects with IdempotencyError.
 */
export async function checkoutHandler(
  sessionToken: string | null,
  orderId: string,
  userAgent: string,
  ipAddress: string,
): Promise<{ httpStatus: 200 | 202 | 401 | 402 | 404 | 409 | 500; clientSecret?: string; error?: string }> {
  const session = await getSession(sessionToken);
  if (!session) {
    return { httpStatus: 401, error: "Sign in to pay." };
  }
  const order = await findOrder(orderId);
  if (!order || order.customerId !== session.customerId) {
    return { httpStatus: 404, error: "Unknown order." };
  }

  // The order's own state decides first — not Stripe's idempotency memory,
  // which forgets a key after ~24h: a paid order is never charged again, an
  // order held for review is not charged at all, and an order that already
  // has a PaymentIntent gets THAT one back (retrieved, not re-created).
  if (order.status === "paid") {
    return { httpStatus: 409, error: "This order is already paid." };
  }
  if (order.status === "held_for_review") {
    return { httpStatus: 202, error: "This order is being reviewed; you will hear from us." };
  }
  if (order.paymentIntentId) {
    try {
      const existing = await stripeProvider.getPayment(order.paymentIntentId);
      if (existing.status === "succeeded") {
        order.status = "paid"; // the webhook would set this too
        return { httpStatus: 409, error: "This order is already paid." };
      }
      if (existing.status === "pending" || existing.status === "processing") {
        return { httpStatus: 200, clientSecret: existing.clientSecret };
      }
      return { httpStatus: 409, error: "This order's payment cannot continue. Please contact support." };
    } catch (err) {
      logFailure("Checkout", err);
      return { httpStatus: 500, error: "Payment lookup failed." };
    }
  }

  // Fraud check with REAL signals from your systems (stubbed above), per
  // attempt — which is why its result stays out of the payment request.
  const profile = await findRiskProfile(order.customerId);
  const fraudCtx: FraudContext = {
    amount: { amount: order.amountCents, currency: order.currency },
    customerId: order.customerId,
    userAgent,
    ipAddress,
    // No profile is itself a risk signal: score it as a brand-new account. `??`
    // fills in only what is missing, on purpose: a broken number (an age
    // computed from a missing date is NaN) goes to check() as it is, and
    // check() declines it. Never coerce one into something scoreable here.
    accountAgeDays: profile?.accountAgeDays ?? 0,
    previousPaymentCount: profile?.paymentsLast24h ?? 0,
    isNewPaymentMethod: profile?.isNewPaymentMethod ?? true,
  };
  const fraudResult = fraudDetector.check(fraudCtx);
  if (fraudResult.recommendation === "decline") {
    return { httpStatus: 402, error: "Transaction declined. Please contact support." };
  }
  if (fraudResult.recommendation === "review") {
    // Review means a human looks BEFORE money moves: hold the order, charge nothing.
    order.status = "held_for_review";
    // e.g. await queueForReview(orderId, fraudResult) — store the score there, not in the request.
    return { httpStatus: 202, error: "This order is being reviewed; you will hear from us." };
  }

  try {
    const intent = await executor.execute({
      amount: { amount: order.amountCents, currency: order.currency },
      idempotencyKey: `checkout_${orderId}`,
      description: `Order ${orderId}`,
      customerId: order.customerId,
      metadata: { orderId },
    });
    // Persist it on the order (your DB): the next checkout retrieves it, and
    // refunds and webhooks find the order by it.
    order.paymentIntentId = intent.id;

    // Stripe's client_secret — what Stripe.js needs to confirm the payment in
    // the browser. Never the PaymentIntent id, and never logged.
    return { httpStatus: 200, clientSecret: intent.clientSecret };
  } catch (err) {
    // Stripe has the PaymentIntent; only the idempotency store failed to record
    // it. Never report that as a failed payment. Keep it on the order, which is
    // what the next checkout looks at, and carry on. Alert on it, by id only:
    // the intent holds the client secret.
    if (err instanceof PaymentResultNotStoredError) {
      order.paymentIntentId = err.paymentIntentId;
      console.error(`[Checkout] Idempotency store failed after ${err.paymentIntentId} was created`);
      return { httpStatus: 200, clientSecret: err.intent.clientSecret };
    }
    logFailure("Checkout", err);
    // A decline is the one failure the customer can act on, and nothing moved.
    if (err instanceof ProviderError && err.code === "card_declined") {
      return { httpStatus: 402, error: "Your card was declined. Please try another payment method." };
    }
    // Nothing here says whether money moved, so do not promise it did not.
    return { httpStatus: 500, error: "We could not confirm your payment. Please contact support before trying again." };
  }
}

/**
 * POST /api/webhooks/stripe
 *
 * Ingests Stripe webhook events. Must be called with raw body
 * (before JSON parsing) for signature verification.
 */
export async function stripeWebhookHandler(
  rawBody: string,
  stripeSignature: string | null,
): Promise<{ httpStatus: 200 | 400 | 500 | 503; message?: string }> {
  try {
    const result = await webhookEngine.process({
      rawBody,
      signature: stripeSignature ?? undefined,
      // Unset in some environment? process() throws (fail closed); it never
      // quietly skips verification.
      secret: process.env["STRIPE_WEBHOOK_SECRET"],
      provider: "stripe",
    });

    // No handler matched. Stripe may just be sending a type you don't handle, so
    // it is acknowledged, but a handler under the wrong name looks the same.
    if (result.unhandled) console.warn(`[Webhook] No handler for ${result.eventType}`);
    if (result.processed || result.error === "duplicate_event") {
      return { httpStatus: 200 }; // done, or already done: Stripe stops retrying
    }
    // "handler_failed" (a handler exhausted its retries — the event is
    // dead-lettered and NOT remembered) or "in_flight" (another delivery of it
    // is still running). A non-2xx makes Stripe redeliver later instead of
    // marking it delivered, so fulfilment is retried rather than lost.
    return { httpStatus: 503, message: result.error };
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      if (err.reason === "missing_secret") {
        console.error("[Webhook] STRIPE_WEBHOOK_SECRET not set");
        return { httpStatus: 500, message: "Webhook secret not configured" };
      }
      console.error(`[Webhook] Signature verification failed: ${err.reason}`);
      return { httpStatus: 400, message: "Invalid signature" };
    }
    console.error("[Webhook] Processing error:", err);
    return { httpStatus: 500, message: "Webhook processing failed" };
  }
}

/**
 * POST /api/refunds/:ticketId
 *
 * Issue the refund an approved ticket describes. The caller supplies only the
 * ticket id; EVERYTHING else is server-side: the order, its own
 * PaymentIntent, the amount, and the idempotency key.
 *
 * Authorization: no session → 401; not the `support` role → 403; a ticket
 * that does not exist → 404 (a made-up ticket id refunds nothing).
 *
 * One refund per ticket, decided by YOUR records: a ticket already done
 * returns its recorded refund without calling Stripe (Stripe remembers a key
 * only ~24h). Otherwise the key is `refund_<orderId>_<ticketId>`, derived from
 * the server-side ticket, so a retry of an attempt that never recorded its
 * result gets the same refund back. Only a paid order can be refunded, and
 * the amount is capped at what is left after every issued refund.
 * (Letting the caller choose the key, the PaymentIntent or the amount would
 * let a fresh value per call refund again.) StripeProvider also checks the
 * currency against the payment.
 */
export async function refundHandler(
  sessionToken: string | null,
  ticketId: string,
): Promise<{ httpStatus: 200 | 401 | 403 | 404 | 409 | 500; refundId?: string; status?: string; error?: string }> {
  const session = await getSession(sessionToken);
  if (!session) return { httpStatus: 401, error: "Sign in." };
  if (session.role !== "support") return { httpStatus: 403, error: "Refunds need the support role." };

  const ticket = await findRefundTicket(ticketId);
  if (!ticket) return { httpStatus: 404, error: "Unknown refund ticket." };

  // A succeeded (done) or pending ticket is answered from YOUR records,
  // without calling Stripe: its idempotency key protects a repeat for ~24h
  // only. A failed/cancelled attempt moved no money: try again, new key.
  const previous = ISSUED_REFUNDS.get(ticket.ticketId);
  if (previous && (previous.status === "succeeded" || previous.status === "pending")) {
    return { httpStatus: 200, refundId: previous.refundId, status: previous.status };
  }
  const attempt = (previous?.attempt ?? 0) + 1;

  const order = await findOrder(ticket.orderId);
  if (!order || order.status !== "paid" || !order.paymentIntentId) {
    return { httpStatus: 409, error: "The order has no completed payment to refund." };
  }
  // What is left counts every issued refund — a done ticket is never credited back.
  const left = order.amountCents - refundedSoFar(order.orderId);
  const amountCents = ticket.amountCents ?? left;
  if (amountCents <= 0 || amountCents > left) {
    return { httpStatus: 409, error: `Refund of ${amountCents} exceeds the ${left} left on order ${order.orderId}.` };
  }

  try {
    // Same key on every attempt: if the process dies after Stripe refunded but
    // before the record below, the retry within Stripe's window gets the same
    // refund back. (In production, record the ticket as "pending" before this
    // call and reconcile pending tickets against Stripe's refunds for the
    // PaymentIntent before retrying one older than that window.)
    const refund = await stripeProvider.refundPayment({
      paymentId: order.paymentIntentId, // the ORDER's PaymentIntent, never a caller-supplied id
      amount: { amount: amountCents, currency: order.currency },
      reason: "requested_by_customer",
      // Attempt 1 keeps the plain key; a retry after a failed attempt needs a
      // NEW key — the old one would replay the failure.
      idempotencyKey: attempt === 1 ? `refund_${order.orderId}_${ticket.ticketId}` : `refund_${order.orderId}_${ticket.ticketId}_a${attempt}`,
    });
    ISSUED_REFUNDS.set(ticket.ticketId, {
      orderId: order.orderId,
      attempt,
      refundId: refund.refundId,
      amountCents,
      status: refund.status,
    });
    return { httpStatus: 200, refundId: refund.refundId, status: refund.status };
  } catch (err) {
    logFailure("Refund", err);
    return { httpStatus: 500, error: "Refund failed" };
  }
}

// ── Next.js App Router export format ─────────────────────────────────────────
// In actual Next.js files, you'd export like:
//
// export async function POST(req: Request) {
//   const { orderId } = await req.json(); // the ONLY thing taken from the body
//   const { httpStatus, ...body } = await checkoutHandler(
//     cookies().get("session")?.value ?? null, // whatever YOUR auth reads
//     orderId,
//     req.headers.get("user-agent") ?? "",
//     req.headers.get("x-forwarded-for") ?? "",
//   );
//   return Response.json(body, { status: httpStatus });
// }
//
// The webhook route must hand over the RAW body (req.text(), not req.json()):
//
// export async function POST(req: Request) {
//   const { httpStatus, message } = await stripeWebhookHandler(
//     await req.text(),
//     req.headers.get("stripe-signature"),
//   );
//   return Response.json({ message }, { status: httpStatus });
// }
