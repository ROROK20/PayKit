/**
 * Payment reconciliation engine.
 *
 * Matches internal payment records against provider records to identify:
 * - Successfully matched payments (same amount, currency AND outcome)
 * - Payments in internal DB but not in provider (missing charges)
 * - Payments in provider but not in internal DB (phantom charges)
 * - Amount, currency, status, refunded-total and reference mismatches
 * - Duplicate payments (two internal records claiming one provider charge, or
 *   — among records with no provider id — same amount + currency + UTC day)
 * - Possible double charges (two provider charges that may hold money under
 *   one `reference`: one order paid on two PaymentIntents)
 * - Empty inputs, which are never a clean run (see `ReconciliationOutcome`)
 *
 * Use case: nightly reconciliation job comparing your database against a
 * provider's records — Stripe PaymentIntents (the default reading of
 * `status`), or balance transactions with
 * `providerRecordType: "balance_transaction"`.
 */

import {
  InternalRecord,
  ProviderRecord,
  ReconciliationMatch,
  ReconciliationOutcome,
  ReconciliationReport,
  PaymentProvider,
  Money,
  PayKitError,
} from "../types/index";

/**
 * Outcome of comparing two amounts. Currency mismatch is distinct from amount
 * mismatch: you can never meaningfully subtract across currencies, so we never
 * emit a numeric diff in that case.
 */
type AmountComparison =
  | { kind: "ok" }
  | { kind: "amount_mismatch"; discrepancy: Money }
  | { kind: "currency_mismatch" };

/** What a status says happened to the money, independent of vocabulary. */
type Outcome = "succeeded" | "refunded" | "partially_refunded" | "failed" | "in_flight" | "nothing_taken" | "pending";

/** Outcome of comparing what two records state was refunded. */
type RefundComparison =
  | { kind: "ok" }
  | { kind: "refund_mismatch"; notes: string; discrepancy: Money }
  | { kind: "refund_unverified"; notes: string };

/**
 * The status-equivalence table: two statuses agree only if they map to the
 * same outcome (see `outcomesAgree` for bare `pending`). It covers PayKit's
 * `PaymentStatus` and Stripe's PaymentIntent and Charge statuses (plus
 * `available`, `paid` and `in_transit`, which only ever describe money that
 * moved or is moving). A payment that has not completed is one of two opposite
 * things, and they do not agree with each other:
 * - `in_flight`: money is moving or held — a debit in flight (`processing`,
 *   `in_transit`) or a live hold on a card (`requires_capture`).
 * - `nothing_taken`: waiting for a payment method, a confirmation or the
 *   customer. Stripe also returns a PaymentIntent to `requires_payment_method`
 *   when a debit FAILS, so a ledger's `processing` against it is a failed debit
 *   the ledger has not heard of, not a match.
 * Neither agrees with `succeeded`, in either direction: the ledger and the
 * provider disagree on whether the money moved, even if a later run would agree.
 *
 * `refunded` and `partially_refunded` are outcomes of their own, not a kind of
 * `succeeded`. A Stripe PaymentIntent or Charge keeps `status: "succeeded"`
 * after a refund, so that status cannot confirm one, and treating the two as
 * equal hid both "the ledger says refunded and the refund never happened" and
 * "the provider refunded and the ledger never heard". Reconciling refunds means
 * building the provider record's status from what shows the refund (a Charge's
 * `refunded` / `amount_refunded`); until then each is a reported mismatch.
 *
 * A status missing from this table is compared verbatim (case-insensitive)
 * instead. Stripe balance transactions use `pending` for something else — see
 * `BALANCE_TRANSACTION_OUTCOME`.
 */
const STATUS_OUTCOME: Readonly<Record<string, Outcome>> = {
  succeeded: "succeeded",
  paid: "succeeded",
  available: "succeeded",
  refunded: "refunded",
  partially_refunded: "partially_refunded",
  failed: "failed",
  cancelled: "failed",
  canceled: "failed",
  pending: "pending",
  processing: "in_flight",
  in_transit: "in_flight",
  requires_capture: "in_flight",
  requires_payment_method: "nothing_taken",
  requires_confirmation: "nothing_taken",
  requires_action: "nothing_taken",
};

/**
 * Do these two known outcomes agree? Equal outcomes do. Beyond that, only a bare
 * `pending` needs reading, and it means different things on each side:
 * - On the ledger it is PayKit's `pending`: the `requires_*` statuses (see
 *   `mapStripeStatus`), nothing taken yet. Against money the provider has in
 *   flight, the two disagree.
 * - On a provider row it does not say which. A Stripe Charge says `pending` of
 *   a debit in flight, and `StripeProvider` folds `requires_*` into `pending`, so
 *   it agrees with a ledger in either state. That is also why a failed debit is
 *   only visible in Stripe's raw status.
 */
function outcomesAgree(internal: Outcome, provider: Outcome): boolean {
  if (internal === provider) return true;
  if (internal === "pending") return provider === "nothing_taken";
  if (provider === "pending") return internal === "in_flight" || internal === "nothing_taken";
  return false;
}

/**
 * A record's outcome once its refunded total has had its say. A Stripe
 * PaymentIntent or Charge stays `succeeded` after a refund, so on such a row the
 * total is what shows the refund. Every other status keeps its own outcome:
 * validation has already refused a `refunded` or `partially_refunded` status that
 * contradicts the total.
 */
