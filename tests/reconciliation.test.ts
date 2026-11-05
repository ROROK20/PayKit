/**
 * Tests for reconciliation engine.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import ts from "typescript";

import { ReconciliationEngine } from "../src/reconciliation/engine";
import { InternalRecord, PayKitError, ProviderRecord } from "../src/types";

function makeInternal(
  id: string,
  providerId: string,
  amount: number,
  date: Date = new Date("2024-01-15"),
): InternalRecord {
  return {
    id,
    providerPaymentId: providerId,
    amount: { amount, currency: "USD" },
    status: "succeeded",
    createdAt: date,
  };
}

function makeProvider(
  id: string,
  amount: number,
  date: Date = new Date("2024-01-15"),
): ProviderRecord {
  return {
    id,
    amount: { amount, currency: "USD" },
    status: "succeeded",
    createdAt: date,
  };
}

describe("ReconciliationEngine", () => {
  let engine: ReconciliationEngine;

  beforeEach(() => {
    engine = new ReconciliationEngine({ provider: "stripe" });
  });

  test("perfect match returns all matched", () => {
    const internal = [makeInternal("i1", "p1", 5000), makeInternal("i2", "p2", 3000)];
    const provider = [makeProvider("p1", 5000), makeProvider("p2", 3000)];
    const report = engine.reconcile(internal, provider);
    expect(report.matched).toBe(2);
    expect(report.unmatchedInternal).toBe(0);
    expect(report.unmatchedProvider).toBe(0);
  });

  test("unmatched internal record detected", () => {
    const internal = [
      makeInternal("i1", "p1", 5000),
      makeInternal("i2", "p_ghost", 3000), // ghost provider ID
    ];
    const provider = [makeProvider("p1", 5000)];
    const report = engine.reconcile(internal, provider);
    expect(report.unmatchedInternal).toBe(1);
  });

  test("unmatched provider record detected", () => {
    const internal = [makeInternal("i1", "p1", 5000)];
    const provider = [makeProvider("p1", 5000), makeProvider("p_phantom", 2500)];
    const report = engine.reconcile(internal, provider);
    expect(report.unmatchedProvider).toBe(1);
  });

  test("amount mismatch detected", () => {
    const internal = [makeInternal("i1", "p1", 5000)];
    const provider = [makeProvider("p1", 4999)]; // $0.01 off = mismatch beyond tolerance
    const strictEngine = new ReconciliationEngine({ provider: "stripe", toleranceAmount: 0 });
    const report = strictEngine.reconcile(internal, provider);
    expect(report.amountMismatches).toBe(1);
  });

  test("an opted-in tolerance still treats a difference within it as matched", () => {
    // Tolerance is opt-in: the default engine compares amounts exactly.
    const internal = [makeInternal("i1", "p1", 5001)];
    const provider = [makeProvider("p1", 5000)]; // 1 cent difference
    const tolerant = new ReconciliationEngine({ provider: "stripe", toleranceAmount: 1 });
    expect(tolerant.reconcile(internal, provider).matched).toBe(1);
  });

  test("empty inputs produce empty report", () => {
    const report = engine.reconcile([], []);
    expect(report.matched).toBe(0);
    expect(report.totalInternal).toBe(0);
    expect(report.totalProvider).toBe(0);
  });

  test("summary string is populated", () => {
    const internal = [makeInternal("i1", "p1", 5000)];
    const provider = [makeProvider("p1", 5000)];
    const report = engine.reconcile(internal, provider);
    expect(report.summary).toBeTruthy();
    expect(typeof report.summary).toBe("string");
  });

  test("perfect match summary indicates no issues", () => {
    const internal = [makeInternal("i1", "p1", 5000)];
    const provider = [makeProvider("p1", 5000)];
    const report = engine.reconcile(internal, provider);
    expect(report.summary.toLowerCase()).toContain("perfect");
  });

  test("report has run timestamp", () => {
    const report = engine.reconcile([], []);
    expect(report.runAt).toBeInstanceOf(Date);
  });

  test("duplicate records detected", () => {
    const sameDate = new Date("2024-01-15");
    // Two internal records with same amount and date and NO provider id =
    // potential duplicate. Records naming distinct provider ids are two charges
    // and are not flagged.
    const internal = [
      { ...makeInternal("i1", "", 5000, sameDate), providerPaymentId: undefined },
      { ...makeInternal("i2", "", 5000, sameDate), providerPaymentId: undefined },
    ];
    const provider = [makeProvider("p1", 5000, sameDate), makeProvider("p2", 5000, sameDate)];
    const report = engine.reconcile(internal, provider);
    // One of the matches should be flagged as duplicate
    const duplicates = report.matches.filter((m) => m.status === "duplicate");
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
  });
});

describe("ReconciliationEngine — status, double claims, dangling ids, summary, date window", () => {
  const day = new Date("2026-01-15T12:00:00Z");
  const usd = (amount: number) => ({ amount, currency: "USD" });
  const engine = new ReconciliationEngine({ provider: "stripe", fuzzyDate: true });

  test("an internal 'succeeded' against a provider 'failed' charge is a status_mismatch, not a match", () => {
    const report = engine.reconcile(
      [{ id: "i1", providerPaymentId: "pi_1", amount: usd(5000), status: "succeeded", createdAt: day }],
      [{ id: "pi_1", amount: usd(5000), status: "failed", createdAt: day }],
    );
    expect(report.matches[0]).toMatchObject({ internalId: "i1", providerId: "pi_1", status: "status_mismatch" });
    expect(report.matched).toBe(0);
    expect(report.statusMismatches).toBe(1);
    expect(report.summary).not.toMatch(/perfect/i);
    expect(report.summary).toBe("Matched 0/1. 1 status mismatch. Review required.");
  });

  test("status is compared by outcome: refunded vs refunded, cancelled vs 'canceled', case-insensitive", () => {
    // A ledger "refunded" against Stripe's "succeeded" is not a match: see the
    // "false all-clear" block below.
    const report = engine.reconcile(
      [
        { id: "i1", providerPaymentId: "pi_1", amount: usd(5000), status: "refunded", createdAt: day },
        { id: "i2", providerPaymentId: "pi_2", amount: usd(3000), status: "cancelled", createdAt: new Date("2026-01-16T12:00:00Z") },
        { id: "i3", providerPaymentId: "pi_3", amount: usd(2000), status: "pending", createdAt: new Date("2026-01-17T12:00:00Z") },
      ],
      [
        { id: "pi_1", amount: usd(5000), status: "Refunded", createdAt: day },
        { id: "pi_2", amount: usd(3000), status: "canceled", createdAt: day },
        { id: "pi_3", amount: usd(2000), status: "REQUIRES_PAYMENT_METHOD", createdAt: day },
      ],
    );
    expect(report.matches.map((m) => m.status)).toEqual(["matched", "matched", "matched"]);
  });

  test("an unknown provider status must match verbatim; otherwise it is flagged", () => {
    const report = engine.reconcile(
      [
        { id: "i1", providerPaymentId: "p_1", amount: usd(100), status: "succeeded", createdAt: day },
        { id: "i2", providerPaymentId: "p_2", amount: usd(200), status: "succeeded", createdAt: new Date("2026-01-20T12:00:00Z") },
      ],
      [
        { id: "p_1", amount: usd(100), status: "settled_by_bank", createdAt: day },
        { id: "p_2", amount: usd(200), status: "Succeeded", createdAt: day },
      ],
    );
    expect(report.matches.map((m) => m.status)).toEqual(["status_mismatch", "matched"]);
  });

  test("two internal records claiming one provider charge: the second is a duplicate, never a second match", () => {
    const report = engine.reconcile(
      [
        { id: "order_1", providerPaymentId: "pi_1", amount: usd(5000), status: "succeeded", createdAt: day },
        { id: "order_2", providerPaymentId: "pi_1", amount: usd(5000), status: "succeeded", createdAt: new Date("2026-01-18T12:00:00Z") },
      ],
      [{ id: "pi_1", amount: usd(5000), status: "succeeded", createdAt: day }],
    );
    expect(report.matched).toBe(1);
    expect(report.matches[1]).toMatchObject({ internalId: "order_2", providerId: "pi_1", status: "duplicate", duplicate: true });
    expect(report.matches[1].notes).toContain("already matched to internal record order_1");
    expect(report.summary).toBe("Matched 1/2. 1 possible duplicate. Review required.");
  });

  test("an id the provider does not have is unmatched — never fuzzy-matched to a different charge", () => {
    const report = engine.reconcile(
      [{ id: "i1", providerPaymentId: "pi_GONE", amount: usd(5000), status: "succeeded", createdAt: day }],
      [{ id: "pi_OTHER", amount: usd(5000), status: "succeeded", createdAt: day }],
    );
    expect(report.matched).toBe(0);
    expect(report.matches).toEqual([
      expect.objectContaining({ internalId: "i1", status: "unmatched_internal", notes: expect.stringContaining("pi_GONE") }),
      expect.objectContaining({ providerId: "pi_OTHER", status: "unmatched_provider" }),
    ]);
  });

  test("control: a record WITHOUT a provider id still fuzzy-matches by amount + date", () => {
    const report = engine.reconcile(
      [{ id: "i1", amount: usd(5000), status: "succeeded", createdAt: day }],
      [{ id: "pi_X", amount: usd(5000), status: "succeeded", createdAt: new Date(day.getTime() + 3_600_000) }],
    );
    expect(report.matches[0]).toMatchObject({ internalId: "i1", providerId: "pi_X", status: "matched" });
  });

  test("a possible duplicate prevents a 'Perfect reconciliation' summary", () => {
    // Records without provider ids: their pairing to p1/p2 is by amount only,
    // so the same-day twin is a real double-submit candidate.
    const report = engine.reconcile(
      [
        { id: "i1", amount: usd(5000), status: "succeeded", createdAt: day },
        { id: "i2", amount: usd(5000), status: "succeeded", createdAt: day },
      ],
      [
        { id: "p1", amount: usd(5000), status: "succeeded", createdAt: day },
        { id: "p2", amount: usd(5000), status: "succeeded", createdAt: day },
      ],
    );
    expect(report.duplicates).toBe(1);
    expect(report.summary).not.toMatch(/perfect/i);
    expect(report.summary).toBe("Matched 1/2. 1 possible duplicate. Review required.");
  });

  test("fuzzyDate is the documented ±1 day: 23h apart matches, 36h apart does not", () => {
    const at = (hours: number) => new Date(day.getTime() + hours * 3_600_000);
    const near = engine.reconcile(
      [{ id: "i1", amount: usd(5000), status: "succeeded", createdAt: day }],
      [{ id: "p1", amount: usd(5000), status: "succeeded", createdAt: at(23) }],
    );
    const far = engine.reconcile(
      [{ id: "i1", amount: usd(5000), status: "succeeded", createdAt: day }],
      [{ id: "p1", amount: usd(5000), status: "succeeded", createdAt: at(36) }],
    );
    expect(near.matched).toBe(1);
    expect(far.matched).toBe(0);
    expect(far.unmatchedInternal).toBe(1);
  });
});

describe("ReconciliationEngine — amounts match exactly by default", () => {
  const at = new Date("2026-11-01T12:00:00Z");
  const usd = (amount: number) => ({ amount, currency: "USD" });

  test("a 1-cent shortfall is an amount_mismatch, never 'Perfect' — the README example reproduces", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
      [{ id: "i_abc", providerPaymentId: "pi_xyz", amount: usd(5000), status: "succeeded", createdAt: at }],
      [{ id: "pi_xyz", amount: usd(4999), status: "succeeded", createdAt: at }],
    );
    expect(report.matches[0]).toEqual({
      internalId: "i_abc",
      providerId: "pi_xyz",
      status: "amount_mismatch",
      amountDiscrepancy: usd(1),
      notes: "Amount mismatch: internal=5000 provider=4999.",
    });
    expect(report.summary).toBe("Matched 0/1. 1 amount mismatch. Review required.");
  });

  test("fuzzy matching is exact too: a record with no provider id does not pair with a charge 1 cent off", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
      [{ id: "i1", amount: usd(5000), status: "succeeded", createdAt: at }],
      [{ id: "pi_1", amount: usd(4999), status: "succeeded", createdAt: at }],
    );
    expect(report.matched).toBe(0);
    expect(report.unmatchedInternal).toBe(1);
    expect(report.unmatchedProvider).toBe(1);
  });

  test.each([Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY])(
    "toleranceAmount %p is rejected (a NaN tolerance would match every amount)",
    (toleranceAmount) => {
      const build = () => new ReconciliationEngine({ provider: "stripe", toleranceAmount });
      expect(build).toThrow(PayKitError);
      expect(build).toThrow(/toleranceAmount must be a non-negative integer/);
    },
  );
});

describe("ReconciliationEngine — the duplicate heuristic is deterministic and never second-guesses an identified charge", () => {
  const usd = (amount: number) => ({ amount, currency: "USD" });
  const rec = (id: string, providerPaymentId: string | undefined, iso: string): InternalRecord => ({
    id,
    providerPaymentId,
    amount: usd(2900),
    status: "succeeded",
    createdAt: new Date(iso),
  });
  const charge = (id: string, iso: string): ProviderRecord => ({
    id,
    amount: usd(2900),
    status: "succeeded",
    createdAt: new Date(iso),
  });

  test("two customers who each matched their own charge on the same day are both matched, not duplicates", () => {
    // Same calendar day in every time zone, so wherever this runs the heuristic
    // has its chance to demote the second record to `duplicate`, and must not.
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
      [rec("ord_A", "pi_A", "2026-11-01T12:00:00Z"), rec("ord_B", "pi_B", "2026-11-01T12:30:00Z")],
      [charge("pi_A", "2026-11-01T12:00:00Z"), charge("pi_B", "2026-11-01T12:30:00Z")],
    );
    expect(report.matches.map((m) => [m.internalId, m.status, m.duplicate])).toEqual([
      ["ord_A", "matched", undefined],
      ["ord_B", "matched", undefined],
    ]);
    expect(report.summary).toBe("Perfect reconciliation: all 2 records matched.");
  });

  test("an id-less record sharing amount and day with an identified one is still flagged; the identified one is not", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
      [rec("ord_A", "pi_A", "2026-11-01T12:00:00Z"), rec("ord_A_resubmit", undefined, "2026-11-01T12:05:00Z")],
      [charge("pi_A", "2026-11-01T12:00:00Z"), charge("pi_X", "2026-11-01T12:05:00Z")],
    );
    expect(report.matches.find((m) => m.internalId === "ord_A")).toMatchObject({ status: "matched" });
    expect(report.matches.find((m) => m.internalId === "ord_A_resubmit")).toMatchObject({
      status: "duplicate",
      duplicate: true,
    });
  });

  test("verdicts are identical under four server time zones (UTC days, not local days)", () => {
    // process.env.TZ cannot be switched inside a Jest test (Jest sandboxes
    // process.env, so the assignment never reaches Node), so each zone runs
    // in a fresh Node process against the engine source, transpiled once here.
    const scenarios = {
      // repro2: identified charges either side of Los Angeles midnight.
      identified: {
        internal: [rec("ord_A", "pi_A", "2026-11-01T07:30:00Z"), rec("ord_B", "pi_B", "2026-11-01T06:30:00Z")],
        provider: [charge("pi_A", "2026-11-01T07:30:00Z"), charge("pi_B", "2026-11-01T06:30:00Z")],
      },
      // Same UTC day, different Los Angeles days → one possible duplicate.
      sameUtcDay: {
        internal: [rec("i1", undefined, "2026-11-01T06:30:00Z"), rec("i2", undefined, "2026-11-01T07:30:00Z")],
        provider: [charge("p1", "2026-11-01T06:30:00Z"), charge("p2", "2026-11-01T07:30:00Z")],
      },
      // Different UTC days, same Los Angeles day → no duplicate.
      differentUtcDays: {
        internal: [rec("i1", undefined, "2026-11-01T23:30:00Z"), rec("i2", undefined, "2026-11-02T00:30:00Z")],
        provider: [charge("p1", "2026-11-01T23:30:00Z"), charge("p2", "2026-11-02T00:30:00Z")],
      },
    };
    const child = `
      const { ReconciliationEngine } = require(process.argv[1]);
      const revive = (rs) => rs.map((r) => ({ ...r, createdAt: new Date(r.createdAt) }));
      const out = { localDay: new Date("2026-11-01T06:30:00Z").toDateString() };
      for (const [name, s] of Object.entries(JSON.parse(process.argv[2]))) {
        const r = new ReconciliationEngine({ provider: "stripe" }).reconcile(revive(s.internal), revive(s.provider));
        out[name] = { duplicates: r.duplicates, summary: r.summary };
      }
      process.stdout.write(JSON.stringify(out));`;
    // The engine and the one module it imports, as CommonJS in a temp dir.
    const build = fs.mkdtempSync(path.join(os.tmpdir(), "paykit-tz-"));
    for (const rel of ["reconciliation/engine", "types/index"]) {
      const source = fs.readFileSync(path.join(__dirname, "../src", `${rel}.ts`), "utf8");
      const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
      }).outputText;
      fs.mkdirSync(path.join(build, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(build, `${rel}.js`), js);
    }
    const run = (tz: string) =>
      JSON.parse(
        execFileSync(process.execPath, ["-e", child, path.join(build, "reconciliation/engine.js"), JSON.stringify(scenarios)], {
          env: { ...process.env, TZ: tz },
          encoding: "utf8",
        }),
      );

    const zones = ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Pacific/Pago_Pago"];
    let results: Array<Record<string, { duplicates: number; summary: string } | string>>;
    try {
      results = zones.map(run);
    } finally {
      fs.rmSync(build, { recursive: true, force: true });
    }

    // Guard against a vacuous pass: each child really ran in its zone.
    expect(results.map((r) => r.localDay)).toEqual([
      "Sun Nov 01 2026",
      "Sat Oct 31 2026",
      "Sun Nov 01 2026",
      "Sat Oct 31 2026",
    ]);
    for (const r of results) {
      expect(r.identified).toEqual({ duplicates: 0, summary: "Perfect reconciliation: all 2 records matched." });
      expect(r.sameUtcDay).toEqual({ duplicates: 1, summary: "Matched 1/2. 1 possible duplicate. Review required." });
      expect(r.differentUtcDays).toEqual({ duplicates: 0, summary: "Perfect reconciliation: all 2 records matched." });
    }
  });
});

describe("ReconciliationEngine — currency codes compare case-insensitively (Stripe returns lower case)", () => {
  const at = new Date("2026-11-01T12:00:00Z");
  const money = (amount: number, currency: string) => ({ amount, currency });
  const engine = new ReconciliationEngine({ provider: "stripe" });

  test("an internal 'USD' against a raw Stripe 'usd' row of the same amount is matched", () => {
    const report = engine.reconcile(
      [{ id: "i1", providerPaymentId: "pi_1", amount: money(5000, "USD"), status: "succeeded", createdAt: at }],
      [{ id: "pi_1", amount: money(5000, "usd"), status: "succeeded", createdAt: at }],
    );
    expect(report.matches[0].status).toBe("matched");
    expect(report.summary).toBe("Perfect reconciliation: all 1 records matched.");
  });

  test("an amount difference across letter case is an amount_mismatch, reported in upper case", () => {
    const report = engine.reconcile(
      [{ id: "i1", providerPaymentId: "pi_1", amount: money(5000, "USD"), status: "succeeded", createdAt: at }],
      [{ id: "pi_1", amount: money(4500, "usd"), status: "succeeded", createdAt: at }],
    );
    expect(report.matches[0]).toMatchObject({ status: "amount_mismatch", amountDiscrepancy: money(500, "USD") });
  });

  test("fuzzy matching ignores letter case too", () => {
    const report = engine.reconcile(
      [{ id: "i1", amount: money(5000, "USD"), status: "succeeded", createdAt: at }],
      [{ id: "pi_1", amount: money(5000, "usd"), status: "succeeded", createdAt: at }],
    );
    expect(report.matches[0]).toMatchObject({ internalId: "i1", providerId: "pi_1", status: "matched" });
  });

  test("the duplicate heuristic groups 'USD' and 'usd' together", () => {
    const report = engine.reconcile(
      [
        { id: "i1", amount: money(5000, "USD"), status: "succeeded", createdAt: at },
        { id: "i2", amount: money(5000, "usd"), status: "succeeded", createdAt: at },
      ],
      [
        { id: "pi_1", amount: money(5000, "usd"), status: "succeeded", createdAt: at },
        { id: "pi_2", amount: money(5000, "usd"), status: "succeeded", createdAt: at },
      ],
    );
    expect(report.duplicates).toBe(1);
  });

  test("control: a genuinely different currency is still a currency_mismatch, with the raw codes in the note", () => {
    const report = engine.reconcile(
      [{ id: "i1", providerPaymentId: "pi_1", amount: money(5000, "EUR"), status: "succeeded", createdAt: at }],
      [{ id: "pi_1", amount: money(5000, "usd"), status: "succeeded", createdAt: at }],
    );
    expect(report.matches[0]).toMatchObject({ status: "currency_mismatch", notes: "Currency mismatch: internal=EUR provider=usd." });
  });
});

describe("ReconciliationEngine — fuzzy matching is an optimal, order-independent assignment", () => {
  const H = 3_600_000;
  const T0 = Date.UTC(2026, 0, 1, 12);
  const idless = (id: string, hours: number, amount = 5000): InternalRecord => ({
    id,
    amount: { amount, currency: "USD" },
    status: "succeeded",
    createdAt: new Date(T0 + hours * H),
  });
  const prov = (id: string, hours: number, amount = 5000): ProviderRecord => ({
    id,
    amount: { amount, currency: "usd" },
    status: "succeeded",
    createdAt: new Date(T0 + hours * H),
  });
  // A pair is any match carrying both ids: id-less records sharing an amount
  // and UTC day are also annotated as possible duplicates (status
  // "duplicate"), which is orthogonal to how they were paired.
  const paired = (report: ReturnType<ReconciliationEngine["reconcile"]>) =>
    report.matches.filter((m) => m.internalId !== undefined && m.providerId !== undefined);
  const pairs = (report: ReturnType<ReconciliationEngine["reconcile"]>) =>
    paired(report)
      .map((m) => `${m.internalId}-${m.providerId}`)
      .sort();
  const fuzzy = () => new ReconciliationEngine({ provider: "stripe", fuzzyDate: true });

  function permutations<T>(xs: T[]): T[][] {
    if (xs.length <= 1) return [xs];
    return xs.flatMap((x, k) => permutations([...xs.slice(0, k), ...xs.slice(k + 1)]).map((rest) => [x, ...rest]));
  }

  test("A 0h, B +40h vs P1 +20h, P2 -20h pairs A-P2 and B-P1 (first-fit would strand B and P2)", () => {
    const report = fuzzy().reconcile([idless("A", 0), idless("B", 40)], [prov("P1", 20), prov("P2", -20)]);
    expect(pairs(report)).toEqual(["A-P2", "B-P1"]);
    expect(report.summary).toBe("Perfect reconciliation: all 2 records matched.");
  });

  test("closest-first is not enough either: A 0h, B +30h vs P1 +10h, P2 -14h matches both", () => {
    // Closest pair first (A-P1, 10h) would strand B; the optimum pairs A-P2 and B-P1.
    const report = fuzzy().reconcile([idless("A", 0), idless("B", 30)], [prov("P1", 10), prov("P2", -14)]);
    expect(pairs(report)).toEqual(["A-P2", "B-P1"]);
  });

  test("when one record fits two charges, the closer charge wins whatever the input order", () => {
    for (const order of permutations([prov("P_far", -20), prov("P_near", 1)])) {
      const report = fuzzy().reconcile([idless("A", 0)], order);
      expect(pairs(report)).toEqual(["A-P_near"]);
      expect(report.matches.find((m) => m.status === "unmatched_provider")?.providerId).toBe("P_far");
    }
  });

  test("every permutation of both inputs yields the same pairing", () => {
    const internal = [idless("A", 0), idless("B", 40), idless("C", 12), idless("D", 5, 9900)];
    const provider = [prov("P1", 20), prov("P2", -20), prov("P3", 13), prov("P4", 20, 9900)];
    const expected = pairs(fuzzy().reconcile(internal, provider));
    expect(expected).toHaveLength(4);
    for (const ints of permutations(internal)) {
      for (const provs of permutations(provider)) {
        expect(pairs(fuzzy().reconcile(ints, provs))).toEqual(expected);
      }
    }
  });

  test("matches brute force on 300 seeded random instances: the most pairs, then the least total time distance", () => {
    let seed = 20261101;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const engine = fuzzy();
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(rand() * 4);
      const m = 1 + Math.floor(rand() * 4);
      const amount = () => (rand() < 0.75 ? 5000 : 7500);
      const ints = Array.from({ length: n }, (_, k) => idless(`I${k}`, Math.round(rand() * 96) - 48, amount()));
      const provs = Array.from({ length: m }, (_, k) => prov(`P${k}`, Math.round(rand() * 96) - 48, amount()));
      const eligible = (a: InternalRecord, b: ProviderRecord) =>
        a.amount.amount === b.amount.amount &&
        Math.abs(a.createdAt.getTime() - b.createdAt.getTime()) <= 86_400_000;
      // Brute force: every partial injective assignment internal -> provider.
      let best = { count: -1, cost: Infinity };
      const search = (i: number, used: Set<number>, count: number, cost: number) => {
        if (i === n) {
          if (count > best.count || (count === best.count && cost < best.cost)) best = { count, cost };
          return;
        }
        search(i + 1, used, count, cost);
        for (let j = 0; j < m; j++) {
          if (used.has(j) || !eligible(ints[i], provs[j])) continue;
          used.add(j);
          search(i + 1, used, count + 1, cost + Math.abs(ints[i].createdAt.getTime() - provs[j].createdAt.getTime()));
          used.delete(j);
        }
      };
      search(0, new Set(), 0, 0);

      const report = engine.reconcile(ints, provs);
      const matched = paired(report);
      const cost = matched.reduce((sum, x) => {
        const a = ints.find((r) => r.id === x.internalId)!;
        const b = provs.find((r) => r.id === x.providerId)!;
        expect(eligible(a, b)).toBe(true);
        return sum + Math.abs(a.createdAt.getTime() - b.createdAt.getTime());
      }, 0);
      expect({ run, count: matched.length, cost }).toEqual({ run, count: best.count, cost: best.cost });
    }
  });

  test("without fuzzyDate only identical timestamps pair, still order-independently", () => {
    const engine = new ReconciliationEngine({ provider: "stripe" });
    const report = engine.reconcile([idless("A", 0), idless("B", 1)], [prov("P1", 1), prov("P2", 0), prov("P3", 2)]);
    expect(pairs(report)).toEqual(["A-P2", "B-P1"]);
  });
});

describe("ReconciliationEngine — balance-transaction availability is not a payment outcome", () => {
  const at = new Date("2026-11-01T10:00:00Z");
  const internal = (status: InternalRecord["status"]): InternalRecord => ({
    id: "i",
    providerPaymentId: "pi_1",
    amount: { amount: 100, currency: "USD" },
    status,
    createdAt: at,
  });
  const record = (status: string): ProviderRecord => ({ id: "pi_1", amount: { amount: 100, currency: "usd" }, status, createdAt: at });

  test.each(["pending", "available", "AVAILABLE"])(
    "providerRecordType balance_transaction: a succeeded charge against a %s balance transaction is matched",
    (btStatus) => {
      const report = new ReconciliationEngine({ provider: "stripe", providerRecordType: "balance_transaction" }).reconcile(
        [internal("succeeded")],
        [record(btStatus)],
      );
      expect(report.matches[0].status).toBe("matched");
      expect(report.summary).toBe("Perfect reconciliation: all 1 records matched.");
    },
  );

  test("balance_transaction mode: an internal record still pending against money that moved is a status_mismatch", () => {
    const report = new ReconciliationEngine({ provider: "stripe", providerRecordType: "balance_transaction" }).reconcile(
      [internal("pending")],
      [record("pending")],
    );
    expect(report.matches[0]).toMatchObject({ status: "status_mismatch", notes: "Status mismatch: internal=pending provider=pending." });
  });

  test("the default (payment) reading is unchanged: provider pending means not paid, so succeeded vs pending is a mismatch", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile([internal("succeeded")], [record("pending")]);
    expect(report.matches[0].status).toBe("status_mismatch");
  });

  test("an unknown providerRecordType is rejected with INVALID_CONFIG", () => {
    expect(
      () => new ReconciliationEngine({ provider: "stripe", providerRecordType: "payout" as unknown as "payment" }),
    ).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
});

describe("ReconciliationEngine — a record with an unusable amount is reported invalid, never matched", () => {
  const at = new Date("2026-11-02T10:00:00Z");
  const internal = (amount: unknown, extra: Record<string, unknown> = {}): InternalRecord =>
    ({ id: "i1", providerPaymentId: "pi_1", amount: { amount, currency: "USD" }, status: "succeeded", createdAt: at, ...extra }) as unknown as InternalRecord;
  const provider = (amount: unknown, extra: Record<string, unknown> = {}): ProviderRecord =>
    ({ id: "pi_1", amount: { amount, currency: "usd" }, status: "succeeded", createdAt: at, ...extra }) as unknown as ProviderRecord;
  const engine = () => new ReconciliationEngine({ provider: "stripe" });

  test.each([
    ["NaN", Number.NaN],
    ["undefined", undefined],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a non-integer", 1.5],
    ["past MAX_SAFE_INTEGER", 2 ** 53 + 2],
    ["a numeric string", "999999"],
  ])("internal amount %s vs a real provider charge: invalid, not matched, never Perfect", (_name, bad) => {
    const report = engine().reconcile([internal(bad)], [provider(999999)]);
    expect(report.matches.find((m) => m.internalId === "i1")).toMatchObject({ status: "invalid" });
    expect(report.matches.find((m) => m.providerId === "pi_1")).toMatchObject({ status: "unmatched_provider" });
    expect(report).toMatchObject({ matched: 0, invalid: 1 });
    expect(report.summary).not.toMatch(/Perfect/);
    expect(report.summary).toMatch(/1 invalid record not reconciled/);
  });

  test.each([
    ["NaN", Number.NaN],
    ["undefined", undefined],
    ["Infinity", Number.NEGATIVE_INFINITY],
    ["a non-integer", 49.99],
  ])("provider amount %s: invalid, and the internal record that names it says so", (_name, bad) => {
    const report = engine().reconcile([internal(4999)], [provider(bad)]);
    expect(report.matches.find((m) => m.providerId === "pi_1")).toMatchObject({ status: "invalid" });
    expect(report.matches.find((m) => m.internalId === "i1")).toMatchObject({
      status: "unmatched_internal",
      notes: expect.stringContaining("is in the provider records but invalid"),
    });
    expect(report.summary).not.toMatch(/Perfect/);
  });

  test("both sides invalid: two invalid entries, nothing matched", () => {
    const report = engine().reconcile([internal(Number.NaN)], [provider(undefined)]);
    expect(report.matches.map((m) => m.status).sort()).toEqual(["invalid", "invalid"]);
    expect(report).toMatchObject({ matched: 0, invalid: 2 });
  });

  test.each([
    ["a malformed currency", internal(100, { amount: { amount: 100, currency: "usd " } })],
    ["a missing amount object", internal(100, { amount: undefined })],
    ["a missing id", internal(100, { id: "" })],
    ["a non-string status", internal(100, { status: undefined })],
    ["a non-Date createdAt", internal(100, { createdAt: "2026-11-02" })],
    ["a non-string providerPaymentId", internal(100, { providerPaymentId: 42 })],
  ])("an internal record with %s is invalid", (_name, record) => {
    const report = engine().reconcile([record], [provider(100)]);
    expect(report.invalid).toBe(1);
    expect(report.matched).toBe(0);
  });

  test("fuzzy matching (id-less records) never pairs an invalid amount either", () => {
    const idless = { id: "i_fz", amount: { amount: Number.NaN, currency: "USD" }, status: "succeeded", createdAt: at } as InternalRecord;
    const report = new ReconciliationEngine({ provider: "stripe", fuzzyDate: true }).reconcile([idless], [provider(5000)]);
    expect(report.matches.find((m) => m.internalId === "i_fz")).toMatchObject({ status: "invalid" });
    expect(report.matched).toBe(0);
  });

  test("valid records in the same run still reconcile normally; negative and zero amounts are valid", () => {
    const report = engine().reconcile(
      [internal(4999), { ...internal(-500), id: "i_refund", providerPaymentId: "re_1" }, { ...internal(Number.NaN), id: "i_bad" }],
      [provider(4999), { ...provider(-500), id: "re_1" }],
    );
    expect(report).toMatchObject({ matched: 2, invalid: 1 });
  });
});

describe("ReconciliationEngine — the possible-duplicate flag lands on the reconciled row, not on a repeated id's", () => {
  const at = new Date("2026-11-02T10:00:00Z");
  const rec = (id: string, providerPaymentId?: string): InternalRecord => ({ id, providerPaymentId, amount: { amount: 100, currency: "USD" }, status: "succeeded", createdAt: at });
  const prov = (id: string): ProviderRecord => ({ id, amount: { amount: 100, currency: "usd" }, status: "succeeded", createdAt: at });
  const FLAG = "possible duplicate payment detected";

  test("the fuzzy match is flagged, the repeated-id entry is left as it was", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile([rec("x", "pi_1"), rec("a"), rec("a")], [prov("pi_1"), prov("pi_2")]);
    const rows = report.matches.filter((m) => m.internalId === "a");
    expect(rows).toHaveLength(2);
    const reconciled = rows.find((m) => m.providerId === "pi_2")!;
    const repeated = rows.find((m) => m.providerId === undefined)!;
    expect(reconciled).toMatchObject({ status: "duplicate", duplicate: true, notes: expect.stringContaining(FLAG) });
    expect(repeated).toMatchObject({ status: "duplicate", duplicate: true, notes: expect.stringContaining("more than once") });
    expect(repeated.notes).not.toContain(FLAG);
    expect(report).toMatchObject({ matched: 1, duplicates: 2 });
    expect(report.summary).toBe("Matched 1/3. 2 possible duplicates. Review required.");
  });

  test("a flagged record with no charge keeps its status and gains the flag on its own row", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile([rec("x", "pi_1"), rec("a"), rec("a")], [prov("pi_1")]);
    const unmatched = report.matches.find((m) => m.internalId === "a" && m.status === "unmatched_internal");
    expect(unmatched).toMatchObject({ duplicate: true, notes: expect.stringContaining(FLAG) });
    expect(report.unmatchedInternal).toBe(1);
  });
});

describe("ReconciliationEngine — a provider id that appears twice is reported, never silently dropped", () => {
  const at = new Date("2026-11-02T10:00:00Z");
  const internal: InternalRecord = { id: "i1", providerPaymentId: "pi_1", amount: { amount: 100, currency: "USD" }, status: "succeeded", createdAt: at };
  const prov = (amount: number): ProviderRecord => ({ id: "pi_1", amount: { amount, currency: "usd" }, status: "succeeded", createdAt: at });

  test("a second pi_1 for 5000 is a duplicate entry, and the run is not Perfect", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile([internal], [prov(100), prov(5000)]);
    expect(report.totalProvider).toBe(2);
    expect(report.matches).toHaveLength(2);
    expect(report.matches.find((m) => m.status === "matched")).toMatchObject({ internalId: "i1", providerId: "pi_1" });
    expect(report.matches.find((m) => m.status === "duplicate")).toMatchObject({
      providerId: "pi_1",
      duplicate: true,
      notes: expect.stringContaining("this record (5000 USD, succeeded) was not reconciled — the first (100 USD, succeeded) was"),
    });
    expect(report.duplicates).toBe(1);
    expect(report.summary).not.toMatch(/Perfect/);
  });

  test("an exact duplicate row (same amount) is reported too", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile([internal], [prov(100), prov(100)]);
    expect(report.duplicates).toBe(1);
    expect(report.summary).toMatch(/1 possible duplicate/);
  });
});

describe("ReconciliationEngine — an internal id that appears twice is reported, never silently matched", () => {
  const d = new Date("2026-11-01T10:00:00Z");
  const m = (amount: number) => ({ amount, currency: "USD" });

  test("ord_1 booked twice against pi_A and pi_B is not Perfect", () => {
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
      [
        { id: "ord_1", providerPaymentId: "pi_A", amount: m(5000), status: "succeeded", createdAt: d },
        { id: "ord_1", providerPaymentId: "pi_B", amount: m(5000), status: "succeeded", createdAt: d, reference: "INV-9" },
      ],
      [
        { id: "pi_A", amount: m(5000), status: "succeeded", createdAt: d },
        { id: "pi_B", amount: m(5000), status: "succeeded", createdAt: d },
      ],
    );
    expect(report.summary).not.toMatch(/Perfect/);
    expect(report.matches.find((x) => x.status === "duplicate")).toMatchObject({
      internalId: "ord_1",
      duplicate: true,
      notes: expect.stringContaining("this record (5000 USD, pi_B, reference INV-9) was not reconciled — the first (5000 USD, pi_A) was"),
    });
    // The charge the duplicate pointed at is surfaced, not quietly absorbed.
    expect(report.matches.find((x) => x.providerId === "pi_B")).toMatchObject({ status: "unmatched_provider" });
    expect(report).toMatchObject({ matched: 1, duplicates: 1, unmatchedProvider: 1 });
  });
});

describe("ReconciliationEngine — a false all-clear is never reported", () => {
  const day = new Date("2026-11-02T12:00:00Z");
  const usd = (amount: number) => ({ amount, currency: "USD" });
  const engine = () => new ReconciliationEngine({ provider: "stripe" });
  const pair = (internal: InternalRecord["status"], provider: string) =>
    engine().reconcile(
      [{ id: "i1", providerPaymentId: "pi_1", amount: usd(5000), status: internal, createdAt: day }],
      [{ id: "pi_1", amount: usd(5000), status: provider, createdAt: day }],
    );

  describe("a status disagreement is a mismatch", () => {
    test("ledger refunded vs Stripe succeeded (the refund may never have happened)", () => {
      const report = pair("refunded", "succeeded");
      expect(report.matches[0].status).toBe("status_mismatch");
      expect(report.matches[0].notes).toContain("Status mismatch: internal=refunded provider=succeeded.");
      expect(report.matches[0].notes).toContain("Confirm the refund itself");
      expect(report.summary).toBe("Matched 0/1. 1 status mismatch. Review required.");
      expect(report.outcome).toBe("review_required");
    });

    test("ledger succeeded vs provider refunded (a refund the ledger never heard of)", () => {
      const report = pair("succeeded", "refunded");
      expect(report.matches[0].status).toBe("status_mismatch");
      expect(report.matches[0].notes).toContain("The provider shows a refund the ledger has not recorded.");
      expect(report.summary).not.toMatch(/Perfect/);
    });

    test.each([
      ["partially_refunded", "succeeded"],
      ["succeeded", "partially_refunded"],
      ["refunded", "partially_refunded"],
      ["partially_refunded", "refunded"],
      ["refunded", "failed"],
      ["pending", "succeeded"],
      ["succeeded", "pending"],
      ["processing", "paid"],
      ["succeeded", "requires_capture"],
      ["failed", "succeeded"],
    ] as const)("ledger %s vs provider %s", (internal, provider) => {
      const report = pair(internal, provider);
      expect(report.matches[0].status).toBe("status_mismatch");
      expect(report.statusMismatches).toBe(1);
      expect(report.outcome).toBe("review_required");
      expect(report.summary).not.toMatch(/Perfect/);
    });

    test("balance-transaction mode: a refunded ledger row against 'available' is a mismatch too", () => {
      const report = new ReconciliationEngine({ provider: "stripe", providerRecordType: "balance_transaction" }).reconcile(
        [{ id: "i1", providerPaymentId: "pi_1", amount: usd(5000), status: "refunded", createdAt: day }],
        [{ id: "pi_1", amount: usd(5000), status: "available", createdAt: day }],
      );
      expect(report.matches[0].status).toBe("status_mismatch");
    });

    test.each([
      ["refunded", "refunded"],
      ["succeeded", "paid"],
      ["cancelled", "failed"],
      ["processing", "requires_capture"],
    ] as const)("control: ledger %s vs provider %s agree", (internal, provider) => {
      const report = pair(internal, provider);
      expect(report.matches[0].status).toBe("matched");
      expect(report.outcome).toBe("perfect");
      expect(report.summary).toBe("Perfect reconciliation: all 1 records matched.");
    });

    test("control: ledger partially_refunded vs provider partially_refunded agree when both state the same total", () => {
      const report = engine().reconcile(
        [{ id: "i1", providerPaymentId: "pi_1", amount: usd(5000), status: "partially_refunded", amountRefunded: 1000, createdAt: day }],
        [{ id: "pi_1", amount: usd(5000), status: "partially_refunded", amountRefunded: 1000, createdAt: day }],
      );
      expect(report.matches[0].status).toBe("matched");
      expect(report.outcome).toBe("perfect");
      expect(report.summary).toBe("Perfect reconciliation: all 1 records matched.");
    });
  });

  describe("an invalid Date is an invalid record, never a comparison that quietly passes", () => {
    const garbage = new Date("garbage");

    test("on both sides: reported, and the run cannot read Perfect", () => {
      const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
        [{ id: "i1", providerPaymentId: "pi_1", amount: usd(5000), status: "succeeded", createdAt: garbage }],
        [{ id: "pi_1", amount: usd(5000), status: "succeeded", createdAt: garbage }],
      );
      expect(report.invalid).toBe(2);
      expect(report.matched).toBe(0);
      expect(report.outcome).toBe("review_required");
      expect(report.summary).not.toContain("Perfect");
      expect(report.matches[0]).toMatchObject({ internalId: "i1", status: "invalid", notes: expect.stringContaining("createdAt is an invalid Date") });
    });

    test("on the provider side only: the record naming that charge is unmatched, not matched", () => {
      const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
        [{ id: "i1", providerPaymentId: "pi_1", amount: usd(5000), status: "succeeded", createdAt: new Date("2026-01-15T12:00:00Z") }],
        [{ id: "pi_1", amount: usd(5000), status: "succeeded", createdAt: garbage }],
      );
      expect(report).toMatchObject({ matched: 0, invalid: 1, unmatchedInternal: 1, outcome: "review_required" });
    });
  });

  test("documented limit: a charge whose dispute was lost keeps status succeeded, so it matches (README says so)", () => {
    // Stripe does not change the PaymentIntent's or Charge's status on a lost dispute.
    const at = new Date("2026-01-15T12:00:00Z");
    const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
      [{ id: "i1", providerPaymentId: "pi_disputed", amount: usd(5000), status: "succeeded", createdAt: at }],
      [{ id: "pi_disputed", amount: usd(5000), status: "succeeded", createdAt: at, metadata: { dispute: "lost" } }],
    );
    expect(report.outcome).toBe("perfect");
    expect(require("fs").readFileSync(require("path").join(__dirname, "../README.md"), "utf8")).toContain("**A lost dispute still reads `perfect`.**");
  });

  describe("two provider charges under one reference are a possible double charge", () => {
    const charged = (id: string, pi: string, reference: string | undefined, amount = 5000, at = day): InternalRecord => ({
      id,
      providerPaymentId: pi,
      reference,
      amount: usd(amount),
      status: "succeeded",
      createdAt: at,
    });
    const charge = (id: string, status = "succeeded", amount = 5000, at = day, reference?: string): ProviderRecord => ({
      id,
      amount: usd(amount),
      status,
      createdAt: at,
      reference,
    });

    test("one order charged on two PaymentIntents, whichever way round the inputs come", () => {
      const internal = [charged("i1", "pi_1", "order_42"), charged("i2", "pi_2", "order_42")];
      const provider = [charge("pi_1"), charge("pi_2")];
      for (const report of [
        engine().reconcile(internal, provider),
        engine().reconcile([...internal].reverse(), [...provider].reverse()),
      ]) {
        expect(report.matches.find((m) => m.providerId === "pi_1")).toMatchObject({ status: "matched" });
        const flagged = report.matches.find((m) => m.providerId === "pi_2")!;
        expect(flagged).toMatchObject({ status: "duplicate", duplicate: true, possibleDoubleCharge: true });
        expect(flagged.notes).toContain("possible double charge: reference order_42 was also charged on pi_1");
        expect(report).toMatchObject({ matched: 1, duplicates: 1, possibleDoubleCharges: 1, outcome: "review_required" });
        expect(report.summary).toBe("Matched 1/2. 1 possible double charge. Review required.");
      }
    });

    test("the later charge is the one flagged, by time and not by id", () => {
      const later = new Date("2026-11-02T13:00:00Z");
      const report = engine().reconcile(
        [charged("i1", "pi_a", "order_42", 5000, later), charged("i2", "pi_b", "order_42")],
        [charge("pi_a", "succeeded", 5000, later), charge("pi_b")],
      );
      expect(report.matches.find((m) => m.providerId === "pi_a")!.possibleDoubleCharge).toBe(true);
      expect(report.matches.find((m) => m.providerId === "pi_b")!.possibleDoubleCharge).toBeUndefined();
    });

    test("three charges: every one after the first", () => {
      const report = engine().reconcile(
        [charged("i1", "pi_1", "order_42"), charged("i2", "pi_2", "order_42"), charged("i3", "pi_3", "order_42")],
        [charge("pi_1"), charge("pi_2"), charge("pi_3")],
      );
      expect(report.possibleDoubleCharges).toBe(2);
      expect(report.summary).toBe("Matched 1/3. 2 possible double charges. Review required.");
    });

    test("unequal amounts are flagged too: an order re-charged at a changed price", () => {
      const report = engine().reconcile(
        [charged("i1", "pi_1", "order_42", 5000), charged("i2", "pi_2", "order_42", 5500)],
        [charge("pi_1", "succeeded", 5000), charge("pi_2", "succeeded", 5500)],
      );
      const flagged = report.matches.find((m) => m.providerId === "pi_2")!;
      expect(flagged.possibleDoubleCharge).toBe(true);
      expect(flagged.notes).toContain("(5000 USD), this one is 5500 USD");
    });

    test("a charge the ledger never recorded is caught through the provider row's own reference", () => {
      const report = engine().reconcile(
        [charged("i1", "pi_1", "order_42")],
        [charge("pi_1"), charge("pi_2", "succeeded", 5000, new Date("2026-11-02T13:00:00Z"), "order_42")],
      );
      const flagged = report.matches.find((m) => m.providerId === "pi_2")!;
      // It keeps its primary status and gains the flag.
      expect(flagged).toMatchObject({ status: "unmatched_provider", duplicate: true, possibleDoubleCharge: true });
      expect(report.unmatchedProvider).toBe(1);
      expect(report.summary).toBe("Matched 1/1. 1 provider record unmatched. 1 possible double charge. Review required.");
    });

    test("a row with a real discrepancy keeps its status and gains the flag", () => {
      const report = engine().reconcile(
        [charged("i1", "pi_1", "order_42"), charged("i2", "pi_2", "order_42", 5000)],
        [charge("pi_1"), charge("pi_2", "succeeded", 4000)],
      );
      expect(report.matches.find((m) => m.providerId === "pi_2")).toMatchObject({
        status: "amount_mismatch",
        duplicate: true,
        possibleDoubleCharge: true,
      });
    });

    test("fuzzy-matched records carry their reference to the charge they paired with", () => {
      const idless = (id: string, at: Date): InternalRecord => ({ id, reference: "order_42", amount: usd(5000), status: "succeeded", createdAt: at });
      const later = new Date("2026-11-03T13:00:00Z");
      const report = engine().reconcile([idless("i1", day), idless("i2", later)], [charge("pi_1"), charge("pi_2", "succeeded", 5000, later)]);
      expect(report.possibleDoubleCharges).toBe(1);
      expect(report.summary).not.toMatch(/Perfect/);
    });

    test("an unknown provider status counts: it may hold money", () => {
      const settled = (id: string): ProviderRecord => ({ ...charge(id, "settled_by_bank"), reference: "order_42" });
      const report = engine().reconcile([], [settled("p_1"), settled("p_2")]);
      expect(report.possibleDoubleCharges).toBe(1);
    });

    test("controls that are NOT a double charge", () => {
      const clean = (internal: InternalRecord[], provider: ProviderRecord[]) => {
        const report = engine().reconcile(internal, provider);
        expect(report.possibleDoubleCharges).toBe(0);
        expect(report.summary).toBe(`Perfect reconciliation: all ${internal.length} records matched.`);
      };
      // Different orders, or no reference at all (same customer, same plan).
      clean([charged("i1", "pi_1", "order_1"), charged("i2", "pi_2", "order_2")], [charge("pi_1"), charge("pi_2")]);
      clean([charged("i1", "pi_1", undefined), charged("i2", "pi_2", undefined)], [charge("pi_1"), charge("pi_2")]);
      // A declined attempt, then a successful retry.
      clean(
        [{ ...charged("i1", "pi_1", "order_42"), status: "failed" }, charged("i2", "pi_2", "order_42")],
        [charge("pi_1", "failed"), charge("pi_2")],
      );
      // One attempt never finished.
      clean(
        [{ ...charged("i1", "pi_1", "order_42"), status: "pending" }, charged("i2", "pi_2", "order_42")],
        [charge("pi_1", "requires_payment_method"), charge("pi_2")],
      );
      // Charged twice and one already refunded in full: put right.
      clean(
        [{ ...charged("i1", "pi_1", "order_42"), status: "refunded" }, charged("i2", "pi_2", "order_42")],
        [charge("pi_1", "refunded"), charge("pi_2")],
      );
      // A refund row filed under the order's reference is not a second charge.
      clean(
        [charged("i1", "pi_1", "order_42"), charged("i2", "re_1", "order_42", -500)],
        [charge("pi_1"), charge("re_1", "succeeded", -500)],
      );
    });

    test.each([
      ["processing", "an ACH or SEPA debit in flight"],
      ["PROCESSING", "whatever the case"],
      ["requires_capture", "a live hold on the card"],
      ["pending", "a Stripe Charge's debit in flight"],
      ["in_transit", "money moving"],
    ])("%s may hold money, so two under one reference are flagged (%s)", (status) => {
      const report = engine().reconcile(
        [{ ...charged("i1", "pi_1", "order_42"), status: "processing" }, { ...charged("i2", "pi_2", "order_42"), status: "processing" }],
        [charge("pi_1", status), charge("pi_2", status)],
      );
      expect(report.possibleDoubleCharges).toBe(1);
      expect(report.matches.find((m) => m.providerId === "pi_2")).toMatchObject({ status: "duplicate", possibleDoubleCharge: true });
      expect(report.outcome).toBe("review_required");
      expect(report.summary).not.toContain("Perfect");
    });

    test("a live hold counts against a settled charge too, whichever came first", () => {
      const report = engine().reconcile(
        [{ ...charged("i1", "pi_1", "order_42"), status: "processing" }, charged("i2", "pi_2", "order_42")],
        [charge("pi_1", "requires_capture"), charge("pi_2")],
      );
      expect(report.possibleDoubleCharges).toBe(1);
      expect(report.matches.find((m) => m.providerId === "pi_2")!.notes).toContain("also charged on pi_1");
    });

    test.each(["requires_payment_method", "requires_confirmation", "requires_action"])(
      "control: %s has taken nothing, so a retry that succeeded is not a double charge",
      (status) => {
        const report = engine().reconcile(
          [{ ...charged("i1", "pi_1", "order_42"), status: "pending" }, charged("i2", "pi_2", "order_42")],
          [charge("pi_1", status), charge("pi_2")],
        );
        expect(report.possibleDoubleCharges).toBe(0);
        expect(report.outcome).toBe("perfect");
      },
    );

    test("a partially refunded charge still holds money, so it counts", () => {
      const report = engine().reconcile(
        [{ ...charged("i1", "pi_1", "order_42"), status: "partially_refunded" }, charged("i2", "pi_2", "order_42")],
        [charge("pi_1", "partially_refunded"), charge("pi_2")],
      );
      expect(report.possibleDoubleCharges).toBe(1);
    });

    test.each([
      ["a number", 42],
      ["an empty string", ""],
      ["null", null],
    ])("a reference that is %s makes the record invalid (it would silently opt out of this check)", (_name, reference) => {
      const bad = { ...charged("i1", "pi_1", "x"), reference } as unknown as InternalRecord;
      const report = engine().reconcile([bad], [charge("pi_1")]);
      expect(report.matches.find((m) => m.internalId === "i1")).toMatchObject({ status: "invalid", notes: expect.stringContaining("reference") });
      expect(report.summary).not.toMatch(/Perfect/);
    });
  });

  describe("an empty input is never a clean run", () => {
    const one: InternalRecord = { id: "i1", providerPaymentId: "pi_1", amount: usd(5000), status: "succeeded", createdAt: day };
    const oneCharge: ProviderRecord = { id: "pi_1", amount: usd(5000), status: "succeeded", createdAt: day };

    test("both sides empty: nothing to reconcile, never perfect", () => {
      const report = engine().reconcile([], []);
      expect(report.outcome).toBe("nothing_to_reconcile");
      expect(report.summary).toMatch(/^Nothing to reconcile/);
      expect(report.summary).not.toMatch(/Perfect/);
    });

    test("provider side empty: an error state that still lists the internal records", () => {
      const report = engine().reconcile([one, { ...one, id: "i2", providerPaymentId: "pi_2" }], []);
      expect(report.outcome).toBe("provider_records_empty");
      expect(report.summary).toBe(
        "Reconciliation error: the provider records are empty but 2 internal records were supplied. Check the provider export before trusting this run.",
      );
      expect(report.unmatchedInternal).toBe(2);
      expect(report.matches.map((m) => m.internalId)).toEqual(["i1", "i2"]);
    });

    test("internal side empty: an error state that still lists the provider records", () => {
      const report = engine().reconcile([], [oneCharge]);
      expect(report.outcome).toBe("internal_records_empty");
      expect(report.summary).toBe(
        "Reconciliation error: the internal records are empty but 1 provider record was supplied. Check the ledger export before trusting this run.",
      );
      expect(report.unmatchedProvider).toBe(1);
    });

    test("control: records on both sides read as before", () => {
      expect(engine().reconcile([one], [oneCharge])).toMatchObject({
        outcome: "perfect",
        summary: "Perfect reconciliation: all 1 records matched.",
      });
    });
  });
});

describe("ReconciliationEngine — refunded totals, references, and what perfect compares", () => {
  const day = new Date("2026-11-02T12:00:00Z");
  const usd = (amount: number) => ({ amount, currency: "USD" });
  const ledger = (over: Partial<InternalRecord> = {}): InternalRecord => ({
    id: "i1",
    providerPaymentId: "pi_1",
    amount: usd(5000),
    status: "succeeded",
    createdAt: day,
    ...over,
  });
  const charge = (over: Partial<ProviderRecord> = {}): ProviderRecord => ({
    id: "pi_1",
    amount: usd(5000),
    status: "succeeded",
    createdAt: day,
    ...over,
  });
  const reconcile = (int: Partial<InternalRecord>, prov: Partial<ProviderRecord>, config = {}) =>
    new ReconciliationEngine({ provider: "stripe", ...config }).reconcile([ledger(int)], [charge(prov)]);

  describe("a partial refund is verified by its total", () => {
    test("a partially_refunded pair stating no totals is not perfect, and says why", () => {
      const report = reconcile({ status: "partially_refunded" }, { status: "partially_refunded" });
      expect(report.outcome).toBe("review_required");
      expect(report.refundsUnverified).toBe(1);
      expect(report.matched).toBe(0);
      expect(report.matches[0].status).toBe("refund_unverified");
      expect(report.matches[0].notes).toBe(
        "Refund not verified: both sides show a partial refund, but the internal record states no amountRefunded and the provider record states no amountRefunded. Set amountRefunded on both to compare them.",
      );
      expect(report.summary).toBe("Matched 0/1. 1 partial refund not verified. Review required.");
    });

    test.each([
      ["the provider", { status: "partially_refunded", amountRefunded: 1000 }, { status: "partially_refunded" }, "the internal record states 1000 and the provider record states no amountRefunded"],
      ["the ledger", { status: "partially_refunded" }, { status: "partially_refunded", amountRefunded: 1000 }, "the internal record states no amountRefunded and the provider record states 1000"],
    ] as const)("%s states no total: unverified, naming which side", (_who, int, prov, note) => {
      const report = reconcile(int, prov);
      expect(report.matches[0].status).toBe("refund_unverified");
      expect(report.matches[0].notes).toContain(note);
      expect(report.outcome).toBe("review_required");
    });

    test("ledger $10 against Stripe $40 is a refund_mismatch, with the gap", () => {
      const report = reconcile({ status: "partially_refunded", amountRefunded: 1000 }, { status: "partially_refunded", amountRefunded: 4000 });
      expect(report.outcome).toBe("review_required");
      expect(report.refundMismatches).toBe(1);
      expect(report.matches[0]).toMatchObject({
        status: "refund_mismatch",
        amountDiscrepancy: { amount: 3000, currency: "USD" },
        notes: "Refund mismatch: internal refunded 1000, provider refunded 4000.",
      });
      expect(report.summary).toBe("Matched 0/1. 1 refund mismatch. Review required.");
    });

    test("a refund issued twice at the provider shows up against the ledger's one", () => {
      const report = reconcile({ status: "partially_refunded", amountRefunded: 1500 }, { status: "partially_refunded", amountRefunded: 3000 });
      expect(report.matches[0].status).toBe("refund_mismatch");
      expect(report.matches[0].amountDiscrepancy).toEqual(usd(1500));
    });

    test("control: equal totals are a clean match", () => {
      const report = reconcile({ status: "partially_refunded", amountRefunded: 1000 }, { status: "partially_refunded", amountRefunded: 1000 });
      expect(report.matches[0].status).toBe("matched");
      expect(report.outcome).toBe("perfect");
      expect(report).toMatchObject({ refundMismatches: 0, refundsUnverified: 0, referenceMismatches: 0 });
    });

    test("toleranceAmount covers refunded totals too, at the boundary", () => {
      const pair = { status: "partially_refunded", amountRefunded: 1000 } as const;
      expect(reconcile(pair, { ...pair, amountRefunded: 1001 }, { toleranceAmount: 1 }).outcome).toBe("perfect");
      expect(reconcile(pair, { ...pair, amountRefunded: 1002 }, { toleranceAmount: 1 }).matches[0].status).toBe("refund_mismatch");
      expect(reconcile(pair, { ...pair, amountRefunded: 1001 }).matches[0].status).toBe("refund_mismatch");
    });
  });

  describe("a raw Stripe row: status stays succeeded, the total shows the refund", () => {
    test.each([
      ["a partial refund", { status: "partially_refunded", amountRefunded: 1000 }, { status: "succeeded", amountRefunded: 1000 }],
      ["a full refund, total stated", { status: "refunded", amountRefunded: 5000 }, { status: "succeeded", amountRefunded: 5000 }],
      ["a full refund, implied by the ledger's status", { status: "refunded" }, { status: "succeeded", amountRefunded: 5000 }],
      ["a ledger keeping the status too", { status: "succeeded", amountRefunded: 1000 }, { status: "succeeded", amountRefunded: 1000 }],
      ["no refund, stated as 0 on one side", { status: "succeeded" }, { status: "succeeded", amountRefunded: 0 }],
      ["no refund, stated as 0 on both", { status: "succeeded", amountRefunded: 0 }, { status: "succeeded", amountRefunded: 0 }],
    ] as const)("%s reconciles clean", (_name, int, prov) => {
      const report = reconcile(int, prov);
      expect(report.matches[0].status).toBe("matched");
      expect(report.outcome).toBe("perfect");
    });

    test("a refund the ledger never heard of is a status mismatch, and shows the total", () => {
      const report = reconcile({ status: "succeeded" }, { status: "succeeded", amountRefunded: 1000 });
      expect(report.matches[0].status).toBe("status_mismatch");
      expect(report.matches[0].notes).toContain("Status mismatch: internal=succeeded provider=succeeded (1000 refunded).");
      expect(report.matches[0].notes).toContain("The provider shows a refund the ledger has not recorded.");
    });

    test("a refund the ledger claims and the provider row cannot show says to confirm it", () => {
      const report = reconcile({ status: "succeeded", amountRefunded: 1000 }, { status: "succeeded" });
      expect(report.matches[0].status).toBe("status_mismatch");
      expect(report.matches[0].notes).toContain("Confirm the refund itself");
      expect(report.matches[0].notes).toContain("amountRefunded");
    });

    test("the ledger's partial refund against a total the provider states as the whole amount disagrees", () => {
      const report = reconcile({ status: "partially_refunded", amountRefunded: 1000 }, { status: "succeeded", amountRefunded: 5000 });
      expect(report.matches[0].status).toBe("status_mismatch");
      expect(report.matches[0].notes).toContain("internal=partially_refunded (1000 refunded) provider=succeeded (5000 refunded)");
    });

    test("a partial ledger status with no total against a raw row is still unverified", () => {
      const report = reconcile({ status: "partially_refunded" }, { status: "succeeded", amountRefunded: 1000 });
      expect(report.matches[0].status).toBe("refund_unverified");
    });

    test("a total on an outcome that took nothing is compared as well", () => {
      const report = reconcile({ status: "cancelled" }, { status: "canceled", amountRefunded: 5000 });
      expect(report.matches[0]).toMatchObject({ status: "refund_mismatch", amountDiscrepancy: usd(5000) });
    });
  });

  describe("a double charge reads a refund from the total as well", () => {
    const secondCharge = (over: Partial<ProviderRecord>) => charge({ id: "pi_2", reference: "order_42", createdAt: new Date(day.getTime() + 1000), ...over });

    test("a fully refunded second charge has been put right, whichever field says so", () => {
      const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
        [ledger({ reference: "order_42" }), ledger({ id: "i2", providerPaymentId: "pi_2", reference: "order_42", status: "refunded" })],
        [charge({ reference: "order_42" }), secondCharge({ amountRefunded: 5000 })],
      );
      expect(report.possibleDoubleCharges).toBe(0);
    });

    test("a partly refunded second charge still holds money", () => {
      const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
        [ledger({ reference: "order_42" }), ledger({ id: "i2", providerPaymentId: "pi_2", reference: "order_42", status: "partially_refunded", amountRefunded: 1000 })],
        [charge({ reference: "order_42" }), secondCharge({ amountRefunded: 1000 })],
      );
      expect(report.possibleDoubleCharges).toBe(1);
    });
  });

  describe("an unusable or self-contradicting total is an invalid record", () => {
    test.each([
      ["NaN", { amountRefunded: NaN }, "amountRefunded NaN is not a non-negative safe integer"],
      ["a fraction", { amountRefunded: 10.5 }, "amountRefunded 10.5 is not a non-negative safe integer"],
      ["negative", { amountRefunded: -1 }, "amountRefunded -1 is not a non-negative safe integer"],
      ["a string", { amountRefunded: "1000" as unknown as number }, "amountRefunded 1000 is not a non-negative safe integer"],
      ["null from a database", { amountRefunded: null as unknown as number }, "amountRefunded null is not a non-negative safe integer"],
      ["more than was paid", { amountRefunded: 5001 }, "amountRefunded 5001 is more than the 5000 paid"],
      ["refunded, but only part of it", { status: "refunded", amountRefunded: 1000 }, "status refunded contradicts amountRefunded 1000 of 5000"],
      ["partially refunded, but nothing", { status: "partially_refunded", amountRefunded: 0 }, "status partially_refunded contradicts amountRefunded 0 of 5000"],
      ["partially refunded, but all of it", { status: "partially_refunded", amountRefunded: 5000 }, "status partially_refunded contradicts amountRefunded 5000 of 5000"],
    ] as const)("%s, identical on both sides, cannot agree with itself into a clean run", (_name, fields, reason) => {
      const report = new ReconciliationEngine({ provider: "stripe" }).reconcile([ledger(fields as Partial<InternalRecord>)], [charge(fields as Partial<ProviderRecord>)]);
      expect(report.invalid).toBe(2);
      expect(report.matched).toBe(0);
      expect(report.outcome).toBe("review_required");
      expect(report.matches[0].notes).toContain(reason);
    });

    test("a refund row keeps working: the total is measured against the size of a negative amount", () => {
      const report = reconcile({ amount: usd(-5000), status: "refunded", amountRefunded: 5000 }, { amount: usd(-5000), status: "refunded", amountRefunded: 5000 });
      expect(report.outcome).toBe("perfect");
    });
  });

  describe("what a higher-precedence mismatch hides is still named", () => {
    test("an amount mismatch names the refund and reference disagreements", () => {
      const report = reconcile(
        { status: "partially_refunded", amountRefunded: 1000, reference: "order_1" },
        { amount: usd(4999), status: "partially_refunded", amountRefunded: 4000, reference: "order_2" },
      );
      expect(report.matches[0].status).toBe("amount_mismatch");
      expect(report.matches[0].notes).toBe(
        "Amount mismatch: internal=5000 provider=4999. Refund mismatch: internal refunded 1000, provider refunded 4000. Reference mismatch: internal=order_1 provider=order_2.",
      );
      expect(report.refundMismatches).toBe(0);
    });

    test("a currency mismatch does not compare totals across currencies, and names the reference", () => {
      const report = reconcile(
        { status: "partially_refunded", amountRefunded: 1000, reference: "order_1" },
        { amount: { amount: 5000, currency: "EUR" }, status: "partially_refunded", amountRefunded: 4000, reference: "order_2" },
      );
      expect(report.matches[0].status).toBe("currency_mismatch");
      expect(report.matches[0].notes).toBe("Currency mismatch: internal=USD provider=EUR. Reference mismatch: internal=order_1 provider=order_2.");
    });

    test("a status mismatch names the reference, and a refund mismatch outranks a reference one", () => {
      const status = reconcile({ reference: "order_1" }, { status: "failed", reference: "order_2" });
      expect(status.matches[0].status).toBe("status_mismatch");
      expect(status.matches[0].notes).toBe("Status mismatch: internal=succeeded provider=failed. Reference mismatch: internal=order_1 provider=order_2.");
      const refund = reconcile(
        { status: "partially_refunded", amountRefunded: 1000, reference: "order_1" },
        { status: "partially_refunded", amountRefunded: 4000, reference: "order_2" },
      );
      expect(refund.matches[0].status).toBe("refund_mismatch");
      expect(refund.matches[0].notes).toContain("Reference mismatch: internal=order_1 provider=order_2.");
    });

    test("a duplicate annotation does not hide a refund mismatch", () => {
      const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
        [
          ledger({ providerPaymentId: undefined, status: "partially_refunded", amountRefunded: 1000 }),
          ledger({ id: "i2", providerPaymentId: undefined, status: "partially_refunded", amountRefunded: 1000 }),
        ],
        [charge({ status: "partially_refunded", amountRefunded: 4000 }), charge({ id: "pi_2", status: "partially_refunded", amountRefunded: 4000 })],
      );
      expect(report.refundMismatches).toBe(2);
      expect(report.outcome).toBe("review_required");
    });
  });

  describe("references are compared once a pair is made", () => {
    test("both sides have one and they differ: a reference_mismatch", () => {
      const report = reconcile({ reference: "order_1" }, { reference: "order_2" });
      expect(report.outcome).toBe("review_required");
      expect(report.referenceMismatches).toBe(1);
      expect(report.matches[0]).toMatchObject({ status: "reference_mismatch", notes: "Reference mismatch: internal=order_1 provider=order_2." });
      expect(report.summary).toBe("Matched 0/1. 1 reference mismatch. Review required.");
    });

    test.each([
      ["equal", { reference: "order_1" }, { reference: "order_1" }],
      ["only the ledger has one", { reference: "order_1" }, {}],
      ["only the provider has one", {}, { reference: "order_1" }],
      ["neither has one", {}, {}],
    ])("control: %s is a clean match", (_name, int, prov) => {
      const report = reconcile(int, prov);
      expect(report.matches[0].status).toBe("matched");
      expect(report.outcome).toBe("perfect");
    });

    test("the fuzzy path compares them too, and they never steer the pairing", () => {
      const report = new ReconciliationEngine({ provider: "stripe" }).reconcile(
        [ledger({ providerPaymentId: undefined, reference: "order_1" })],
        [charge({ reference: "order_2" })],
      );
      expect(report.matches[0]).toMatchObject({ internalId: "i1", providerId: "pi_1", status: "reference_mismatch" });
    });

    test("references compare exactly: they are your ids, and PayKit does not normalise them", () => {
      expect(reconcile({ reference: "ORDER_1" }, { reference: "order_1" }).matches[0].status).toBe("reference_mismatch");
    });
  });

  describe("the status table separates money in flight from nothing taken", () => {
    const inFlight = ["processing", "in_transit", "requires_capture"];
    const nothingTaken = ["requires_payment_method", "requires_confirmation", "requires_action"];
    const pair = (int: string, prov: string) => reconcile({ status: int as InternalRecord["status"] }, { status: prov });
    const across = (a: string[], b: string[]) => a.flatMap((x) => b.map((y) => [x, y] as const));

    test("a failed debit: ledger processing against requires_payment_method is not perfect, and says what it may be", () => {
      const report = pair("processing", "requires_payment_method");
      expect(report.outcome).toBe("review_required");
      expect(report.statusMismatches).toBe(1);
      expect(report.matches[0].notes).toContain("Status mismatch: internal=processing provider=requires_payment_method.");
      expect(report.matches[0].notes).toContain("Stripe returns a PaymentIntent to requires_payment_method when a debit fails");
    });

    test.each(across(inFlight, nothingTaken))("ledger %s vs provider %s disagree", (int, prov) => {
      expect(pair(int, prov).matches[0].status).toBe("status_mismatch");
    });

    test.each(across(nothingTaken, inFlight))("ledger %s vs provider %s disagree", (int, prov) => {
      expect(pair(int, prov).matches[0].status).toBe("status_mismatch");
    });

    test.each(across(inFlight, inFlight))("control: ledger %s vs provider %s agree", (int, prov) => {
      expect(pair(int, prov).outcome).toBe("perfect");
    });

    test.each(across(nothingTaken, nothingTaken))("control: ledger %s vs provider %s agree", (int, prov) => {
      expect(pair(int, prov).outcome).toBe("perfect");
    });

    test.each(nothingTaken)("control: a ledger's pending is PayKit's, so it agrees with provider %s", (prov) => {
      expect(pair("pending", prov).outcome).toBe("perfect");
    });

    test.each(inFlight)("a ledger's pending against provider %s: the ledger has not heard of that money", (prov) => {
      const report = pair("pending", prov);
      expect(report.matches[0].status).toBe("status_mismatch");
      expect(report.matches[0].notes).toContain("The provider has money in flight or on hold that the ledger has not recorded.");
    });

    test.each([...inFlight, ...nothingTaken, "pending"])("control: a provider's bare pending does not say which, so it agrees with ledger %s", (int) => {
      expect(pair(int, "pending").outcome).toBe("perfect");
    });

    test("neither unsettled state agrees with a settled one", () => {
      for (const unsettled of [...inFlight, ...nothingTaken, "pending"]) {
        for (const settled of ["succeeded", "failed", "refunded"]) {
          expect(pair(unsettled, settled).outcome).toBe("review_required");
          expect(pair(settled, unsettled).outcome).toBe("review_required");
        }
      }
    });
  });

  test("seeded fuzz: perfect never coexists with any disagreement the engine claims to compare", () => {
    let state = 20261104;
    const next = (n: number) => {
      state = (state * 48271) % 2147483647;
      return state % n;
    };
    const pick = <T,>(values: readonly T[]): T => values[next(values.length)];
    const statuses = ["succeeded", "refunded", "partially_refunded", "failed", "cancelled", "pending", "processing"] as const;
    const providerStatuses = [...statuses, "canceled", "paid", "available", "in_transit", "requires_capture", "requires_payment_method", "requires_action", "disputed"];
    const totals = [undefined, undefined, 0, 1, 1000, 4000, 4999, 5000, 5001, -1, NaN];
    const references = [undefined, undefined, "order_1", "order_2"];
    const counts = { perfect: 0, review: 0 };
    for (let i = 0; i < 4000; i++) {
      const int = ledger({ status: pick(statuses), amountRefunded: pick(totals), reference: pick(references) });
      const prov = charge({ status: pick(providerStatuses), amountRefunded: pick(totals), reference: pick(references), amount: usd(pick([5000, 5000, 5000, 4999])) });
      const report = new ReconciliationEngine({ provider: "stripe" }).reconcile([int], [prov]);
      const context = JSON.stringify({ int, prov, row: report.matches[0] });

      // Every row is accounted for, and the verdict agrees with the rows.
      const clean = report.matches.every((m) => m.status === "matched");
      if (report.outcome !== (clean ? "perfect" : "review_required")) throw new Error(`verdict disagrees: ${context}`);
      if (report.outcome !== "perfect") {
        counts.review++;
        continue;
      }
      counts.perfect++;
      // perfect => the amounts agree, the references do not differ...
      if (int.amount.amount !== prov.amount.amount) throw new Error(`perfect across amounts: ${context}`);
      if (int.reference && prov.reference && int.reference !== prov.reference) throw new Error(`perfect across references: ${context}`);
      // ...stated totals are equal, a partial refund is stated on both sides, and
      // no side claims a refund the other does not show.
      if (int.amountRefunded !== undefined && prov.amountRefunded !== undefined && int.amountRefunded !== prov.amountRefunded) {
        throw new Error(`perfect across totals: ${context}`);
      }
      if ((int.status === "partially_refunded" || prov.status === "partially_refunded") && (int.amountRefunded === undefined || prov.amountRefunded === undefined)) {
        throw new Error(`perfect with an unverified partial refund: ${context}`);
      }
      const claimsRefund = (r: { status: string; amountRefunded?: number }) => r.status === "refunded" || r.status === "partially_refunded" || (r.amountRefunded ?? 0) > 0;
      if (claimsRefund(int) !== claimsRefund(prov)) throw new Error(`perfect with a one-sided refund: ${context}`);
      // ...and a settled outcome never agrees with an unsettled one.
      const settled = (status: string) => !["pending", "processing", "in_transit", "requires_capture", "requires_payment_method", "requires_action"].includes(status);
      if (settled(int.status) !== settled(prov.status)) throw new Error(`perfect across settled and unsettled: ${context}`);
    }
    // The generator reaches both verdicts, so the invariants above were exercised.
    expect(counts.perfect).toBeGreaterThan(50);
    expect(counts.review).toBeGreaterThan(50);
  });

  test("the README says exactly what perfect compares and what it does not", () => {
    const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
    const section = readme.slice(readme.indexOf("**`perfect` compares exactly this.**"), readme.indexOf("**A lost dispute still reads `perfect`.**"));
    for (const compared of ["currency", "amount", "status", "`amountRefunded`", "`reference`"]) {
      expect(section).toContain(compared);
    }
    expect(section).toMatch(/\*\*Not compared\*\*/);
    for (const notCompared of ["`createdAt`", "`metadata`", "fees", "disputes"]) {
      expect(section).toContain(notCompared);
    }
    expect(readme).not.toContain("means nothing to review");
    expect(readme).not.toContain('a non-zero `amount_refunded` (use `"partially_refunded"`)');
    expect(fs.readFileSync(path.join(__dirname, "../docs/usage.md"), "utf8")).not.toContain("build\n`ProviderRecord.status` from a Charge's");
  });
});
