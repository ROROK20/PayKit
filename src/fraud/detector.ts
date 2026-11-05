/**
 * Rule-based fraud detection with pluggable signal hooks.
 *
 * Seven built-in rules, each a signal named as `check()` reports it:
 * - `high_amount_new_account` — account younger than 7 days, amount > 50,000
 * - `new_payment_method_high_amount` — new payment method, amount > 100,000
 * - `high_velocity` — the caller-supplied `previousPaymentCount` exceeds 10.
 *   PayKit does not count payments or apply a time window itself: pass the
 *   customer's payment count over the window you mean by "velocity" (say the
 *   last hour or day). A lifetime count makes this an "established customer"
 *   flag, not a velocity check.
 * - `round_number_amount` — a whole multiple of 100,000 above 100,000
 * - `missing_user_agent` — no user agent
 * - `very_high_amount` — amount > 1,000,000
 * - `anonymous_transaction` — no customer id
 *
 * No built-in rule reads `ipAddress`, `deviceFingerprint` or any location:
 * there are no device, IP or geographic checks. Those `FraudContext` fields
 * exist for your own rules — add them via addRule().
 *
 * Scores add up, so a known customer with a user agent scores only what the
 * amount rules add, however large the amount. A separate hard ceiling covers
 * that: above `reviewAmountCeiling` the recommendation is at least "review",
 * whatever the score. Card testing is the opposite shape, many small charges the
 * amount rules never see, so `reviewVelocityCeiling` does the same for the count.
 * See `FraudDetectorConfig`.
 *
 * Currency: the built-in amount thresholds are fixed numbers of MINOR units
 * (50_000, 100_000, 1_000_000) with no FX conversion, calibrated for
 * 2-decimal currencies — 100_000 is $1,000.00 or €1,000.00, but ¥100,000
 * in JPY, which has no minor unit: a much smaller amount, scored the same.
 * Reasons print each threshold in
 * the payment's own currency so they never claim "$" for a JPY payment. For
 * other currencies, clearBuiltInRules() and add rules with your own limits.
 */

import {
  FraudContext,
  FraudCheckResult,
  FraudSignal,
  FraudRiskLevel,
  PayKitError,
} from "../types/index";

/** Largest weight one rule may carry — the whole score is capped at 100. */
export const MAX_RULE_WEIGHT = 100;

/** Default `reviewAmountCeiling`, in minor units: $100,000.00 in USD. */
export const DEFAULT_REVIEW_AMOUNT_CEILING = 10_000_000;

/** Default `reviewVelocityCeiling`: payments in the caller's velocity window. */
export const DEFAULT_REVIEW_VELOCITY_CEILING = 50;

export interface FraudDetectorConfig {
  /**
   * Above this amount, in minor units, `check()` recommends at least `review`,
   * whatever the score: the amount rules alone cannot get a known customer to
   * `review`, so $10,000,000 would otherwise be approved. It raises the
   * recommendation only; `riskScore` and `riskLevel` stay what the rules say, and
   * `reasons` names the ceiling. It is not a rule, so `clearBuiltInRules()` leaves
   * it in place. Exactly this amount is not over it.
   *
   * Default `DEFAULT_REVIEW_AMOUNT_CEILING` (10,000,000: $100,000.00 in USD). Like
   * the rules' thresholds it is minor units with no FX conversion, so set your own
   * for other currencies: the default is ¥10,000,000 in JPY, which has no minor
   * unit. A positive safe integer, else `INVALID_CONFIG`; `Number.MAX_SAFE_INTEGER`
   * turns it off, since no valid amount exceeds it.
   */
  reviewAmountCeiling?: number;
  /**
   * Above this `previousPaymentCount`, `check()` recommends at least `review`,
   * whatever the amount or the score. Card testing is a run of tiny charges: the
   * amount rules never fire, and `high_velocity` alone scores too little, so
   * $1.00 with a count of 1,000 would otherwise be approved. It behaves like
   * `reviewAmountCeiling`: it raises the recommendation only, `reasons` names it,
   * `clearBuiltInRules()` leaves it in place, and exactly this count is not over it.
   *
   * Default `DEFAULT_REVIEW_VELOCITY_CEILING` (50). The count is whatever your
   * window holds, so set your own if yours is long or your customers pay often. A
   * positive safe integer, else `INVALID_CONFIG`; `Number.MAX_SAFE_INTEGER` turns
   * it off, since no valid count exceeds it.
   */
  reviewVelocityCeiling?: number;
}