function outcomeWithRefunds(outcome: Outcome | undefined, record: InternalRecord | ProviderRecord): Outcome | undefined {
  if (outcome !== "succeeded" || !record.amountRefunded) return outcome;
  return record.amountRefunded >= Math.abs(record.amount.amount) ? "refunded" : "partially_refunded";
}

/** What a record states was refunded: its total, the whole amount if `refunded`, else nothing. */
function statedRefund(record: InternalRecord | ProviderRecord, outcome: Outcome | undefined): number | undefined {
  return record.amountRefunded ?? (outcome === "refunded" ? Math.abs(record.amount.amount) : undefined);
}

/** A status as the notes show it, with the refunded total that changes how it reads. */
function shownStatus(record: InternalRecord | ProviderRecord): string {
  return record.amountRefunded ? `${record.status} (${record.amountRefunded} refunded)` : record.status;
}

/**
 * Stripe balance-transaction statuses → outcome, used for provider records
 * when `providerRecordType` is `"balance_transaction"`. A balance transaction
 * exists only for money that moved; its status says whether the funds are
 * available to pay out yet (`available`) or not (`pending`, typically for a
 * couple of days after a charge). Both are a succeeded payment — `pending`
 * here is NOT the payment-vocabulary `pending`.
 */
const BALANCE_TRANSACTION_OUTCOME: Readonly<Record<string, Outcome>> = {
  pending: "succeeded",
  available: "succeeded",
};

/** What `ProviderRecord.status` describes; see `ReconciliationConfig`. */
export type ProviderRecordType = "payment" | "balance_transaction";

/**
 * ISO 4217 code in canonical upper case. Stripe's API returns currencies in
 * lower case (`usd`) while PayKit intents carry upper case (`USD`); every
 * comparison goes through this so raw provider rows reconcile.
 */
function currencyCode(money: Money): string {
  return money.currency.toUpperCase();
}

/**
 * Why a record cannot be reconciled, or `null` if it can. Checked before any
 * matching, because the comparisons cannot be trusted with bad numbers:
 * `Math.abs(NaN - x) > tolerance` is false, so an amount of NaN or
 * `undefined` would "match" any amount and a run with one could read
 * "Perfect reconciliation". Amounts may be negative or zero (refund rows,
 * balance transactions) but must be safe integers of minor units.
 */
function invalidRecordReason(record: unknown): string | null {
  if (!record || typeof record !== "object") return "the record is not an object";
  const r = record as { id?: unknown; amount?: unknown; status?: unknown; createdAt?: unknown; providerPaymentId?: unknown; reference?: unknown; amountRefunded?: unknown };
  if (typeof r.id !== "string" || r.id.length === 0) return `id ${String(r.id)} is not a non-empty string`;
  const money = r.amount as { amount?: unknown; currency?: unknown } | null | undefined;
  if (!money || typeof money !== "object") return "amount is missing";
  if (typeof money.amount !== "number" || !Number.isSafeInteger(money.amount)) {
    return `amount ${String(money.amount)} is not a safe integer number of minor units`;
  }
  if (typeof money.currency !== "string" || !/^[A-Za-z]{3}$/.test(money.currency)) {
    return `currency ${JSON.stringify(money.currency) ?? "undefined"} is not a three-letter code`;
  }
  if (typeof r.status !== "string" || r.status.length === 0) return `status ${String(r.status)} is not a non-empty string`;
  if (!(r.createdAt instanceof Date)) return "createdAt is not a Date";
  // `new Date("garbage")` IS a Date, and every comparison with its NaN time is false.
  if (Number.isNaN(r.createdAt.getTime())) return "createdAt is an invalid Date";
  if (r.providerPaymentId !== undefined && (typeof r.providerPaymentId !== "string" || r.providerPaymentId.length === 0)) {
    return `providerPaymentId ${String(r.providerPaymentId)} is not a non-empty string`;
  }
  // Double-charge detection groups by this; a number from a database would
  // silently opt the record out of it.
  if (r.reference !== undefined && (typeof r.reference !== "string" || r.reference.length === 0)) {
    return `reference ${String(r.reference)} is not a non-empty string`;
  }
  return r.amountRefunded === undefined ? null : invalidRefundReason(r.amountRefunded, money.amount, r.status);
}

/**
 * Why a refunded total cannot be trusted, or `null`. One a record contradicts
 * itself with is rejected as well: a `refunded` status naming part of the amount, on
 * both sides, would otherwise agree with itself and read as clean.
 */
function invalidRefundReason(refunded: unknown, amount: number, status: string): string | null {
  if (typeof refunded !== "number" || !Number.isSafeInteger(refunded) || refunded < 0) {
    return `amountRefunded ${String(refunded)} is not a non-negative safe integer number of minor units`;
  }
  const paid = Math.abs(amount);
  if (refunded > paid) return `amountRefunded ${refunded} is more than the ${paid} paid`;
  const normalized = status.toLowerCase();
  if (normalized === "refunded" && refunded < paid) {
    return `status ${status} contradicts amountRefunded ${refunded} of ${paid}`;
  }
  if (normalized === "partially_refunded" && (refunded === 0 || refunded === paid)) {
    return `status ${status} contradicts amountRefunded ${refunded} of ${paid}`;
  }
  return null;
}

/** Matching window used by phase-2 matching when `fuzzyDate` is on: ±1 day. */
const FUZZY_DATE_WINDOW_MS = 86_400_000;

