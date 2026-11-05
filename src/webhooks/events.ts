/**
 * Shared, browser-safe webhook event helpers: Stripe event type → PayKit
 * canonical event type, the event-id rule, and the (provider, event id) key
 * deduplication uses.
 *
 * Stripe names events after its own objects (`payment_intent.succeeded`,
 * `charge.dispute.created`); PayKit handlers register provider-neutral names
 * (`payment.succeeded`, `dispute.created`). The webhook engines set
 * `event.type` to the canonical name, keep Stripe's original in
 * `event.providerType`, and dispatch to handlers registered under EITHER name
 * (plus `*`), each handler at most once per event.
 *
 * Deliberately dependency-free and browser-safe: the Node `WebhookEngine` and
 * the playground's `BrowserWebhookEngine` both call these, so the mapping and
 * the id rule cannot drift between the two.
 */

import type { CustomWebhookEventType } from "../types/index";

/** The 1:1 mappings. Types not listed pass through under their Stripe name. */
const STRIPE_TO_PAYKIT: Readonly<Record<string, string>> = {
  "payment_intent.succeeded": "payment.succeeded",
  "payment_intent.payment_failed": "payment.failed",
  "payment_intent.processing": "payment.processing",
  "payment_intent.canceled": "payment.cancelled",
  "charge.dispute.created": "dispute.created",
  "charge.dispute.updated": "dispute.updated",
};

/**
 * Canonical PayKit type for a Stripe event. `charge.dispute.closed` becomes
 * `dispute.won` / `dispute.lost` according to the dispute's final `status`
 * (any other closing status, e.g. `warning_closed`, keeps the Stripe name).
 * Every other unmapped type — `refund.created`, `charge.refunded`, … — is
 * returned unchanged.
 */
export function normalizeStripeEventType(type: string, data: Record<string, unknown>): string {
  if (type === "charge.dispute.closed") {
    const object = data.object as { status?: unknown } | undefined;
    if (object?.status === "won") return "dispute.won";
    if (object?.status === "lost") return "dispute.lost";
    return type;
  }
  // Own keys only: `constructor` or `__proto__` must not find Object.prototype's.
  return Object.prototype.hasOwnProperty.call(STRIPE_TO_PAYKIT, type) ? STRIPE_TO_PAYKIT[type] : type;
}

/**
 * Register a handler for an event name outside `KnownWebhookEventType`:
 * `engine.on(customEvent("invoice.paid"), handler)`. It only tells the compiler
 * you checked the spelling, and returns the name unchanged. A name computed at
 * runtime goes through here too.
 */
export function customEvent(name: string): CustomWebhookEventType {
  return name as CustomWebhookEventType;
}

/**
 * The id a webhook event is deduplicated by: `id` — Stripe's `evt_…`, and most
 * senders' — or, for non-Stripe providers only, `eventId`. A non-empty string
 * is used as is; a finite number becomes its decimal string.
 *
 * Returns `null` when the payload carries no usable id, and both engines then
 * REJECT the event instead of inventing one. An invented id (the engines once
 * used `evt_${Date.now()}`) is unique per delivery, so every redelivery of the
 * same event would look new and run its handlers again — deduplication
 * silently off. Shared by the Node and browser engines so the rule cannot
 * drift between them.
 */
export function webhookEventId(payload: Record<string, unknown>, provider: string): string | null {
  const candidates = provider === "stripe" ? [payload.id] : [payload.id, payload.eventId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

/**
 * The key both engines deduplicate (and reserve in-flight) deliveries by:
 * the provider AND the event id. Event ids are unique only within one
 * provider — Stripe's `evt_1` and another sender's `evt_1` are different
 * events — so keying on the id alone let one provider's event swallow
 * another's as a `duplicate_event`, acknowledged without running a handler.
 * JSON-encoded so no (provider, id) pair can collide with another.
 */
export function webhookDedupKey(provider: string, eventId: string): string {
  return JSON.stringify([provider, eventId]);
}
