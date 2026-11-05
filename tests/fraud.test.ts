/**
 * Tests for fraud detector.
 */

import fs from "fs";
import path from "path";

import { DEFAULT_REVIEW_AMOUNT_CEILING, DEFAULT_REVIEW_VELOCITY_CEILING, FraudDetector } from "../src/fraud/detector";
import { FraudContext } from "../src/types";

function makeCtx(overrides: Partial<FraudContext> = {}): FraudContext {
  return {
    amount: { amount: 5000, currency: "USD" }, // $50
    customerId: "cus_123",
    userAgent: "Mozilla/5.0",
    accountAgeDays: 365,
    isNewPaymentMethod: false,
    previousPaymentCount: 3,
    ...overrides,
  };
}

describe("FraudDetector", () => {
  let detector: FraudDetector;

  beforeEach(() => {
    detector = new FraudDetector();
  });

  test("low-risk transaction returns approve", () => {
    const result = detector.check(makeCtx());
    expect(result.recommendation).toBe("approve");
    expect(result.riskLevel).toBe("low");
  });

  test("risk score between 0 and 100", () => {
    const result = detector.check(makeCtx());
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.riskScore).toBeLessThanOrEqual(100);
  });

  test("new account + high amount triggers high risk", () => {
    const result = detector.check(makeCtx({
      accountAgeDays: 2,
      amount: { amount: 200_000, currency: "USD" }, // $2000
    }));
    expect(result.riskScore).toBeGreaterThan(20);
  });

  test("new payment method + large amount increases risk", () => {
    const lowRisk = detector.check(makeCtx({ isNewPaymentMethod: false }));
    const highRisk = detector.check(makeCtx({
      isNewPaymentMethod: true,
      amount: { amount: 200_000, currency: "USD" },
    }));
    expect(highRisk.riskScore).toBeGreaterThan(lowRisk.riskScore);
  });

  test("very high amount triggers signal", () => {
    const result = detector.check(makeCtx({
      amount: { amount: 2_000_000, currency: "USD" }, // $20,000
    }));
    const highAmtSignal = result.signals.find((s) => s.name === "very_high_amount");
    expect(highAmtSignal?.triggered).toBe(true);
  });

  test("missing user agent triggers signal", () => {
    const result = detector.check(makeCtx({ userAgent: undefined }));
    const signal = result.signals.find((s) => s.name === "missing_user_agent");
    expect(signal?.triggered).toBe(true);
  });

  test("high velocity triggers signal", () => {
    const result = detector.check(makeCtx({ previousPaymentCount: 15 }));
    const signal = result.signals.find((s) => s.name === "high_velocity");
    expect(signal?.triggered).toBe(true);
  });

  test("anonymous transaction triggers signal", () => {
    const result = detector.check(makeCtx({ customerId: undefined }));
    const signal = result.signals.find((s) => s.name === "anonymous_transaction");
    expect(signal?.triggered).toBe(true);
  });

  test("custom rule can be added", () => {
    detector.addRule((ctx) => ({
      name: "test_custom_rule",
      triggered: ctx.amount.amount > 1_000_000,
      weight: 50,
      reason: "Custom rule triggered",
    }));
    const result = detector.check(makeCtx({ amount: { amount: 1_500_000, currency: "USD" } }));
    const custom = result.signals.find((s) => s.name === "test_custom_rule");
    expect(custom?.triggered).toBe(true);
    expect(result.riskScore).toBeGreaterThan(50);
  });

  test("clearBuiltInRules removes all built-in rules", () => {
    detector.clearBuiltInRules();
    const result = detector.check(makeCtx({ accountAgeDays: 0, amount: { amount: 9_999_999, currency: "USD" } }));
    // Without built-in rules, risk should be 0
    expect(result.riskScore).toBe(0);
    expect(result.recommendation).toBe("approve");
  });

  test("batch check processes multiple contexts", () => {
    const contexts = [makeCtx(), makeCtx({ accountAgeDays: 0 }), makeCtx({ isNewPaymentMethod: true })];
    const results = detector.checkBatch(contexts);
    expect(results).toHaveLength(3);
    results.forEach((r) => {
      expect(r.riskScore).toBeGreaterThanOrEqual(0);
      expect(r.riskScore).toBeLessThanOrEqual(100);
    });
  });

  test("recommendation is approve/review/decline", () => {
    const result = detector.check(makeCtx());
    expect(["approve", "review", "decline"]).toContain(result.recommendation);
  });

  test("signals array has entries for all rules", () => {
    const result = detector.check(makeCtx());
    expect(result.signals.length).toBeGreaterThan(0);
    result.signals.forEach((s) => {
      expect(typeof s.triggered).toBe("boolean");
      expect(s.weight).toBeGreaterThanOrEqual(0);
    });
  });

  test("checkedAt is a date", () => {
    const result = detector.check(makeCtx());
    expect(result.checkedAt).toBeInstanceOf(Date);
  });
});