/**
 * Minimum-cost assignment (Hungarian algorithm, potentials form) for a
 * rectangular matrix with rows ≤ columns: returns, per row, the column it is
 * assigned (every row gets a distinct column). O(rows² · columns). Costs are
 * integers well below 2^53, so the float arithmetic is exact.
 */
function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length;
  const m = n === 0 ? 0 : cost[0].length;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1); // p[j] = row (1-based) assigned to column j
  const way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] !== 0) rowToCol[p[j] - 1] = j - 1;
  return rowToCol;
}

export interface ReconciliationConfig {
  /**
   * Largest amount difference, in minor units, still treated as equal.
   * Default 0: amounts are integer minor units, so they must match exactly —
   * a 1-cent shortfall is an `amount_mismatch`. Opt in (e.g. `1`) only when
   * your ledger and the provider genuinely round differently, knowing that
   * every real discrepancy up to that size is then hidden. Must be a
   * non-negative integer; anything else throws `INVALID_CONFIG` (a `NaN`
   * tolerance would otherwise match every amount).
   */
  toleranceAmount?: number;
  /**
   * Date window for phase-2 matching (internal records that carry no
   * `providerPaymentId`): `true` matches timestamps within ±1 day; `false`
   * (default) requires identical timestamps.
   */
  fuzzyDate?: boolean;
  /**
   * What the provider records' `status` describes.
   * - `"payment"` (default): a payment outcome — PayKit's `PaymentStatus`, or
   *   a Stripe PaymentIntent / Charge status. `pending` means not paid yet,
   *   so an internal `succeeded` against it is a `status_mismatch`.
   * - `"balance_transaction"`: Stripe balance transactions, whose `pending`
   *   and `available` describe when charged funds become available, not
   *   whether the payment succeeded — both count as succeeded. Use it for
   *   charge-type balance transactions; refunds and fees reconcile separately.
   * Any other value throws `INVALID_CONFIG`.
   */
  providerRecordType?: ProviderRecordType;
}

/**
 * Reconciliation engine.
 *
 * @example
 * ```ts
 * const engine = new ReconciliationEngine({ provider: 'stripe' });
 *
 * const report = engine.reconcile(
 *   internalRecords,  // from your database
 *   providerRecords,  // from Stripe payout report
 * );
 *
 * console.log(report.summary);
 * // "Matched 847/850. 3 internal records unmatched. Review required."
 *
 * for (const m of report.matches) {
 *   if (m.status !== 'matched') {
 *     console.warn(m.status, m.internalId, m.notes);
 *   }
 * }
 * ```
 */
export class ReconciliationEngine {
  private provider: PaymentProvider;
  private config: Required<ReconciliationConfig>;

  constructor(
    options: { provider: PaymentProvider } & ReconciliationConfig = { provider: "stripe" },
  ) {
    this.provider = options.provider;
    const toleranceAmount = options.toleranceAmount ?? 0;
    if (!Number.isInteger(toleranceAmount) || toleranceAmount < 0) {
      throw new PayKitError(
        `Invalid reconciliation config: toleranceAmount must be a non-negative integer number of minor units, got ${toleranceAmount}.`,
        "INVALID_CONFIG",
      );
    }
    const providerRecordType = options.providerRecordType ?? "payment";
    if (providerRecordType !== "payment" && providerRecordType !== "balance_transaction") {
      throw new PayKitError(
        `Invalid reconciliation config: providerRecordType must be "payment" or "balance_transaction", got ${String(providerRecordType)}.`,
        "INVALID_CONFIG",
      );
    }
    this.config = {
      toleranceAmount,
      fuzzyDate: options.fuzzyDate ?? false,
      providerRecordType,
    };
  }

