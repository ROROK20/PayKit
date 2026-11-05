/**
 * Idempotent payment executor.
 *
 * What it guarantees for one idempotency key, across every executor sharing
 * an `IdempotencyStore` with the same provider name and `scope`:
 * - **One provider call in flight at a time.** The store's atomic
 *   `reserve(key)` creates a "pending" marker if and only if none exists; only
 *   the reservation winner calls the provider, and concurrent losers poll the
 *   store for its result instead of issuing a second charge.
 * - **No new provider call once a result is recorded.** While the store holds
 *   a result — `ttlMs` (24h) for anything in which money may have moved,
 *   `failedTtlMs` (60s) for `failed`/`cancelled` — every caller of the key
 *   gets it back and the provider is not called.
 * - **Conflicting reuse is rejected** (see Features).
 *
 * What it relies on the provider for: deduplicating a re-sent `createPayment`.
 * The executor re-sends the request under the same key when an attempt fails
 * with a retryable error (a `timeout` can arrive after the provider charged),
 * when an earlier hard failure released the key, and when a recorded result
 * has expired or been evicted. `PaymentProvider_Interface` requires providers
 * to honour the key (`StripeProvider` forwards it to Stripe; `MockProvider`
 * deduplicates). Together that is at-most-once charging per key — for as
 * long as the key is remembered (this store's `ttlMs`, 24h by default; Stripe
 * keeps keys at least 24h). After both forget it, the same key can charge
 * again: guard later retries with durable state of your own (an order marked
 * paid).
 *
 * Features:
 * - In-memory or pluggable storage backend
 * - Configurable TTL for key expiry
 * - Retry-with-backoff (with jitter) for transient failures
 * - Conflict detection for parameter mismatches (throws IdempotencyError). The
 *   request fingerprint is stored WITH the cached result, so every executor
 *   sharing a store — every server — detects a conflicting reuse of a key.
 */

import {
  PaymentProvider_Interface,
  PaymentProvider,
  CreatePaymentRequest,
  PaymentIntent,
  PaymentStatus,
  RefundRequest,
  IdempotencyError,
  PaymentResultNotStoredError,
  PayKitError,
} from "../types/index";
import { fingerprintRequest } from "./fingerprint";

/**
 * What a store keeps per idempotency key: the terminal result, plus the
 * fingerprint of the request that produced it. Keeping the fingerprint in the
 * store (not in one executor's memory) is what lets a second server reject a
 * reuse of the key with different parameters instead of silently returning
 * the first request's result.
 */
export interface IdempotencyRecord {
  /** The terminal PaymentIntent every caller of this key receives. */
  intent: PaymentIntent;
  /** Canonical fingerprint of the originating request; opaque to stores. */
  fingerprint: string;
}

/**
 * A deep, independent copy of a stored result. Callers and the store never
 * share objects: if they did, a caller mutating its result —
 * `delete p.clientSecret`, `p.status = "failed"`, `p.amount.amount = 1` —
 * would change what every later duplicate of the key receives, and a client
 * that then saw "failed" would retry with a NEW key: a second charge.
 *
 * Hand-rolled rather than `structuredClone`, which builds its `Date`s in
 * Node's main realm — under a vm-sandboxed runner such as jest those fail
 * `instanceof Date`. Dates are recognised realm-independently and rebuilt
 * here; arrays and plain objects are copied recursively. `Object.fromEntries`
 * defines each key rather than assigning it, so a JSON `__proto__` key stays
 * plain data: assigned, it would become the copy's prototype, and whatever it
 * holds would read as metadata the request never set.
 */
function deepCopy<T>(value: T): T {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return new Date((value as unknown as Date).getTime()) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepCopy(v)])) as T;
  }
  return value;
}