/** A configured ceiling must be a positive safe integer, or the detector is not built. */
function assertCeiling(name: string, value: number, unit: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PayKitError(`Invalid FraudDetector config: ${name} must be a positive safe integer ${unit}, got ${value}.`, "INVALID_CONFIG");
  }
  return value;
}

/** Why a rule's weight is unusable, or `null`: a finite number from 0 to `MAX_RULE_WEIGHT`. */
function weightError(weight: unknown): string | null {
  if (typeof weight !== "number" || !Number.isFinite(weight)) return `weight ${String(weight)} is not a finite number`;
  if (weight < 0) return `weight ${weight} is negative`;
  if (weight > MAX_RULE_WEIGHT) return `weight ${weight} exceeds ${MAX_RULE_WEIGHT}`;
  return null;
}

/** A numeric signal as an error message may show it (no `String()`: not everything has a `toString`). */
function shown(value: unknown): string {
  return typeof value === "number" ? String(value) : `of type ${value === null ? "null" : typeof value}`;
}

/** Why a context cannot be scored, or `null`. */
function fraudContextError(context: unknown): string | null {
  if (!context || typeof context !== "object") return "no context";
  const { accountAgeDays, previousPaymentCount } = context as { accountAgeDays?: unknown; previousPaymentCount?: unknown };
  const money = (context as { amount?: unknown }).amount as { amount?: unknown; currency?: unknown } | undefined;
  if (!money || typeof money !== "object") return "amount is missing";
  if (typeof money.amount !== "number" || !Number.isSafeInteger(money.amount) || money.amount < 0) {
    return `amount ${String(money.amount)} is not a non-negative safe integer of minor units`;
  }
  // Any non-empty code: an unknown one is scored and displayed in raw minor units.
  if (typeof money.currency !== "string" || money.currency.length === 0) {
    return `currency ${JSON.stringify(money.currency) ?? "undefined"} is not a non-empty string`;
  }
  // `undefined` means the caller has no such signal, and its rule stays silent.
  if (accountAgeDays !== undefined && (typeof accountAgeDays !== "number" || !Number.isFinite(accountAgeDays) || accountAgeDays < 0)) {
    return `accountAgeDays ${shown(accountAgeDays)} is not a finite number >= 0`;
  }
  if (previousPaymentCount !== undefined && (typeof previousPaymentCount !== "number" || !Number.isSafeInteger(previousPaymentCount) || previousPaymentCount < 0)) {
    return `previousPaymentCount ${shown(previousPaymentCount)} is not a non-negative safe integer`;
  }
  return null;
}

/** The fail-closed verdict: score 100, critical, decline, with why. */
function failClosed(problems: string[], signals: FraudSignal[]): FraudCheckResult {
  return {
    riskScore: 100,
    riskLevel: "critical",
    signals,
    recommendation: "decline",
    reasons: problems.map((p) => `${p}; failing closed`),
    checkedAt: new Date(),
  };
}

/** The minimal context `addRule` and `getRules` evaluate a rule against. */
const PROBE_CONTEXT: FraudContext = { amount: { amount: 0, currency: "USD" } };

/**
 * A fraud rule: a pure function from the payment context to one signal. Keep
 * it free of side effects and return the same `name` whatever the context —
 * `getRules()` reads each rule's name by evaluating it.
 */
export type FraudRule = (context: FraudContext) => FraudSignal;

/**
 * Display an integer minor-unit amount in its own currency, using the ISO 4217
 * digit count Intl knows (USD 2, JPY 0, KWD 3): 100_000 USD → "$1,000.00",
 * 100_000 JPY → "¥100,000". Display only — no money arithmetic. An unknown
 * currency code falls back to the raw minor units.
 */
function formatMinorUnits(minor: number, currency: string): string {
  try {
    const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minor / 10 ** digits);
  } catch {
    return `${minor.toLocaleString("en-US")} minor units of ${currency}`;
  }
}