  /**
   * Reconcile internal records against provider records.
   *
   * Matching strategy (in order):
   * 1. Exact match by `providerPaymentId`. Each provider record can be
   *    claimed once: a second internal record pointing at the same charge is
   *    reported `duplicate`, never `matched`. An id that is not among the
   *    provider records is `unmatched_internal` — it is never re-matched to
   *    some other charge by amount.
   * 2. Amount + date proximity match, ONLY for internal records with no
   *    `providerPaymentId`, against provider records nobody claimed: one
   *    optimal assignment — the most pairs, then the smallest total time
   *    distance — independent of input order.
   * 3. Remainder → unmatched.
   *
   * Every pair is then compared on currency, amount, status outcome, refunded
   * total and `reference` (see the README for exactly what a `perfect` run did
   * and did not compare). Charges sharing a `reference` are flagged as possible
   * double charges.
   *
   * Empty inputs are never a clean run: both sides empty reads "Nothing to
   * reconcile", one side empty is an error state (an export that failed looks
   * exactly like this). `report.outcome` says which, for code.
   */
  reconcile(
    internal: InternalRecord[],
    provider: ProviderRecord[],
  ): ReconciliationReport {
    const matches: ReconciliationMatch[] = [];
    const unmatched: ReconciliationMatch[] = [];

    // Phase 0: validate both sides. An invalid record is reported and kept
    // out of every comparison — it can never become a match.
    const validInternal: InternalRecord[] = [];
    const firstInternalById = new Map<string, InternalRecord>();
    // Rows for a repeated internal id: they stand for a record that was not
    // reconciled, so they share an id with the record's real row, not its fate.
    const repeatedIdRows = new Set<ReconciliationMatch>();
    for (const int of internal) {
      const reason = invalidRecordReason(int);
      if (reason === null) {
        const first = firstInternalById.get(int.id);
        if (first === undefined) {
          firstInternalById.set(int.id, int);
          validInternal.push(int);
          continue;
        }
        // One internal id is one ledger entry. A second record with it is a
        // double booking (or a second charge filed under the first's id):
        // report it, keep it out of matching — the charge it names then
        // shows up as unmatched — and the run cannot read "Perfect".
        const repeated: ReconciliationMatch = {
          internalId: int.id,
          status: "duplicate",
          duplicate: true,
          notes: `Internal records contain id ${int.id} more than once; this record (${int.amount.amount} ${currencyCode(int.amount)}${int.providerPaymentId ? `, ${int.providerPaymentId}` : ""}${int.reference ? `, reference ${int.reference}` : ""}) was not reconciled — the first (${first.amount.amount} ${currencyCode(first.amount)}${first.providerPaymentId ? `, ${first.providerPaymentId}` : ""}) was`,
        };
        repeatedIdRows.add(repeated);
        matches.push(repeated);
        continue;
      }
      const id = (int as { id?: unknown } | null)?.id;
      matches.push({ internalId: typeof id === "string" ? id : undefined, status: "invalid", notes: `Internal record not reconciled: ${reason}` });
    }
    const invalidProviderIds = new Set<string>();
    // First provider record per id; `claimedBy` maps provider id → internal id.
    const providerById = new Map<string, ProviderRecord>();
    for (const p of provider) {
      const reason = invalidRecordReason(p);
      if (reason !== null) {
        const id = (p as { id?: unknown } | null)?.id;
        if (typeof id === "string") invalidProviderIds.add(id);
        matches.push({ providerId: typeof id === "string" ? id : undefined, status: "invalid", notes: `Provider record not reconciled: ${reason}` });
        continue;
      }
      const first = providerById.get(p.id);
      if (first === undefined) {
        providerById.set(p.id, p);
        continue;
      }
      // A provider id is one charge. A second record with it is either an
      // export glitch or a second charge hiding under the first's id — never
      // drop it silently: report it, and the run cannot read "Perfect".
      matches.push({
        providerId: p.id,
        status: "duplicate",
        duplicate: true,
        notes: `Provider records contain id ${p.id} more than once; this record (${p.amount.amount} ${currencyCode(p.amount)}, ${p.status}) was not reconciled — the first (${first.amount.amount} ${currencyCode(first.amount)}, ${first.status}) was`,
      });
    }
    const claimedBy = new Map<string, string>();
    // The row that reports each provider charge (not a second claimant's).
    const chargeRows = new Map<string, ReconciliationMatch>();
    const awaitingFuzzy: InternalRecord[] = [];

    // Phase 1: exact providerPaymentId match
    for (const int of validInternal) {
      if (!int.providerPaymentId) {
        awaitingFuzzy.push(int);
        continue;
      }
      const prov = providerById.get(int.providerPaymentId);
      if (!prov) {
        // The record names a specific charge that the provider does not have.
        // Matching it to a different charge by amount would hide exactly the
        // discrepancy reconciliation exists to surface.
        unmatched.push({
          internalId: int.id,
          status: "unmatched_internal",
          notes: invalidProviderIds.has(int.providerPaymentId)
            ? `Provider payment ${int.providerPaymentId} is in the provider records but invalid (see its "invalid" entry), so it was not matched`
            : `Provider payment ${int.providerPaymentId} not found in provider records`,
        });
        continue;
      }
      const owner = claimedBy.get(prov.id);
      if (owner !== undefined) {
        matches.push({
          internalId: int.id,
          providerId: prov.id,
          status: "duplicate",
          duplicate: true,
          notes: `Provider payment ${prov.id} is already matched to internal record ${owner} — two internal records claim one charge`,
        });
        continue;
      }
      claimedBy.set(prov.id, int.id);
      const row = this._comparePair(int, prov, "Matched by provider payment ID");
      chargeRows.set(prov.id, row);
      matches.push(row);
    }

    // Phase 2: fuzzy match by amount + date, only for records with no provider
    // id, against provider records nobody claimed — one optimal assignment
    // over all of them, not first-fit per record (see `_assignFuzzy`).
    const unclaimed = [...providerById.values()].filter((p) => !claimedBy.has(p.id));
    const fuzzyPairs = this._assignFuzzy(awaitingFuzzy, unclaimed);
    for (const int of awaitingFuzzy) {
      const match = fuzzyPairs.get(int);
      if (match) {
        claimedBy.set(match.id, int.id);
        const row = this._comparePair(int, match, "Matched by amount+date fuzzy matching");
        chargeRows.set(match.id, row);
        matches.push(row);
      } else {
        unmatched.push({
          internalId: int.id,
          status: "unmatched_internal",
          notes: "Found in internal DB but not in provider records",
        });
      }
    }

    // Phase 3: Remaining = unmatched
    matches.push(...unmatched);
    for (const id of providerById.keys()) {
      if (claimedBy.has(id)) continue;
      const row: ReconciliationMatch = {
        providerId: id,
        status: "unmatched_provider",
        notes: "Found in provider records but not in internal DB",
      };
      chargeRows.set(id, row);
      matches.push(row);
    }

    // Possible duplicates by the same-amount-same-UTC-day heuristic (see
    // `_findDuplicates`; it never flags a record identified by its own
    // provider charge). `duplicate` is an ADDITIVE annotation — it never clobbers a mismatch
    // status. Only a record that was otherwise a clean `matched` is promoted to
    // the informative `duplicate` status; anything with a real discrepancy
    // (amount/currency/unmatched) keeps that primary status and just gains the
    // `duplicate: true` flag.
    const duplicates = this._findDuplicates(validInternal);
    for (const dup of duplicates) {
      const existing = matches.find((m) => m.internalId === dup && m.status !== "invalid" && !repeatedIdRows.has(m));
      if (existing) {
        existing.duplicate = true;
        existing.notes = `${existing.notes} — possible duplicate payment detected`;
        if (existing.status === "matched") {
          existing.status = "duplicate";
        }
      }
    }

    this._flagDoubleCharges(providerById, claimedBy, firstInternalById, chargeRows);

    // Count AFTER all mutations so a record annotated as duplicate is not
    // silently dropped from its bucket. A `matched`-turned-`duplicate` correctly
    // leaves the matched tally; a mismatch-plus-duplicate stays in its bucket
    // AND is counted as a duplicate.
    const matched = matches.filter((m) => m.status === "matched").length;
    const unmatchedInt = matches.filter((m) => m.status === "unmatched_internal").length;
    const unmatchedProv = matches.filter((m) => m.status === "unmatched_provider").length;
    const amtMismatches = matches.filter((m) => m.status === "amount_mismatch").length;
    const currMismatches = matches.filter((m) => m.status === "currency_mismatch").length;
    const statusMismatches = matches.filter((m) => m.status === "status_mismatch").length;
    const refundMismatches = matches.filter((m) => m.status === "refund_mismatch").length;
    const refundsUnverified = matches.filter((m) => m.status === "refund_unverified").length;
    const referenceMismatches = matches.filter((m) => m.status === "reference_mismatch").length;
    const dupCount = matches.filter((m) => m.duplicate === true || m.status === "duplicate").length;
    const invalidCount = matches.filter((m) => m.status === "invalid").length;
    const doubleCharges = matches.filter((m) => m.possibleDoubleCharge === true).length;

    const issues = unmatchedInt + unmatchedProv + amtMismatches + currMismatches + statusMismatches + refundMismatches + refundsUnverified + referenceMismatches + dupCount + invalidCount;
    const outcome = this._outcomeOf(internal.length, provider.length, issues);
    const summary = this._buildSummary(
      outcome,
      matched,
      unmatchedInt,
      unmatchedProv,
      amtMismatches,
      currMismatches,
      statusMismatches,
      refundMismatches,
      refundsUnverified,
      referenceMismatches,
      dupCount,
      doubleCharges,
      invalidCount,
      internal.length,
      provider.length,
    );

    return {
      runAt: new Date(),
      provider: this.provider,
      totalInternal: internal.length,
      totalProvider: provider.length,
      matched,
      unmatchedInternal: unmatchedInt,
      unmatchedProvider: unmatchedProv,
      amountMismatches: amtMismatches,
      currencyMismatches: currMismatches,
      statusMismatches,
      refundMismatches,
      refundsUnverified,
      referenceMismatches,
      duplicates: dupCount,
      possibleDoubleCharges: doubleCharges,
      invalid: invalidCount,
      outcome,
      matches,
      summary,
    };
  }