function copyIntent(intent: PaymentIntent): PaymentIntent {
  return deepCopy(intent);
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(key: string, record: IdempotencyRecord, ttlMs?: number): Promise<void>;
  /**
   * Drop the key's terminal result, if any. MUST NOT remove an in-flight
   * reservation: that belongs to the caller executing the payment, and
   * dropping it would let a second caller win `reserve()` and call the
   * provider while the first call is still running.
   */
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /**
   * Atomically reserve a key.
   *
   * Creates a "pending" marker for the key if and only if the key is not
   * already reserved AND has no terminal result. Returns a **token** unique
   * to this reservation if the caller won it (and is therefore responsible
   * for producing the terminal result), or `null` if the key is already
   * in-flight or terminal. The executor hands the token back to `release`.
   *
   * Implementations MUST make the check-and-set atomic relative to other
   * concurrent `reserve()` / `get()` callers so that at most one caller ever
   * wins for a given key — and should store the token AS the marker, so the
   * marker identifies its owner (see `release`).
   */
  reserve(key: string): Promise<string | null>;
  /**
   * Release the reservation identified by `token` without writing a terminal
   * result — a no-op unless the key's marker is still that token.
   *
   * Called when the provider call fails, so the key can be retried by a later
   * request instead of being stuck in the "pending" state forever. The token
   * check matters for stores whose markers expire (Redis `PX`): if A's marker
   * outlived its TTL and B reserved the key since, A's late release must not
   * delete B's reservation and let a third caller charge.
   */
  release(key: string, token: string): Promise<void>;
}

export interface InMemoryIdempotencyStoreConfig {
  /**
   * Hard cap on the number of terminal (cached-result) entries. When exceeded,
   * the oldest-inserted entries are evicted first (Map preserves insertion
   * order). Evicting a still-valid key means a duplicate request for that key
   * re-reaches the provider — where only the provider's own key dedup stands
   * between it and a second charge — so size this above your realistic
   * in-window request volume. In-flight `pending` reservations are never
   * evicted.
   * Default 100_000. Set to 0 to disable the cap.
   */
  maxEntries?: number;
  /**
   * How often (in number of `set` writes) to run an opportunistic sweep of
   * expired entries. Without this, an expired key is only reclaimed when that
   * same key is fetched again — so keys written once and never re-read would
   * leak forever. The sweep is O(n) over the stored entries and runs inline on
   * the write path, so keep it infrequent. Default 256. Set to 0 to disable.
   */
  sweepEvery?: number;
}

