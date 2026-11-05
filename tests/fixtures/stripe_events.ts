/**
 * Stripe-shaped webhook payloads, modelled field-for-field on the Event
 * objects Stripe delivers (`object: "event"`, `api_version`, `data.object`,
 * `request`, `pending_webhooks`). They prove PayKit's handlers fire for the
 * event names Stripe really sends — not for names PayKit made up.
 */

export function stripeEvent(
  type: string,
  object: Record<string, unknown>,
  id = "evt_3QeXampleLkdIwHu7ix0J4mUqvC",
): Record<string, unknown> {
  return {
    id,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: { id: "req_8xWExampleQk2Ja", idempotency_key: "checkout_ord_001" },
    type,
  };
}

/** A `payment_intent.succeeded` event for a $49.99 charge. */
export function paymentIntentSucceeded(id?: string): Record<string, unknown> {
  return stripeEvent(
    "payment_intent.succeeded",
    {
      id: "pi_3QeXampleLkdIwHu7ix0s1Xn0bq",
      object: "payment_intent",
      amount: 4999,
      amount_received: 4999,
      currency: "usd",
      status: "succeeded",
      customer: "cus_QeXample42",
      latest_charge: "ch_3QeXampleLkdIwHu7ix0aBcDeF",
      metadata: { orderId: "ord_001" },
      livemode: false,
    },
    id,
  );
}

/** A `charge.dispute.closed` event whose dispute ended in `status`. */
export function disputeClosed(status: string, id?: string): Record<string, unknown> {
  return stripeEvent(
    "charge.dispute.closed",
    {
      id: "dp_1QeXampleLkdIwHu7ixWxYz",
      object: "dispute",
      amount: 4999,
      currency: "usd",
      charge: "ch_3QeXampleLkdIwHu7ix0aBcDeF",
      payment_intent: "pi_3QeXampleLkdIwHu7ix0s1Xn0bq",
      reason: "fraudulent",
      status,
    },
    id,
  );
}