  // ─── private ─────────────────────────────────────────────────────────────

  /**
   * Classify one internal/provider pair. Precedence: currency, then amount,
   * status, refunded total, reference. Whatever a higher one hides is still named
   * in `notes`, and a status mismatch that means something specific says what to
   * check. Refunded totals are compared only where the two sides agree on the
   * outcome and the currency: otherwise that disagreement already covers them.
   */
  private _comparePair(int: InternalRecord, prov: ProviderRecord, how: string): ReconciliationMatch {
    const cmp = this._compareAmounts(int.amount, prov.amount);
    const statusOk = this._sameOutcome(int, prov);
    const statusNote = statusOk ? "" : ` Status mismatch: internal=${shownStatus(int)} provider=${shownStatus(prov)}.${this._mismatchHint(int, prov)}`;
    const refund: RefundComparison = statusOk && cmp.kind !== "currency_mismatch" ? this._compareRefunds(int, prov) : { kind: "ok" };
    const refundNote = refund.kind === "ok" ? "" : ` ${refund.notes}`;
    const referenceDiffers = int.reference !== undefined && prov.reference !== undefined && int.reference !== prov.reference;
    const referenceNote = referenceDiffers ? ` Reference mismatch: internal=${int.reference} provider=${prov.reference}.` : "";
    const details = `${statusNote}${refundNote}${referenceNote}`;
    const base = { internalId: int.id, providerId: prov.id };
    if (cmp.kind === "currency_mismatch") {
      return {
        ...base,
        status: "currency_mismatch",
        notes: `Currency mismatch: internal=${int.amount.currency} provider=${prov.amount.currency}.${details}`,
      };
    }
    if (cmp.kind === "amount_mismatch") {
      return {
        ...base,
        status: "amount_mismatch",
        amountDiscrepancy: cmp.discrepancy,
        notes: `Amount mismatch: internal=${int.amount.amount} provider=${prov.amount.amount}.${details}`,
      };
    }
    if (!statusOk) {
      return { ...base, status: "status_mismatch", notes: details.trim() };
    }
    if (refund.kind === "refund_mismatch") {
      return { ...base, status: "refund_mismatch", amountDiscrepancy: refund.discrepancy, notes: details.trim() };
    }
    if (refund.kind === "refund_unverified") {
      return { ...base, status: "refund_unverified", notes: details.trim() };
    }
    if (referenceDiffers) {
      return { ...base, status: "reference_mismatch", notes: details.trim() };
    }
    return { ...base, status: "matched", notes: how };
  }