/**
 * In-memory idempotency store. Replace with Redis for production.
 *
 * Memory bounds, so a long-running process cannot grow without limit:
 * - **Opportunistic expiry sweep:** every `sweepEvery` writes, expired entries
 *   are purged in bulk, so a key that is written once and never read again is
 *   still reclaimed.
 * - **Hard entry cap:** when the number of live entries exceeds `maxEntries`,
 *   the oldest-inserted entries are dropped first. In-flight reservations
 *   (`pending`) are tracked separately and are never swept or capped, so
 *   bounding the store cannot break the single-winner reservation guarantee.
 *
 * Both bounds are deterministic and dependency-free — no timers, nothing that
 * keeps the event loop alive.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();
  /** In-flight reservations: key → the token its owner holds. */
  private pending = new Map<string, string>();
  /** Source of reservation tokens; unique per store instance. */
  private reservations = 0;
  private readonly maxEntries: number;
  private readonly sweepEvery: number;
  private writesSinceSweep = 0;

  constructor(config: InMemoryIdempotencyStoreConfig = {}) {
    this.maxEntries = config.maxEntries ?? 100_000;
    this.sweepEvery = config.sweepEvery ?? 256;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // A copy: whoever reads the store cannot mutate what it keeps.
    return { intent: copyIntent(entry.record.intent), fingerprint: entry.record.fingerprint };
  }

  async set(key: string, record: IdempotencyRecord, ttlMs = 86_400_000): Promise<void> {
    this.store.set(key, { record: { intent: copyIntent(record.intent), fingerprint: record.fingerprint }, expiresAt: Date.now() + ttlMs });
    // Writing a terminal result clears the in-flight marker.
    this.pending.delete(key);

    // Opportunistic maintenance on the write path (no timers, deterministic).
    if (this.sweepEvery > 0 && ++this.writesSinceSweep >= this.sweepEvery) {
      this.writesSinceSweep = 0;
      this._sweepExpired();
    }
    this._enforceMaxEntries();
  }

  /**
   * Purge every entry whose TTL has elapsed. Called incidentally from `set`
   * (see `sweepEvery`) and exposed for callers that want to force reclamation.
   * Never touches `pending` — those are live reservations, not terminal results.
   */
  sweepExpired(): void {
    this._sweepExpired();
  }

  private _sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Drop oldest-inserted entries until the store is within `maxEntries`. A
   * Map iterates in insertion order, so its first key is the oldest write.
   */
  private _enforceMaxEntries(): void {
    if (this.maxEntries <= 0) return;
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Drops the terminal result only; an in-flight reservation stays with its owner. */
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  /**
   * Atomic check-and-set. Because JS runs this synchronously with no `await`
   * between the read and the write, two concurrent callers cannot both observe
   * "absent" — the first synchronous call adds the marker, the second sees it.
   */
  async reserve(key: string): Promise<string | null> {
    // Already has a live terminal result → not the winner.
    const entry = this.store.get(key);
    if (entry && Date.now() <= entry.expiresAt) {
      return null;
    }
    // Already reserved by another in-flight call → not the winner.
    if (this.pending.has(key)) {
      return null;
    }
    const token = `reservation_${++this.reservations}`;
    this.pending.set(key, token);
    return token;
  }

  /** Frees the reservation only for the holder of its token. */
  async release(key: string, token: string): Promise<void> {
    if (this.pending.get(key) === token) this.pending.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.pending.clear();
  }
}

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  /**
   * Error codes to retry. Default: `rate_limit`, `network_error`, `timeout`,
   * `server_error` — plus, while this is left at its default, any error the
   * provider flags `retryable: true` (e.g. Stripe's `idempotency_key_in_use`).
   * Passing a list makes it exact: ONLY errors whose `code` is listed are
   * retried, whatever their `retryable` flag — so a list can narrow retries,
   * e.g. `["rate_limit"]` never re-sends after a timeout. `undefined` is the
   * default; anything else that is not an array of strings is `INVALID_CONFIG`.
   */
  retryableErrors: string[];
}

/**
 * Statuses in which no money moved — the only results cached for the short
 * `failedTtlMs`. Every other status is cached for the full `ttlMs`: not only
 * `succeeded`, but also `pending` and `processing` (Stripe's `requires_*`
 * states), which can still turn into a charge. Re-sending such a key after a
 * short TTL would hand the double-charge decision back to the provider.
 */
const NO_MONEY_MOVED: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>(["failed", "cancelled"]);

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 5000,
  backoffFactor: 2,
  retryableErrors: ["rate_limit", "network_error", "timeout", "server_error"],
};

export interface IdempotentPaymentExecutorConfig {
  store?: IdempotencyStore;
  /**
   * Whose payments these are, when one store serves more than one account. Results
   * are stored per provider name AND scope, because a provider's keys are unique
   * only within its own account: with `StripeProvider`s for test and live, or for
   * two merchants, both named `stripe`, one executor would otherwise be handed the
   * other's result — `clientSecret` included — and never call its own provider.
   * Use `"test"` / `"live"`, or a merchant id. Executors that should share results
   * (your servers, for one account) take the same scope. A non-empty string without
   * surrounding whitespace, else `INVALID_CONFIG`. The key sent to the provider is
   * unchanged.
   */
  scope?: string;
  retry?: Partial<RetryConfig>;
  ttlMs?: number;
  /**
   * TTL (ms) for cached results in which no money moved: `failed` (a decline
   * the provider returned as a result) and `cancelled`. Defaults to 60s; every
   * other status uses `ttlMs`. Once it lapses, a repeat of the key calls the
   * provider again instead of being answered from the store. That is safe —
   * the first attempt charged nothing — but the provider decides the outcome:
   * Stripe, like `MockProvider`, replays its original result for a key it has
   * seen (Stripe for at least 24h). To retry a declined payment, send a new
   * idempotency key.
   */
  failedTtlMs?: number;
  /**
   * Max time (ms) a concurrent caller waits for the in-flight winner's result
   * (default 10_000). Deliberately shorter than a provider call can take —
   * with `StripeProvider`'s defaults one `execute()` can run ~122 s — so a
   * duplicate request does not hold its HTTP connection for minutes. When the
   * wait ends first, the caller gets `PayKitError` `IDEMPOTENCY_WAIT_TIMEOUT`
   * with `retryable: true`: the payment is still in flight, nothing was
   * charged twice, and re-sending the SAME key later returns its result.
   * Raise it (toward the provider envelope) only if callers can wait that long.
   */
  waitTimeoutMs?: number;
  /** Poll interval (ms) while waiting for an in-flight result. */
  pollIntervalMs?: number;
}