/** Built-in fraud detection rules. */
const BUILT_IN_RULES: FraudRule[] = [
  // High amount for new account
  (ctx): FraudSignal => ({
    name: "high_amount_new_account",
    triggered:
      ctx.accountAgeDays !== undefined &&
      ctx.accountAgeDays < 7 &&
      ctx.amount.amount > 50_000, // minor units: $500.00 in USD
    weight: 30,
    reason: "Account less than 7 days old with high transaction amount",
  }),

  // New payment method + large amount
  (ctx): FraudSignal => ({
    name: "new_payment_method_high_amount",
    triggered: (ctx.isNewPaymentMethod ?? false) && ctx.amount.amount > 100_000,
    weight: 25,
    reason: `New payment method with transaction > ${formatMinorUnits(100_000, ctx.amount.currency)}`,
  }),

  // Velocity, as far as the caller's count goes: PayKit applies no window.
  (ctx): FraudSignal => ({
    name: "high_velocity",
    triggered:
      ctx.previousPaymentCount !== undefined && ctx.previousPaymentCount > 10,
    weight: 20,
    reason:
      ctx.previousPaymentCount === undefined
        ? "No payment count supplied, so velocity was not checked"
        : `${ctx.previousPaymentCount} payments in the caller-supplied velocity window (more than 10)`,
  }),

  // Round number amounts (often indicate testing or fraud).
  // Stay in integer minor units for the test itself: `amount % 100_000 === 0`
  // means a whole multiple of 100_000 minor units ($1,000.00 in USD).
  (ctx): FraudSignal => {
    const cents = ctx.amount.amount;
    const isRound =
      cents > 0 &&
      cents % 100_000 === 0 &&
      cents > 100_000;
    return {
      name: "round_number_amount",
      triggered: isRound,
      weight: 10,
      reason: `Round number amount (${formatMinorUnits(cents, ctx.amount.currency)}) may indicate testing`,
    };
  },

  // Missing user agent (often bots)
  (ctx): FraudSignal => ({
    name: "missing_user_agent",
    triggered: !ctx.userAgent || ctx.userAgent.length === 0,
    weight: 15,
    reason: "Missing user agent string — may indicate automated request",
  }),

  // Very high amount
  (ctx): FraudSignal => ({
    name: "very_high_amount",
    triggered: ctx.amount.amount > 1_000_000, // minor units: $10,000.00 in USD
    weight: 20,
    reason: `Transaction amount exceeds ${formatMinorUnits(1_000_000, ctx.amount.currency)}`,
  }),

  // No customer ID (anonymous transaction)
  (ctx): FraudSignal => ({
    name: "anonymous_transaction",
    triggered: !ctx.customerId,
    weight: 5,
    reason: "No customer ID — anonymous transaction",
  }),
];