  /** An internal record's outcome; `undefined` for a status outside the table. */
  private _internalOutcome(int: InternalRecord): Outcome | undefined {
    return outcomeWithRefunds(STATUS_OUTCOME[int.status.toLowerCase()], int);
  }

  /** A provider record's outcome; `undefined` for a status outside the tables. */
  private _providerOutcome(prov: ProviderRecord): Outcome | undefined {
    const status = prov.status.toLowerCase();
    const outcome = (this.config.providerRecordType === "balance_transaction" ? BALANCE_TRANSACTION_OUTCOME[status] : undefined) ?? STATUS_OUTCOME[status];
    return outcomeWithRefunds(outcome, prov);
  }

  /**
   * Do two records describe the same outcome? Known vocabularies map through
   * `STATUS_OUTCOME` (provider statuses of balance transactions via
   * `BALANCE_TRANSACTION_OUTCOME`); if either side is unknown, the raw strings
   * must match case-insensitively.
   */
  private _sameOutcome(int: InternalRecord, prov: ProviderRecord): boolean {
    const internal = this._internalOutcome(int);
    const provider = this._providerOutcome(prov);
    if (internal !== undefined && provider !== undefined) return outcomesAgree(internal, provider);
    return int.status.toLowerCase() === prov.status.toLowerCase();
  }

  /**
   * Compare what two records state was refunded, within `toleranceAmount`. A
   * partially refunded pair must state it on both sides: agreeing that SOME of
   * the money went back says nothing about how much. Elsewhere a row with no
   * total claims no refund, so it reads as 0.
   */
  private _compareRefunds(int: InternalRecord, prov: ProviderRecord): RefundComparison {
    const internalOutcome = this._internalOutcome(int);
    const internal = statedRefund(int, internalOutcome);
    const provider = statedRefund(prov, this._providerOutcome(prov));
    if (internalOutcome === "partially_refunded" && (internal === undefined || provider === undefined)) {
      const said = (side: string, total: number | undefined) => `the ${side} record ${total === undefined ? "states no amountRefunded" : `states ${total}`}`;
      return {
        kind: "refund_unverified",
        notes: `Refund not verified: both sides show a partial refund, but ${said("internal", internal)} and ${said("provider", provider)}. Set amountRefunded on both to compare them.`,
      };
    }
    const diff = Math.abs((internal ?? 0) - (provider ?? 0));
    if (diff > this.config.toleranceAmount) {
      return {
        kind: "refund_mismatch",
        notes: `Refund mismatch: internal refunded ${internal ?? 0}, provider refunded ${provider ?? 0}.`,
        discrepancy: { amount: diff, currency: currencyCode(int.amount) },
      };
    }
    return { kind: "ok" };
  }

  /** What to check when a status mismatch has a known meaning. */
  private _mismatchHint(int: InternalRecord, prov: ProviderRecord): string {
    const internal = this._internalOutcome(int);
    const provider = this._providerOutcome(prov);
    const refund = (o?: Outcome) => o === "refunded" || o === "partially_refunded";
    if (refund(internal) && provider === "succeeded") {
      return ' Confirm the refund itself: a Stripe PaymentIntent or Charge stays "succeeded" after a refund, so this status cannot show that it happened. State the charge\'s refunded total as amountRefunded.';
    }
    if (refund(provider) && internal === "succeeded") {
      return " The provider shows a refund the ledger has not recorded.";
    }
    if (internal === "in_flight" && provider === "nothing_taken") {
      return " The ledger has money in flight and the provider shows nothing taken: Stripe returns a PaymentIntent to requires_payment_method when a debit fails.";
    }
    if (internal === "pending" && provider === "in_flight") {
      return " The provider has money in flight or on hold that the ledger has not recorded.";
    }
    return "";
  }

  /**
   * Compare an internal amount against a provider amount.
   *
   * Never subtracts across currencies — differing currencies yield a distinct
   * `currency_mismatch` outcome with no (meaningless) numeric diff. Currency
   * codes compare case-insensitively; a discrepancy is reported in upper case.
   */
  private _compareAmounts(a: Money, b: Money): AmountComparison {
    if (currencyCode(a) !== currencyCode(b)) {
      return { kind: "currency_mismatch" };
    }
    const diff = Math.abs(a.amount - b.amount);
    if (diff > this.config.toleranceAmount) {
      return { kind: "amount_mismatch", discrepancy: { amount: diff, currency: currencyCode(a) } };
    }
    return { kind: "ok" };
  }