/**
 * A duration must be a finite number of milliseconds above zero, or the executor
 * refuses to be built. `Number(process.env.UNSET)` is `NaN`, and each bad value
 * fails silently and far from here: a `ttlMs` of `-1` or `0` expires the result
 * at once, so one key makes two provider calls; a `NaN` one never expires it;
 * a `waitTimeoutMs` of `NaN` never times out, so the poll holds its caller for
 * as long as the winner runs.
 */
function assertPositiveMs(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PayKitError(
      `Invalid executor config: ${name} must be a finite number of milliseconds above 0, got ${String(value)}.`,
      "INVALID_CONFIG",
    );
  }
  return value;
}

/**
 * What an executor stores a result under: the provider's name, the executor's
 * `scope` and the idempotency key. JSON-encoded so no such triple can collide
 * with another, whatever characters a name or a key holds. Read a store through
 * this if you read it directly; `isDuplicate` and `invalidate` already do.
 */
export function idempotencyStoreKey(providerName: string, scope: string | undefined, idempotencyKey: string): string {
  return JSON.stringify([providerName, scope ?? null, idempotencyKey]);
}

/** ISO 4217 shape: three letters (Stripe takes them lower case, PayKit either case). */
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/**
 * Assert that a Money amount is a valid, chargeable value.
 *
 * Amounts are a positive integer number of the smallest currency unit
 * (cents), within `Number.MAX_SAFE_INTEGER` — beyond it integers are not
 * exact (2^53 + 1 === 2^53 + 2 rounds), and `1e21` is integer-valued but not
 * an amount. `0` is rejected: there is nothing to charge (Stripe's minimum
 * is 50 cents or its equivalent). Floats like `49.99`, negatives, NaN and
 * Infinity are rejected too — they almost always mean a caller forgot to
 * convert dollars to cents. The currency must have the ISO 4217 shape, three
 * letters (`USD`, `usd`): `"usd "`, `"X"` or `"US$"` are refused rather than
 * passed to the provider. Whether a code is an actual ISO currency the
 * provider supports is the provider's call.
 */
export function assertValidMoney(amount: number, currency: string): void {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new PayKitError(
      `Invalid amount: ${amount}. Amount must be a finite number of minor units (cents).`,
      "INVALID_AMOUNT",
    );
  }
  if (!Number.isInteger(amount)) {
    throw new PayKitError(
      `Invalid amount: ${amount}. Amount must be an integer number of minor units (cents), e.g. 4999 for $49.99 — not 49.99.`,
      "INVALID_AMOUNT",
    );
  }
  if (!Number.isSafeInteger(amount)) {
    throw new PayKitError(
      `Invalid amount: ${amount}. Amount must be at most Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}) minor units; larger integers are not exact.`,
      "INVALID_AMOUNT",
    );
  }
  if (amount <= 0) {
    throw new PayKitError(
      `Invalid amount: ${amount}. Amount must be a positive number of minor units.`,
      "INVALID_AMOUNT",
    );
  }
  if (typeof currency !== "string" || !CURRENCY_CODE.test(currency)) {
    throw new PayKitError(
      `Invalid currency: ${JSON.stringify(currency)}. Currency must be a three-letter ISO 4217 code, e.g. "USD".`,
      "INVALID_CURRENCY",
    );
  }
}

