/**
 * Canonical request fingerprint for idempotency-key conflict detection.
 *
 * Shared by the two places that must agree on what "the same request" means:
 * `IdempotentPaymentExecutor` (PayKit's own check, stored next to each cached
 * result) and `MockProvider` (which honours the provider idempotency contract
 * the way Stripe does). One definition, so they cannot drift apart.
 */

import { CreatePaymentRequest } from "../types/index";

/**
 * Canonical fingerprint of EVERY request field except the key itself, so any
 * change under the same idempotency key — amount, currency, description,
 * metadata, customer, payment method, return URL, off-session flag, capture
 * method — is a
 * conflict, matching how Stripe treats a reused key. It is the canonical JSON
 * itself, not a hash of it: exact comparison, no collisions, and debuggable
 * in a store. Normalised so equivalent requests agree: currency
 * case-insensitive, absent and `undefined` optional fields equal, metadata
 * keys order-independent, empty metadata (`{}`) equal to absent — Stripe
 * receives the identical request either way (stripe-node encodes `{}` as
 * nothing, and `StripeProvider` sends `metadata ?? {}`) — and
 * `offSession: false` equal to absent. `offSession`
 * appears only when true, so fingerprints of requests without it are
 * unchanged from before the field existed — records already in a store still
 * replay. `captureMethod` is the same: present only when set, and `"automatic"`
 * is not the same as absent, because absent leaves it to Stripe's default.
 */
export function fingerprintRequest(request: CreatePaymentRequest): string {
  const metadata =
    request.metadata && Object.keys(request.metadata).length > 0
      ? Object.keys(request.metadata)
          .sort()
          .map((k) => [k, request.metadata![k]])
      : null;
  return JSON.stringify({
    amount: request.amount.amount,
    currency: request.amount.currency.toUpperCase(),
    description: request.description ?? null,
    metadata,
    customerId: request.customerId ?? null,
    paymentMethodId: request.paymentMethodId ?? null,
    returnUrl: request.returnUrl ?? null,
    ...(request.offSession === true ? { offSession: true } : {}),
    ...(request.captureMethod ? { captureMethod: request.captureMethod } : {}),
  });
}
