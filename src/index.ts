/**
 * PayKit — Open-source fintech infrastructure SDK
 *
 * @packageDocumentation
 */

// Types
export * from "./types/index";

// Providers
export { MockProvider } from "./providers/mock";
export { StripeProvider } from "./providers/stripe";

// Payments
export {
  IdempotentPaymentExecutor,
  InMemoryIdempotencyStore,
  assertValidMoney,
  assertIdempotencyKey,
  idempotencyStoreKey,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "./payments/idempotent";
export type {
  IdempotencyStore,
  IdempotencyRecord,
  RetryConfig,
  IdempotentPaymentExecutorConfig,
} from "./payments/idempotent";

// Webhooks
export { WebhookEngine } from "./webhooks/handler";
export type { WebhookEngineConfig, WebhookHandlerContext } from "./webhooks/handler";
export { checkTimestampFreshness, toleranceSecondsError, MAX_TOLERANCE_SECONDS } from "./webhooks/freshness";
export { customEvent, normalizeStripeEventType, webhookEventId, webhookDedupKey } from "./webhooks/events";
export { parseStripeSignatureHeader, isSha256HexDigest } from "./webhooks/signature";
export type { StripeSignatureHeader } from "./webhooks/signature";
export type { FreshnessResult } from "./webhooks/freshness";

// Reconciliation
export { ReconciliationEngine } from "./reconciliation/engine";
export type { ReconciliationConfig, ProviderRecordType } from "./reconciliation/engine";

// Fraud
export { FraudDetector, MAX_RULE_WEIGHT, DEFAULT_REVIEW_AMOUNT_CEILING, DEFAULT_REVIEW_VELOCITY_CEILING } from "./fraud/detector";
export type { FraudRule, FraudDetectorConfig } from "./fraud/detector";

export const VERSION = "0.1.0";