function scoreToLevel(score: number): FraudRiskLevel {
  if (score >= 80) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

function scoreToRecommendation(score: number): FraudCheckResult["recommendation"] {
  if (score >= 70) return "decline";
  if (score >= 35) return "review";
  return "approve";
}

/**
 * Fraud detector with pluggable rule engine.
 *
 * @example
 * ```ts
 * const detector = new FraudDetector();
 *
 * // Add a custom rule
 * detector.addRule((ctx) => ({
 *   name: 'high_risk_country',
 *   triggered: HIGH_RISK_COUNTRIES.includes(ctx.metadata?.country ?? ''),
 *   weight: 35,
 *   reason: 'Transaction from high-risk jurisdiction',
 * }));
 *
 * const result = detector.check({
 *   amount: { amount: 500_00, currency: 'USD' },
 *   customerId: 'cus_123',
 *   isNewPaymentMethod: true,
 *   accountAgeDays: 2,
 * });
 *
 * if (result.recommendation === 'decline') {
 *   throw new Error('Transaction declined due to fraud risk');
 * }
 * ```
 */
export class FraudDetector {
  private rules: FraudRule[] = [...BUILT_IN_RULES];
  private readonly reviewAmountCeiling: number;
  private readonly reviewVelocityCeiling: number;

  constructor(config: FraudDetectorConfig = {}) {
    this.reviewAmountCeiling = assertCeiling("reviewAmountCeiling", config.reviewAmountCeiling ?? DEFAULT_REVIEW_AMOUNT_CEILING, "number of minor units");
    this.reviewVelocityCeiling = assertCeiling("reviewVelocityCeiling", config.reviewVelocityCeiling ?? DEFAULT_REVIEW_VELOCITY_CEILING, "number of payments");
  }

  /**
   * Add a custom fraud detection rule. The rule is evaluated once against a
   * minimal context; if it returns a weight that is not a finite number from
   * 0 to `MAX_RULE_WEIGHT`, it is refused (`INVALID_CONFIG`) — a `NaN` weight
   * would turn every score into `NaN` and the verdict into "approve", and a
   * negative one could cancel real risk out. (A rule that throws for the
   * minimal context is accepted; if it throws for a real payment, `check()`
   * fails closed for that payment.)
   */
  addRule(rule: FraudRule): this {
    let probed: FraudSignal | undefined;
    try {
      probed = rule(PROBE_CONTEXT);
    } catch {
      probed = undefined;
    }
    const reason = probed && typeof probed === "object" ? weightError(probed.weight) : null;
    if (reason) {
      throw new PayKitError(`Invalid fraud rule ${JSON.stringify(probed!.name)}: ${reason}.`, "INVALID_CONFIG");
    }
    this.rules.push(rule);
    return this;
  }

  /**
   * Remove the built-in rules (e.g. for full custom control, or other
   * currencies' thresholds). Rules added with `addRule()` stay, whichever
   * order the two calls come in.
   */
  clearBuiltInRules(): this {
    this.rules = this.rules.filter((rule) => !BUILT_IN_RULES.includes(rule));
    return this;
  }

  /**
   * Evaluate a payment context for fraud signals.
   *
   * @param context - Payment context including amount, device, and account signals.
   * @returns FraudCheckResult with risk score, level, and recommendation.
   */
  check(context: FraudContext): FraudCheckResult {
    // Fail closed on input the rules cannot score: an amount that is not a
    // non-negative safe integer (a NaN or negative amount would read "approve",
    // since every threshold comparison with it is false), a missing currency,
    // or an account age or payment count that is present but not a usable
    // number (a NaN age, from a missing date, would read "no risk").
    const contextError = fraudContextError(context);
    if (contextError) return failClosed([`Invalid fraud context: ${contextError}`], []);

    // Fail closed on a broken rule: one that throws (which would abort check()
    // and with it the whole checkBatch), returns something that is not a
    // signal object, or reports a triggered signal whose weight is not a
    // finite number from 0 to MAX_RULE_WEIGHT (NaN would make the sum
    // meaningless and read "low" / "approve").
    const signals: FraudSignal[] = [];
    const broken: string[] = [];
    this.rules.forEach((rule, i) => {
      let s: FraudSignal;
      try {
        s = rule(context);
      } catch (err) {
        broken.push(`Rule ${i} threw (${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      if (!s || typeof s !== "object") {
        broken.push(`Rule ${i} returned no signal object`);
        return;
      }
      signals.push(s);
      const reason = s.triggered ? weightError(s.weight) : null;
      if (reason) broken.push(`Rule ${JSON.stringify(s.name)} returned an invalid ${reason}`);
    });
    if (broken.length > 0) return failClosed(broken, signals);
    const triggeredSignals = signals.filter((s) => s.triggered);

    // Weighted score capped at 100
    const rawScore = triggeredSignals.reduce((sum, s) => sum + s.weight, 0);
    const riskScore = Math.min(rawScore, 100);

    const riskLevel = scoreToLevel(riskScore);
    let recommendation = scoreToRecommendation(riskScore);
    const reasons = triggeredSignals.map((s) => s.reason);

    // The hard ceilings can only raise the recommendation: a decline stays one.
    if (context.amount.amount > this.reviewAmountCeiling) {
      if (recommendation === "approve") recommendation = "review";
      const { amount, currency } = context.amount;
      reasons.push(`Amount ${formatMinorUnits(amount, currency)} is over the review ceiling of ${formatMinorUnits(this.reviewAmountCeiling, currency)}`);
    }
    const { previousPaymentCount } = context;
    if (previousPaymentCount !== undefined && previousPaymentCount > this.reviewVelocityCeiling) {
      if (recommendation === "approve") recommendation = "review";
      reasons.push(`${previousPaymentCount} payments in the caller-supplied velocity window is over the review ceiling of ${this.reviewVelocityCeiling}`);
    }

    return {
      riskScore,
      riskLevel,
      signals,
      recommendation,
      reasons,
      checkedAt: new Date(),
    };
  }

  /**
   * Batch check multiple payments.
   */
  checkBatch(contexts: FraudContext[]): FraudCheckResult[] {
    return contexts.map((ctx) => this.check(ctx));
  }

  /**
   * Names of the registered rules, in evaluation order — the `name` of the
   * signal each returns, as `check()` reports it in `signals`. Rules are pure
   * functions, so each is evaluated once against a minimal context (an amount
   * of 0 USD, nothing else) to read its name; a rule that throws for that
   * context, or returns no name, is listed as `rule_<index>`.
   */
  getRules(): string[] {
    return this.rules.map((rule, i) => {
      try {
        const name = rule(PROBE_CONTEXT).name;
        return typeof name === "string" && name.length > 0 ? name : `rule_${i}`;
      } catch {
        return `rule_${i}`;
      }
    });
  }
}