  /**
   * Phase-2 pairing: an optimal assignment between internal records without a
   * provider id and unclaimed provider records. A pair is eligible when the
   * currencies agree, the amounts differ by at most `toleranceAmount`, and the
   * timestamps by at most the date window. Among all assignments of eligible
   * pairs, this returns one with the MOST pairs and, among those, the
   * SMALLEST total time distance. Greedy first-fit could leave records
   * unmatched that a different pairing matches (internal A at 0h and B at
   * +40h, provider P1 at +20h and P2 at -20h: first-fit pairs A–P1 and strands
   * B and P2, although A–P2 and B–P1 are both within ±1 day), and it depended
   * on input order.
   *
   * Records are first put in a canonical order (time, id, amount), so the
   * result does not depend on the order of the input arrays. Eligible pairs
   * split into connected components (records that could possibly pair with
   * each other); each component is solved exactly with the Hungarian
   * algorithm, O(k²·l) for a component of k × l records — milliseconds for the
   * small components id-less records normally form; a component of thousands
   * (one amount, one day, no provider ids) takes correspondingly longer.
   */
  private _assignFuzzy(
    internal: InternalRecord[],
    candidates: ProviderRecord[],
  ): Map<InternalRecord, ProviderRecord> {
    const pairs = new Map<InternalRecord, ProviderRecord>();
    if (internal.length === 0 || candidates.length === 0) return pairs;

    const windowMs = this.config.fuzzyDate ? FUZZY_DATE_WINDOW_MS : 0;
    const canonical = <T extends { id: string; createdAt: Date; amount: Money }>(a: T, b: T) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      a.amount.amount - b.amount.amount;
    const ints = [...internal].sort(canonical);
    const provs = [...candidates].sort(canonical);

    // Eligible pairs, cost = time distance in ms.
    const n = ints.length;
    const edges: Array<{ i: number; j: number; cost: number }> = [];
    for (let i = 0; i < n; i++) {
      const a = ints[i];
      for (let j = 0; j < provs.length; j++) {
        const b = provs[j];
        if (currencyCode(a.amount) !== currencyCode(b.amount)) continue;
        if (Math.abs(a.amount.amount - b.amount.amount) > this.config.toleranceAmount) continue;
        const dt = Math.abs(a.createdAt.getTime() - b.createdAt.getTime());
        if (dt > windowMs) continue;
        edges.push({ i, j, cost: dt });
      }
    }

    // Connected components over the bipartite graph (internal i ↦ i,
    // provider j ↦ n + j).
    const parent = Array.from({ length: n + provs.length }, (_, k) => k);
    const find = (k: number): number => {
      while (parent[k] !== k) {
        parent[k] = parent[parent[k]];
        k = parent[k];
      }
      return k;
    };
    for (const e of edges) parent[find(e.i)] = find(n + e.j);
    const components = new Map<number, { rows: number[]; cols: number[]; edges: typeof edges }>();
    for (const e of edges) {
      const root = find(e.i);
      let c = components.get(root);
      if (!c) components.set(root, (c = { rows: [], cols: [], edges: [] }));
      c.edges.push(e);
    }
    for (const c of components.values()) {
      c.rows = [...new Set(c.edges.map((e) => e.i))].sort((x, y) => x - y);
      c.cols = [...new Set(c.edges.map((e) => e.j))].sort((x, y) => x - y);
    }

    for (const c of components.values()) {
      // Rows = the smaller side, so every row gets a column.
      const transpose = c.rows.length > c.cols.length;
      const rows = transpose ? c.cols : c.rows;
      const cols = transpose ? c.rows : c.cols;
      const rowIdx = new Map(rows.map((r, k) => [r, k]));
      const colIdx = new Map(cols.map((r, k) => [r, k]));
      // An ineligible pair costs more than any set of eligible ones, so the
      // minimum-cost assignment first maximises the number of eligible pairs,
      // then minimises their total distance.
      const big = rows.length * windowMs + 1;
      const cost = rows.map(() => new Array<number>(cols.length).fill(big));
      for (const e of c.edges) {
        const r = rowIdx.get(transpose ? e.j : e.i)!;
        const k = colIdx.get(transpose ? e.i : e.j)!;
        cost[r][k] = e.cost;
      }
      const assignment = minCostAssignment(cost);
      for (let r = 0; r < rows.length; r++) {
        const k = assignment[r];
        if (k < 0 || cost[r][k] === big) continue;
        const i = transpose ? cols[k] : rows[r];
        const j = transpose ? rows[r] : cols[k];
        pairs.set(ints[i], provs[j]);
      }
    }
    return pairs;
  }