describe("FraudDetector — currency-correct reasons (thresholds are minor units, not dollars)", () => {
  const detector = new FraudDetector();
  const reasonsFor = (amount: number, currency: string) =>
    detector
      .check({ amount: { amount, currency }, customerId: "c", userAgent: "UA", isNewPaymentMethod: true })
      .reasons.join(" | ");

  test("a JPY payment's reasons are in yen — never '$'", () => {
    const reasons = reasonsFor(3_000_000, "JPY"); // round, > 1_000_000 and > 100_000 minor units
    expect(reasons).toContain("Round number amount (¥3,000,000)");
    expect(reasons).toContain("Transaction amount exceeds ¥1,000,000");
    expect(reasons).toContain("New payment method with transaction > ¥100,000");
    expect(reasons).not.toContain("$");
  });

  test("USD renders in dollars, with cents", () => {
    const reasons = reasonsFor(3_000_000, "USD");
    expect(reasons).toContain("Round number amount ($30,000.00)");
    expect(reasons).toContain("Transaction amount exceeds $10,000.00");
    expect(reasons).toContain("New payment method with transaction > $1,000.00");
  });

  test("a 3-decimal currency (KWD) divides by 1,000, and an unknown code falls back to minor units", () => {
    expect(reasonsFor(3_000_000, "KWD")).toContain("KWD");
    expect(reasonsFor(3_000_000, "KWD")).toContain("3,000.000");
    expect(reasonsFor(3_000_000, "NOT_A_CODE")).toContain("3,000,000 minor units of NOT_A_CODE");
  });
});

describe("FraudDetector — every claim about the built-in rules is true", () => {
  const BUILT_IN = [
    "high_amount_new_account",
    "new_payment_method_high_amount",
    "high_velocity",
    "round_number_amount",
    "missing_user_agent",
    "very_high_amount",
    "anonymous_transaction",
  ];

  test("getRules() names the rules by the signal each reports, in evaluation order (not rule_0..rule_6)", () => {
    const detector = new FraudDetector();
    expect(detector.getRules()).toEqual(BUILT_IN);
    expect(detector.check(makeCtx()).signals.map((s) => s.name)).toEqual(BUILT_IN);
  });

  test("getRules() includes custom rules by name, and falls back to rule_<index> for a rule that throws on a bare context", () => {
    const detector = new FraudDetector()
      .clearBuiltInRules()
      .addRule((ctx) => ({ name: "high_risk_country", triggered: ctx.metadata?.country === "XX", weight: 35, reason: "r" }))
      .addRule((ctx) => ({ name: "needs_metadata", triggered: ctx.metadata!.vip === "no", weight: 1, reason: "r" }));
    expect(detector.getRules()).toEqual(["high_risk_country", "rule_1"]);
  });

  test("with no count supplied, high_velocity stays off and its reason does not read undefined", () => {
    const signal = new FraudDetector()
      .check(makeCtx({ previousPaymentCount: undefined }))
      .signals.find((s) => s.name === "high_velocity")!;
    expect(signal.triggered).toBe(false);
    expect(signal.reason).toBe("No payment count supplied, so velocity was not checked");
  });

  test("high_velocity is the caller's windowed count, and its reason says so", () => {
    const signal = new FraudDetector()
      .check(makeCtx({ previousPaymentCount: 11 }))
      .signals.find((s) => s.name === "high_velocity")!;
    expect(signal.triggered).toBe(true);
    expect(signal.reason).toBe("11 payments in the caller-supplied velocity window (more than 10)");
  });

  test.each([
    [9, false],
    [10, false],
    [11, true],
  ])("high_velocity at a count of %i: triggered %s (it fires above 10, as the docs say)", (previousPaymentCount, triggered) => {
    const result = new FraudDetector().check(makeCtx({ previousPaymentCount }));
    expect(result.signals.find((s) => s.name === "high_velocity")!.triggered).toBe(triggered);
    expect(result.riskScore).toBe(triggered ? 20 : 0);
  });

  test("no built-in rule reads ipAddress or deviceFingerprint (there are no device, IP or geographic checks)", () => {
    const detector = new FraudDetector();
    const bare = detector.check(makeCtx());
    const withDevice = detector.check(
      makeCtx({ ipAddress: "198.51.100.23", deviceFingerprint: "fp_emulator_rooted", metadata: { country: "XX" } }),
    );
    expect(withDevice.signals).toEqual(bare.signals);
    expect(withDevice.riskScore).toBe(bare.riskScore);
  });
});