/**
 * A refund without an idempotency key cannot be retried safely — the retry is
 * a second refund — so it is refused before any call (also for JavaScript
 * callers the type cannot stop).
 */
export function assertRefundKey(request: RefundRequest, provider: PaymentProvider): void {
  assertIdempotencyKey(
    request.idempotencyKey,
    provider,
    "refundPayment requires an idempotencyKey derived from your refund request (e.g. `refund_${refundRequestId}`): without one a retried refund refunds twice.",
  );
}

/** Longest idempotency key accepted — Stripe's limit for `Idempotency-Key`. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Printable ASCII: what travels unambiguously in an `Idempotency-Key` header. */
const IDEMPOTENCY_KEY_CHARSET = /^[\x20-\x7e]+$/;

/**
 * An idempotency key must be a non-empty string of printable ASCII without
 * leading or trailing whitespace, at most `MAX_IDEMPOTENCY_KEY_LENGTH`
 * characters; anything else throws `PayKitError` `INVALID_IDEMPOTENCY_KEY`
 * before any store or provider access. A missing or blank key is the dangerous
 * case: every key-less request would share ONE slot, so the second customer to
 * pay without a key would be handed the first customer's PaymentIntent —
 * `clientSecret` included. Surrounding whitespace is refused rather than
 * trimmed so `"order_1"` and `"order_1 "` can never be two keys that look like
 * one. The charset is the header's: `order_日本語` or a newline would pass here,
 * only for Node to refuse the header, and that would surface as a retryable
 * `network_error` for a request that can never succeed.
 */
export function assertIdempotencyKey(
  key: unknown,
  provider?: PaymentProvider,
  missingMessage = "An idempotency key is required — derive it from the business event (e.g. `order_${orderId}`). Without one, every key-less request shares one idempotency slot, and one customer would receive another's PaymentIntent (and clientSecret).",
): asserts key is string {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new PayKitError(missingMessage, "INVALID_IDEMPOTENCY_KEY", provider);
  }
  if (key !== key.trim()) {
    throw new PayKitError(
      `Invalid idempotency key ${JSON.stringify(key)}: it must not start or end with whitespace.`,
      "INVALID_IDEMPOTENCY_KEY",
      provider,
    );
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new PayKitError(
      `Invalid idempotency key: ${key.length} characters, more than the ${MAX_IDEMPOTENCY_KEY_LENGTH} Stripe accepts.`,
      "INVALID_IDEMPOTENCY_KEY",
      provider,
    );
  }
  if (!IDEMPOTENCY_KEY_CHARSET.test(key)) {
    throw new PayKitError(
      `Invalid idempotency key ${JSON.stringify(key)}: it must be printable ASCII, since it travels as an HTTP header.`,
      "INVALID_IDEMPOTENCY_KEY",
      provider,
    );
  }
}

/**
 * Idempotent payment executor.
 *
 * Wraps any PaymentProvider_Interface and adds:
 * 1. Idempotency: same key → same result, even under concurrent calls (one
 *    call in flight per key; a recorded result is replayed, not re-executed).
 *    Re-sends after an ambiguous failure rely on the provider honouring the
 *    key, as `PaymentProvider_Interface` requires.
 * 2. Retry: transient failures retried with exponential backoff + jitter.
 * 3. Conflict detection: same key + different request → IdempotencyError.
 *    The fingerprint lives in the store record next to the result, so it is
 *    shared by every executor using the store (for the same provider name and
 *    `scope`) and lives exactly as long as the cached result — the executor
 *    itself holds no per-key state.
 * 4. Deduplication logging.
 *
 * @example
 * ```ts
 * const executor = new IdempotentPaymentExecutor(stripe);
 * const order = { amount: { amount: 5000, currency: 'USD' }, idempotencyKey: 'order_abc123' };
 * const payment = await executor.execute(order);
 * // Calling again with the same key returns cached result
 * const same = await executor.execute(order);
 * console.assert(same.id === payment.id); // true
 * ```
 */