  /**
   * Same-amount-same-day heuristic for double-submits, applied only where a
   * record's identity is unknown.
   *
   * A record carrying a `providerPaymentId` is identified by that charge: two
   * customers who each bought the same plan on the same day match their own
   * charges and are not duplicates, and two records claiming ONE charge are
   * already reported in phase 1. A record with no provider id is flagged when
   * another record in its group could be the same payment — every id-less
   * record if the group has an identified one, otherwise all but the first.
   *
   * Days are UTC calendar days, so the verdict never depends on the server's
   * time zone.
   */
  private _findDuplicates(records: InternalRecord[]): Set<string> {
    const groups = new Map<string, InternalRecord[]>();
    for (const r of records) {
      const utcDay = r.createdAt.toISOString().slice(0, 10);
      const key = `${r.amount.amount}_${currencyCode(r.amount)}_${utcDay}`;
      const group = groups.get(key);
      if (group) group.push(r);
      else groups.set(key, [r]);
    }

    const dupes = new Set<string>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const unidentified = group.filter((r) => !r.providerPaymentId);
      const flagged = unidentified.length < group.length ? unidentified : unidentified.slice(1);
      for (const r of flagged) dupes.add(r.id);
    }
    return dupes;
  }

  /**
   * Flag charges that share a `reference` as possible double charges: one order
   * paid on two PaymentIntents reconciles cleanly charge by charge, so nothing
   * else can see it. A charge's reference is its own `ProviderRecord.reference`,
   * else that of the internal record that claimed it.
   *
   * Every charge that may hold money counts: a positive amount (a refund row is
   * not a second charge) and a status that does not rule it out. Failed (a
   * failed attempt before a successful retry is normal), fully refunded (already
   * put right, whether the status or `amountRefunded` says so) and `nothing_taken`
   * do; anything else counts, including a debit in flight, a live hold, a bare
   * `pending` (what a Stripe Charge says of such a debit) and an unknown status,
   * because a nightly run may only ever see them in that state.
   * Amounts need not be equal — an order
   * charged again at a changed price is exactly as wrong. The earliest charge
   * stays as it is and each later one is flagged, naming the earliest, so the
   * verdict does not depend on input order. Like the duplicate heuristic this
   * is additive: only a clean `matched` is promoted to `duplicate`.
   */
  private _flagDoubleCharges(
    providerById: Map<string, ProviderRecord>,
    claimedBy: Map<string, string>,
    internalById: Map<string, InternalRecord>,
    chargeRows: Map<string, ReconciliationMatch>,
  ): void {
    const byReference = new Map<string, ProviderRecord[]>();
    for (const p of providerById.values()) {
      const claimant = claimedBy.get(p.id);
      const reference = p.reference ?? (claimant !== undefined ? internalById.get(claimant)?.reference : undefined);
      if (reference === undefined || p.amount.amount <= 0) continue;
      const outcome = this._providerOutcome(p);
      if (outcome === "failed" || outcome === "refunded" || outcome === "nothing_taken") continue;
      const group = byReference.get(reference);
      if (group) group.push(p);
      else byReference.set(reference, [p]);
    }
    for (const [reference, group] of byReference) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const first = group[0];
      for (const charge of group.slice(1)) {
        const row = chargeRows.get(charge.id)!;
        row.duplicate = true;
        row.possibleDoubleCharge = true;
        row.notes = `${row.notes} — possible double charge: reference ${reference} was also charged on ${first.id} (${first.amount.amount} ${currencyCode(first.amount)}), this one is ${charge.amount.amount} ${currencyCode(charge.amount)}`;
        if (row.status === "matched") row.status = "duplicate";
      }
    }
  }

  private _outcomeOf(internalCount: number, providerCount: number, issues: number): ReconciliationOutcome {
    if (internalCount === 0 && providerCount === 0) return "nothing_to_reconcile";
    if (internalCount === 0) return "internal_records_empty";
    if (providerCount === 0) return "provider_records_empty";
    return issues === 0 ? "perfect" : "review_required";
  }

  private _buildSummary(
    outcome: ReconciliationOutcome,
    matched: number,
    unmatchedInt: number,
    unmatchedProv: number,
    amtMismatches: number,
    currMismatches: number,
    statusMismatches: number,
    refundMismatches: number,
    refundsUnverified: number,
    referenceMismatches: number,
    duplicates: number,
    doubleCharges: number,
    invalid: number,
    total: number,
    totalProvider: number,
  ): string {
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    // Empty inputs say so first: a run with nothing to compare has verified
    // nothing, and an export that failed looks exactly like this.
    if (outcome === "nothing_to_reconcile") {
      return "Nothing to reconcile: both record sets are empty. This verifies nothing; confirm the period really had no payments.";
    }
    if (outcome === "internal_records_empty") {
      return `Reconciliation error: the internal records are empty but ${count(totalProvider, "provider record was", "provider records were")} supplied. Check the ledger export before trusting this run.`;
    }
    if (outcome === "provider_records_empty") {
      return `Reconciliation error: the provider records are empty but ${count(total, "internal record was", "internal records were")} supplied. Check the provider export before trusting this run.`;
    }
    // "Perfect" only when every comparison the engine makes agreed: a possible
    // duplicate or an unusable record is a reason to review even if every amount
    // matched.
    if (outcome === "perfect") {
      return `Perfect reconciliation: all ${matched} records matched.`;
    }
    const parts: string[] = [`Matched ${matched}/${total}.`];
    if (unmatchedInt > 0) parts.push(`${count(unmatchedInt, "internal record", "internal records")} unmatched.`);
    if (unmatchedProv > 0) parts.push(`${count(unmatchedProv, "provider record", "provider records")} unmatched.`);
    if (amtMismatches > 0) parts.push(`${count(amtMismatches, "amount mismatch", "amount mismatches")}.`);
    if (currMismatches > 0) parts.push(`${count(currMismatches, "currency mismatch", "currency mismatches")}.`);
    if (statusMismatches > 0) parts.push(`${count(statusMismatches, "status mismatch", "status mismatches")}.`);
    if (refundMismatches > 0) parts.push(`${count(refundMismatches, "refund mismatch", "refund mismatches")}.`);
    if (refundsUnverified > 0) parts.push(`${count(refundsUnverified, "partial refund", "partial refunds")} not verified.`);
    if (referenceMismatches > 0) parts.push(`${count(referenceMismatches, "reference mismatch", "reference mismatches")}.`);
    // `duplicates` includes double charges in the report; here each row is named once.
    const otherDuplicates = duplicates - doubleCharges;
    if (otherDuplicates > 0) parts.push(`${count(otherDuplicates, "possible duplicate", "possible duplicates")}.`);
    if (doubleCharges > 0) parts.push(`${count(doubleCharges, "possible double charge", "possible double charges")}.`);
    if (invalid > 0) parts.push(`${count(invalid, "invalid record", "invalid records")} not reconciled.`);
    parts.push("Review required.");
    return parts.join(" ");
  }
}