describe("FraudDetector.clearBuiltInRules removes only the built-in rules", () => {
  const custom = () => ({ name: "custom_rule", triggered: true, weight: 10, reason: "custom" });

  test("a custom rule added BEFORE clearBuiltInRules() survives it", () => {
    const detector = new FraudDetector().addRule(custom).clearBuiltInRules();
    expect(detector.getRules()).toEqual(["custom_rule"]);
    expect(detector.check(makeCtx()).riskScore).toBe(10);
  });

  test("a custom rule added after it works too (the order does not matter)", () => {
    const detector = new FraudDetector().clearBuiltInRules().addRule(custom);
    expect(detector.getRules()).toEqual(["custom_rule"]);
  });
});

describe("FraudDetector — rule weights are validated, and a broken rule fails closed", () => {
  const rule = (weight: unknown, triggered = true) => () => ({ name: "custom", triggered, weight: weight as number, reason: "custom" });

  test.each([
    ["a NaN", Number.NaN],
    ["an Infinity", Number.POSITIVE_INFINITY],
    ["a negative (-1000)", -1000],
    ["an over-the-cap (101)", 101],
    ["a string", "40"],
  ])("addRule refuses %s weight (INVALID_CONFIG)", (_name, weight) => {
    expect(() => new FraudDetector().addRule(rule(weight))).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  test("a NaN weight that appears only for some payments declines instead of approving", () => {
    const detector = new FraudDetector().addRule((ctx) => ({
      name: "dynamic",
      triggered: true,
      weight: ctx.amount.amount > 1_000 ? Number.NaN : 5, // passes registration (probe amount 0)
      reason: "dynamic",
    }));
    const result = detector.check(makeCtx({ amount: { amount: 5_000, currency: "USD" } }));
    expect(result).toMatchObject({ riskScore: 100, riskLevel: "critical", recommendation: "decline" });
    expect(result.reasons).toEqual(['Rule "dynamic" returned an invalid weight NaN is not a finite number; failing closed']);
  });

  test("a dynamic negative weight cannot cancel real risk: it fails closed too", () => {
    const detector = new FraudDetector().addRule((ctx) => ({
      name: "discount",
      triggered: ctx.amount.amount > 1_000,
      weight: ctx.amount.amount > 1_000 ? -1_000 : 0,
      reason: "discount",
    }));
    expect(detector.check(makeCtx({ amount: { amount: 2_000_000, currency: "USD" } })).recommendation).toBe("decline");
  });

  test("a rule that returns no signal object fails closed instead of throwing", () => {
    const detector = new FraudDetector().addRule((ctx) => (ctx.amount.amount > 1_000 ? (undefined as never) : rule(1, false)()));
    const result = detector.check(makeCtx({ amount: { amount: 5_000, currency: "USD" } }));
    expect(result).toMatchObject({ recommendation: "decline", reasons: [expect.stringContaining("returned no signal object")] });
  });

  test("a rule that throws on the minimal registration context is still accepted, and valid weights score normally", () => {
    const detector = new FraudDetector()
      .clearBuiltInRules()
      .addRule((ctx) => ({ name: "needs_meta", triggered: ctx.metadata!.vip === "no", weight: 40, reason: "r" }))
      .addRule(rule(0));
    expect(detector.check({ ...makeCtx(), metadata: { vip: "no" } })).toMatchObject({ riskScore: 40, recommendation: "review" });
  });
});

describe("FraudDetector — a throwing rule or an unscoreable context fails closed, never open", () => {
  test("a rule that throws for a real payment declines that payment instead of aborting check()", () => {
    const detector = new FraudDetector().addRule((ctx) => {
      if (ctx.amount.amount > 1_000) throw new Error("risk service unavailable");
      return { name: "remote", triggered: false, weight: 0, reason: "" };
    });
    const result = detector.check(makeCtx({ amount: { amount: 5_000, currency: "USD" } }));
    expect(result).toMatchObject({ riskScore: 100, riskLevel: "critical", recommendation: "decline" });
    expect(result.reasons).toEqual([expect.stringMatching(/^Rule 7 threw \(risk service unavailable\); failing closed$/)]);
  });

  test("checkBatch: one throwing item fails closed, the others are still scored", () => {
    const detector = new FraudDetector().addRule((ctx) => {
      if (ctx.customerId === "cus_flaky") throw new Error("boom");
      return { name: "ok", triggered: false, weight: 0, reason: "" };
    });
    const results = detector.checkBatch([makeCtx(), makeCtx({ customerId: "cus_flaky" }), makeCtx()]);
    expect(results.map((r) => r.recommendation)).toEqual(["approve", "decline", "approve"]);
  });

  test.each([
    ["NaN", { amount: Number.NaN, currency: "USD" }],
    ["-5,000,000", { amount: -5_000_000, currency: "USD" }],
    ["Infinity", { amount: Number.POSITIVE_INFINITY, currency: "USD" }],
    ["49.99", { amount: 49.99, currency: "USD" }],
    ["an empty currency", { amount: 100, currency: "" }],
    ["no amount at all", undefined],
  ])("a context amount of %s declines, never approves", (_name, amount) => {
    const result = new FraudDetector().check(makeCtx({ amount: amount as FraudContext["amount"] }));
    expect(result).toMatchObject({ riskScore: 100, recommendation: "decline", reasons: [expect.stringContaining("Invalid fraud context")] });
  });

  test("a zero amount is a valid context and scores normally", () => {
    expect(new FraudDetector().check(makeCtx({ amount: { amount: 0, currency: "USD" } })).recommendation).toBe("approve");
  });
});

describe("FraudDetector — a risk input the rules cannot compare fails closed, never open", () => {
  // Every threshold comparison with NaN is false, so unchecked these inputs
  // would read as "no risk": an age computed from a missing date is NaN.
  const risky: Partial<FraudContext> = {
    amount: { amount: 150_000, currency: "USD" },
    isNewPaymentMethod: true,
  };

  test("NaN age and count cannot turn a decline into an approve", () => {
    const detector = new FraudDetector();
    expect(detector.check(makeCtx({ ...risky, accountAgeDays: 1, previousPaymentCount: 15 })).recommendation).toBe("decline");
    expect(detector.check(makeCtx({ ...risky, accountAgeDays: NaN, previousPaymentCount: NaN }))).toMatchObject({
      riskScore: 100,
      riskLevel: "critical",
      recommendation: "decline",
      reasons: [expect.stringContaining("accountAgeDays NaN")],
    });
  });

  test.each<[string, unknown]>([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["negative", -1],
    ["a numeric string", "30"],
    ["null", null],
  ])("accountAgeDays %s declines", (_name, accountAgeDays) => {
    const result = new FraudDetector().check(makeCtx({ accountAgeDays: accountAgeDays as number }));
    expect(result).toMatchObject({ riskScore: 100, recommendation: "decline", reasons: [expect.stringContaining("accountAgeDays")] });
  });

  test.each<[string, unknown]>([
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["negative", -1],
    ["fractional: it is a count", 1.5],
    ["beyond the safe integers", 2 ** 53],
    ["a numeric string", "3"],
    ["null", null],
  ])("previousPaymentCount %s declines", (_name, previousPaymentCount) => {
    const result = new FraudDetector().check(makeCtx({ previousPaymentCount: previousPaymentCount as number }));
    expect(result).toMatchObject({ riskScore: 100, recommendation: "decline", reasons: [expect.stringContaining("previousPaymentCount")] });
  });

  test("an unusual value of another type is reported, not thrown on", () => {
    const result = new FraudDetector().check(makeCtx({ accountAgeDays: Object.create(null) as number }));
    expect(result).toMatchObject({ recommendation: "decline", reasons: [expect.stringContaining("accountAgeDays")] });
  });

  test("checkBatch: a broken input declines that payment only", () => {
    const recommendations = new FraudDetector().checkBatch([makeCtx({ accountAgeDays: NaN }), makeCtx()]).map((r) => r.recommendation);
    expect(recommendations).toEqual(["decline", "approve"]);
  });

  test("absent signals are still allowed: the rule that reads one stays silent", () => {
    const result = new FraudDetector().check({ amount: { amount: 5000, currency: "USD" }, customerId: "c", userAgent: "x" });
    expect(result).toMatchObject({ riskScore: 0, recommendation: "approve", reasons: [] });
  });

  test("valid edge values score normally: age 0, a fractional age, count 0", () => {
    const detector = new FraudDetector();
    expect(detector.check(makeCtx({ accountAgeDays: 0 })).recommendation).toBe("approve");
    expect(detector.check(makeCtx({ accountAgeDays: 2.5, previousPaymentCount: 0 })).recommendation).toBe("approve");
    const signals = detector.check(makeCtx({ accountAgeDays: 2.5, amount: { amount: 60_000, currency: "USD" } })).signals;
    expect(signals.find((s) => s.name === "high_amount_new_account")?.triggered).toBe(true);
  });
});

describe("FraudDetector — a hard ceiling forces at least review, whatever the score", () => {
  const known = (amount: number, currency = "USD"): FraudContext => ({ amount: { amount, currency }, customerId: "c", userAgent: "x" });
  const CEILING_REASON = /over the review ceiling/;

  test.each([
    ["$10,000,000", 1_000_000_000, 30, "medium"],
    ["MAX_SAFE_INTEGER cents", Number.MAX_SAFE_INTEGER, 20, "low"],
  ])("a known customer at %s is not approved, and the score is left alone", (_name, amount, score, level) => {
    const result = new FraudDetector().check(known(amount));
    expect(result.recommendation).toBe("review");
    expect(result.riskScore).toBe(score);
    expect(result.riskLevel).toBe(level);
    expect(result.reasons.join()).toMatch(CEILING_REASON);
  });

  test("both sides of the default: exactly the ceiling is approved, one minor unit over is not", () => {
    expect(DEFAULT_REVIEW_AMOUNT_CEILING).toBe(10_000_000);
    const at = new FraudDetector().check(known(10_000_000));
    expect(at.recommendation).toBe("approve");
    expect(at.reasons.join()).not.toMatch(CEILING_REASON);
    const over = new FraudDetector().check(known(10_000_001));
    expect(over.recommendation).toBe("review");
    expect(over.reasons).toContain("Amount $100,000.01 is over the review ceiling of $100,000.00");
  });

  test("both sides of a configured ceiling", () => {
    const detector = new FraudDetector({ reviewAmountCeiling: 500_000 });
    expect(detector.check(known(500_000)).recommendation).toBe("approve");
    expect(detector.check(known(500_001)).recommendation).toBe("review");
  });

  test("it never lowers a verdict: a decline over the ceiling stays a decline, and says why", () => {
    const detector = new FraudDetector().addRule(() => ({ name: "blocked", triggered: true, weight: 90, reason: "blocked" }));
    const result = detector.check(known(10_000_001));
    expect(result.recommendation).toBe("decline");
    expect(result.reasons.join()).toMatch(CEILING_REASON);
  });

  test("a review already reached by score stays review, with the extra reason", () => {
    const result = new FraudDetector().check({ ...known(10_000_001), accountAgeDays: 1 });
    expect(result.riskScore).toBe(50);
    expect(result.recommendation).toBe("review");
    expect(result.reasons.join()).toMatch(CEILING_REASON);
  });

  test("it is not a rule: clearBuiltInRules leaves it, and it is not listed or signalled", () => {
    const detector = new FraudDetector().clearBuiltInRules();
    const result = detector.check(known(10_000_001));
    expect(result.riskScore).toBe(0);
    expect(result.recommendation).toBe("review");
    expect(detector.getRules()).toEqual([]);
    expect(result.signals).toEqual([]);
  });

  test("checkBatch applies it, and the reason speaks the payment's currency", () => {
    const [yen, small] = new FraudDetector().checkBatch([known(10_000_001, "JPY"), known(5_000)]);
    expect(yen.recommendation).toBe("review");
    expect(yen.reasons.join()).toContain("¥10,000,001");
    expect(small.recommendation).toBe("approve");
  });

  test("MAX_SAFE_INTEGER turns it off", () => {
    const detector = new FraudDetector({ reviewAmountCeiling: Number.MAX_SAFE_INTEGER });
    expect(detector.check(known(Number.MAX_SAFE_INTEGER)).recommendation).toBe("approve");
  });

  test.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [2 ** 53]])("reviewAmountCeiling %p is INVALID_CONFIG", (reviewAmountCeiling) => {
    expect(() => new FraudDetector({ reviewAmountCeiling })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
});

describe("FraudDetector — score boundaries, exactly", () => {
  const scoring = (...weights: number[]) => {
    const detector = new FraudDetector().clearBuiltInRules();
    weights.forEach((weight, i) => detector.addRule(() => ({ name: `w${i}`, triggered: true, weight, reason: "r" })));
    return detector.check({ amount: { amount: 100, currency: "USD" } });
  };

  test.each([
    [0, "low", "approve"],
    [24, "low", "approve"],
    [25, "medium", "approve"],
    [34, "medium", "approve"],
    [35, "medium", "review"],
    [49, "medium", "review"],
    [50, "high", "review"],
    [69, "high", "review"],
    [70, "high", "decline"],
    [79, "high", "decline"],
    [80, "critical", "decline"],
    [100, "critical", "decline"],
  ])("score %i is %s / %s", (weight, level, recommendation) => {
    expect(scoring(weight)).toMatchObject({ riskScore: weight, riskLevel: level, recommendation });
  });

  test("the score is capped at 100 however many rules trigger", () => {
    expect(scoring(100, 100, 40).riskScore).toBe(100);
  });

  test("the README states the thresholds the code applies", () => {
    const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
    const stated = /(\d+)\+ is `medium`, (\d+)\+ `high`, (\d+)\+ `critical`; (\d+)\+ recommends `review`,\s+(\d+)\+ `decline`/.exec(readme);
    if (!stated) throw new Error("the README does not state the score thresholds");
    const [medium, high, critical, review, decline] = stated.slice(1).map(Number);
    for (const [at, level] of [[medium, "medium"], [high, "high"], [critical, "critical"]] as const) {
      expect(scoring(at).riskLevel).toBe(level);
      expect(scoring(at - 1).riskLevel).not.toBe(level);
    }
    for (const [at, recommendation] of [[review, "review"], [decline, "decline"]] as const) {
      expect(scoring(at).recommendation).toBe(recommendation);
      expect(scoring(at - 1).recommendation).not.toBe(recommendation);
    }
  });
});

describe("FraudDetector — extreme velocity forces at least review, at any amount", () => {
  const CEILING_REASON = /over the review ceiling of/;
  // Card testing: $1, a day-old account, a new card, every optional rule quiet.
  const cardTest = (previousPaymentCount: number, overrides: Partial<FraudContext> = {}) =>
    makeCtx({ amount: { amount: 100, currency: "USD" }, accountAgeDays: 0, isNewPaymentMethod: true, previousPaymentCount, ...overrides });

  test("$1 with a count of 1,000 goes to review, not approve", () => {
    const result = new FraudDetector().check(cardTest(1000));
    expect(result.recommendation).toBe("review");
    expect(result.reasons).toContain("1000 payments in the caller-supplied velocity window is over the review ceiling of 50");
  });

  test("both sides of the default: exactly the ceiling is approved, one over is not", () => {
    const detector = new FraudDetector();
    expect(DEFAULT_REVIEW_VELOCITY_CEILING).toBe(50);
    const at = detector.check(cardTest(50));
    expect(at.recommendation).toBe("approve");
    expect(at.reasons.join(" ")).not.toMatch(CEILING_REASON);
    expect(detector.check(cardTest(51)).recommendation).toBe("review");
  });

  test.each([
    ["no charge at all", 0],
    ["$1", 100],
    ["$49", 4_900],
    ["$9,999", 999_900],
  ])("at any amount: %s", (_name, amount) => {
    // An established account and a saved card: only the count can raise this one.
    const known = makeCtx({ amount: { amount, currency: "USD" }, previousPaymentCount: 51 });
    expect(new FraudDetector().check(known).recommendation).toBe("review");
    expect(new FraudDetector().check({ ...known, previousPaymentCount: 50 }).recommendation).toBe("approve");
  });

  test("both sides of a configured ceiling", () => {
    const detector = new FraudDetector({ reviewVelocityCeiling: 20 });
    expect(detector.check(cardTest(20)).recommendation).toBe("approve");
    expect(detector.check(cardTest(21)).recommendation).toBe("review");
    expect(new FraudDetector({ reviewVelocityCeiling: 2000 }).check(cardTest(1000)).recommendation).toBe("approve");
  });

  test("it raises the recommendation only: score and level stay what the rules say", () => {
    const result = new FraudDetector().check(cardTest(1000));
    expect(result).toMatchObject({ riskScore: 20, riskLevel: "low" });
    expect(result.signals.filter((s) => s.triggered).map((s) => s.name)).toEqual(["high_velocity"]);
  });

  test("it never lowers a verdict: a decline over the ceiling stays a decline, and says why", () => {
    const result = new FraudDetector().check(makeCtx({ amount: { amount: 2_000_000, currency: "USD" }, isNewPaymentMethod: true, accountAgeDays: 0, userAgent: undefined, previousPaymentCount: 1000 }));
    expect(result.recommendation).toBe("decline");
    expect(result.reasons.join(" ")).toMatch(CEILING_REASON);
  });

  test("clearBuiltInRules() leaves it in place", () => {
    expect(new FraudDetector().clearBuiltInRules().check(cardTest(1000)).recommendation).toBe("review");
  });

  test("no count means no signal: the ceiling stays silent", () => {
    const result = new FraudDetector().check(makeCtx({ previousPaymentCount: undefined }));
    expect(result.recommendation).toBe("approve");
    expect(result.reasons).toEqual([]);
  });

  test("MAX_SAFE_INTEGER turns it off", () => {
    expect(new FraudDetector({ reviewVelocityCeiling: Number.MAX_SAFE_INTEGER }).check(cardTest(1000)).recommendation).toBe("approve");
  });

  test.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [2 ** 53]])("reviewVelocityCeiling %p is INVALID_CONFIG", (reviewVelocityCeiling) => {
    expect(() => new FraudDetector({ reviewVelocityCeiling })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG", message: expect.stringContaining("reviewVelocityCeiling") }));
  });

  test("the two ceilings are independent", () => {
    const detector = new FraudDetector({ reviewAmountCeiling: 1000, reviewVelocityCeiling: 20 });
    const both = detector.check(cardTest(21, { amount: { amount: 1001, currency: "USD" } }));
    expect(both.recommendation).toBe("review");
    expect(both.reasons.filter((r) => CEILING_REASON.test(r))).toHaveLength(2);
  });
});