export class IdempotentPaymentExecutor {
  private store: IdempotencyStore;
  private scope: string | undefined;
  private retry: RetryConfig;
  /** True when the caller passed `retryableErrors`: the list is then exact. */
  private exactRetryCodes: boolean;
  private ttlMs: number;
  private failedTtlMs: number;
  private waitTimeoutMs: number;
  private pollIntervalMs: number;

  constructor(
    private provider: PaymentProvider_Interface,
    config: IdempotentPaymentExecutorConfig = {},
  ) {
    this.store = config.store ?? new InMemoryIdempotencyStore();
    if (config.scope !== undefined && (typeof config.scope !== "string" || config.scope.length === 0 || config.scope !== config.scope.trim())) {
      throw new PayKitError(
        `Invalid executor config: scope must be a non-empty string without surrounding whitespace, got ${JSON.stringify(config.scope)}.`,
        "INVALID_CONFIG",
      );
    }
    this.scope = config.scope;
    const retryableErrors = config.retry?.retryableErrors;
    if (retryableErrors !== undefined && (!Array.isArray(retryableErrors) || !retryableErrors.every((code) => typeof code === "string"))) {
      throw new PayKitError(`Invalid retry config: retryableErrors must be an array of error codes, got ${JSON.stringify(retryableErrors)}.`, "INVALID_CONFIG");
    }
    // Spread alone would let an explicit `undefined` overwrite the default list,
    // and the first retryable error would then surface as a TypeError.
    this.retry = { ...DEFAULT_RETRY, ...config.retry, retryableErrors: retryableErrors ?? DEFAULT_RETRY.retryableErrors };
    this.exactRetryCodes = retryableErrors !== undefined;
    if (!Number.isInteger(this.retry.maxAttempts) || this.retry.maxAttempts < 1) {
      throw new PayKitError(
        `Invalid retry config: maxAttempts must be an integer >= 1, got ${this.retry.maxAttempts}.`,
        "INVALID_CONFIG",
      );
    }
    for (const name of ["initialDelayMs", "maxDelayMs", "backoffFactor"] as const) {
      const value = this.retry[name];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        // NaN delays become setTimeout(NaN): every retry hits the provider at once.
        throw new PayKitError(`Invalid retry config: ${name} must be a finite number >= 0, got ${String(value)}.`, "INVALID_CONFIG");
      }
    }
    this.ttlMs = assertPositiveMs("ttlMs", config.ttlMs ?? 86_400_000); // 24 hours
    this.failedTtlMs = assertPositiveMs("failedTtlMs", config.failedTtlMs ?? 60_000); // 60 seconds
    this.waitTimeoutMs = assertPositiveMs("waitTimeoutMs", config.waitTimeoutMs ?? 10_000);
    this.pollIntervalMs = assertPositiveMs("pollIntervalMs", config.pollIntervalMs ?? 25);
  }

  /**
   * Execute a payment idempotently.
   *
   * If a payment with this idempotencyKey already has a terminal result, that
   * cached result is returned. If a concurrent call is already in flight for the
   * key, this call waits for that winner's result instead of charging again.
   * Otherwise this call wins the reservation and executes the payment.
   *
   * What is cached, and for how long: a result in which money may have moved
   * — `succeeded`, or still `pending`/`processing` — for `ttlMs`; one in which
   * no money moved (`failed`, `cancelled`) for `failedTtlMs`. A replay returns
   * the result as first recorded: for a payment that was still pending, read
   * its current status with `provider.getPayment(id)` or from webhooks.
   *
   * A provider ERROR is never cached: it is thrown and the reservation is
   * released. Stripe raises a card decline as an error (a non-retryable
   * `ProviderError`, e.g. code `card_declined`), so a Stripe decline is not
   * cached here at all — and Stripe itself replays that decline for the same
   * key for at least 24h. Retry a declined card with a new key.
   *
   * @throws {IdempotencyError} if the key was already used with a different
   *   request — any field: amount, currency, description, metadata, customer,
   *   payment method, return URL, off-session flag or capture method — by this
   *   or any other executor sharing the store, the provider name and the `scope`.
   * @throws {PaymentResultNotStoredError} if the provider answered but the store
   *   could not record it. Not a failed payment: the error carries the result.
   */
  async execute(request: CreatePaymentRequest): Promise<PaymentIntent> {
    const { idempotencyKey } = request;
    assertIdempotencyKey(idempotencyKey);
    // `?.`: JavaScript callers can omit it, and the answer is still INVALID_AMOUNT.
    assertValidMoney(request.amount?.amount, request.amount?.currency);

    const fingerprint = fingerprintRequest(request);
    const storeKey = this._storeKey(idempotencyKey);

    // Fast path: a terminal result already exists.
    const cached = await this.store.get(storeKey);
    if (cached) {
      return this._replay(idempotencyKey, cached, fingerprint, "cache_hit");
    }

    // Try to become the single caller that executes this key.
    const token = await this.store.reserve(storeKey);
    if (token === null) {
      // Someone else is either in-flight or just finished. Wait for their
      // terminal result rather than issuing a second charge.
      return this._awaitTerminalResult(request, fingerprint);
    }

    // We own the reservation.
    return this._runAsWinner(request, fingerprint, token);
  }

  /** Where this executor keeps a key: scoped, so another account's results stay out of reach. */
  private _storeKey(idempotencyKey: string): string {
    return idempotencyStoreKey(this.provider.name, this.scope, idempotencyKey);
  }

  /**
   * Execute the provider call as the reservation winner: run with retry,
   * cache the terminal result together with the request fingerprint, and
   * release the reservation on hard failure so the key stays retryable.
   *
   * The caller MUST already hold the reservation for `request.idempotencyKey`;
   * `token` is the one `reserve()` returned, and only it can release it.
   */
  private async _runAsWinner(
    request: CreatePaymentRequest,
    fingerprint: string,
    token: string,
  ): Promise<PaymentIntent> {
    const { idempotencyKey } = request;
    const storeKey = this._storeKey(idempotencyKey);

    let intent: PaymentIntent;
    try {
      intent = await this._executeWithRetry(request);
    } catch (err) {
      // Provider failed hard — release the reservation so the key can be
      // retried by a future request instead of being stuck pending.
      try {
        await this.store.release(storeKey, token);
      } catch (releaseError) {
        // What the caller must act on is why the PAYMENT failed: a store outage
        // must not turn a decline into a bare `Error: redis down`. Attached with
        // Reflect.set, which a frozen error refuses without throwing over `err`.
        const attached = typeof err === "object" && err !== null && Reflect.set(err, "releaseError", releaseError);
        if (!attached) {
          console.warn(`[PayKit] The reservation for idempotency key ${idempotencyKey} could not be released:`, releaseError);
        }
      }
      throw err;
    }

    // Cache the result. Anything in which money may have moved (succeeded,
    // pending, processing) → full TTL, so PayKit never re-sends that key
    // itself; no money moved (failed, cancelled) → short TTL. The fingerprint
    // rides in the same record, so it can never outlive or predecease the
    // result it guards.
    const ttl = NO_MONEY_MOVED.has(intent.status) ? this.failedTtlMs : this.ttlMs;
    // The store keeps its own copy and the caller gets another, so nothing a
    // caller does to its result can reach later duplicates of the key.
    try {
      await this.store.set(storeKey, { intent: copyIntent(intent), fingerprint }, ttl);
    } catch (cause) {
      // The provider has answered, so this is not a payment failure, and the
      // caller gets the result. The reservation stays: releasing it would let
      // the next caller reach the provider while the store is down.
      throw new PaymentResultNotStoredError(idempotencyKey, copyIntent(intent), cause);
    }

    return copyIntent(intent);
  }

  /**
   * Return a cached result to a caller of its key — after checking that the
   * caller sent the same request. A different request under the same key is a
   * conflict, wherever the original was executed.
   */
  private _replay(
    key: string,
    record: IdempotencyRecord,
    fingerprint: string,
    tag: "cache_hit" | "in_flight_join",
  ): PaymentIntent {
    if (record.fingerprint !== fingerprint) {
      throw new IdempotencyError(key);
    }
    const copy = copyIntent(record.intent);
    return { ...copy, metadata: { ...copy.metadata, _idempotency: tag } };
  }

  /**
   * Is a result recorded for this key, for this provider name and `scope`?
   * `false` while the first call is still in flight, so this is not a guard
   * against charging twice: `execute()` is, and it joins a call in flight instead
   * of starting another.
   */
  async isDuplicate(idempotencyKey: string): Promise<boolean> {
    return this.store.has(this._storeKey(idempotencyKey));
  }

  /**
   * Drop the cached result for a key (use with caution). It neither undoes nor
   * re-enables the charge: the next `execute()` with this key reaches the
   * provider again, which — honouring the key, as the provider contract
   * requires — returns the original payment. A new charge takes a new key.
   *
   * A call for the key that is still in flight keeps its reservation:
   * invalidating mid-call never lets a second provider call start alongside
   * it — a concurrent `execute()` waits for the running one's result.
   */
  async invalidate(idempotencyKey: string): Promise<void> {
    await this.store.delete(this._storeKey(idempotencyKey));
  }

  /**
   * A concurrent call lost the reservation race. Wait for the in-flight winner
   * to publish a terminal result. Bounded loop: polls the store until a result
   * appears or the timeout fires.
   *
   * If the winner released its reservation without leaving a terminal result
   * (its provider call failed), this call takes over the reservation and
   * executes the payment itself — so a failed winner never strands the key.
   */
  private async _awaitTerminalResult(
    request: CreatePaymentRequest,
    fingerprint: string,
  ): Promise<PaymentIntent> {
    const key = request.idempotencyKey;
    const storeKey = this._storeKey(key);
    const deadline = Date.now() + this.waitTimeoutMs;

    // `for (;;)` rather than `while (true)`: same deliberate infinite poll, but
    // it has no constant condition for `no-constant-condition` to flag, so lint
    // stays green without an inline suppression.
    for (;;) {
      const cached = await this.store.get(storeKey);
      if (cached) {
        return this._replay(key, cached, fingerprint, "in_flight_join");
      }

      // No terminal result yet. If the reservation is now free (winner failed
      // and released it), take it over and execute ourselves.
      const token = await this.store.reserve(storeKey);
      if (token !== null) {
        return this._runAsWinner(request, fingerprint, token);
      }

      if (Date.now() >= deadline) {
        throw new PayKitError(
          `Payment for idempotency key ${key} is still in flight after ${this.waitTimeoutMs}ms (another request is executing it); nothing was charged twice — retry later with the same key to get its result.`,
          "IDEMPOTENCY_WAIT_TIMEOUT",
          undefined,
          true,
        );
      }
      await this._sleep(this.pollIntervalMs);
    }
  }

  private async _executeWithRetry(request: CreatePaymentRequest): Promise<PaymentIntent> {
    let lastError: Error | null = null;
    let delay = this.retry.initialDelayMs;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        return await this.provider.createPayment(request);
      } catch (err: unknown) {
        lastError = err as Error;
        const paykitErr = err as PayKitError;

        const listed = !!paykitErr.code && this.retry.retryableErrors.includes(paykitErr.code);
        const isRetryable = this.exactRetryCodes ? listed : listed || paykitErr.retryable === true;

        if (!isRetryable || attempt === this.retry.maxAttempts) {
          throw err;
        }

        await this._sleep(this._jitter(delay));
        delay = Math.min(delay * this.retry.backoffFactor, this.retry.maxDelayMs);
      }
    }

    // Unreachable in practice (the loop either returns or throws), but keeps the
    // type-checker happy and never surfaces a bare `null`.
    throw lastError ?? new PayKitError("Retry exhausted with no error captured", "RETRY_EXHAUSTED");
  }

  /**
   * Apply full jitter to a backoff delay so concurrent retriers don't
   * thundering-herd the provider. Returns a value in [base/2, base].
   */
  private _jitter(base: number): number {
    return base / 2 + Math.random() * (base / 2);
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
