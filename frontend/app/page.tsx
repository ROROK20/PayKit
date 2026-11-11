"use client";

import { useState, useRef, useEffect, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  CountingMockProvider, IdempotentPaymentExecutor, InMemoryIdempotencyStore, BrowserWebhookEngine, FraudDetector,
  WebhookSignatureError, normalizeStripeEventType, type PaymentIntent, type FraudCheckResult,
} from "@/lib/sdk";
import { pingBackend, isApiConfigured, checkFraud, withFallback, type ApiMode } from "@/lib/api";
import clsx from "clsx";

// DEMO-ONLY webhook secret. The playground signs and verifies webhooks entirely
// in your browser against this fake value — it is not a real Stripe secret and
// touches no real account. In a real app, never hardcode a webhook secret in
// client code: keep it server-side in an env var (e.g. process.env.STRIPE_WEBHOOK_SECRET).
const SECRET = "whsec_demo_secret_key_for_playground_only";

type Tab = "payment" | "webhook" | "fraud";

/** Every claim about where work runs, one total map: an unhandled mode is a compile error. */
const MODE_COPY: Record<ApiMode, { badge: string; title: string; servedBy: string }> = {
  live: {
    badge: "Fraud tab: live backend",
    title: "Fraud checks are served by a live PayKit backend (NEXT_PUBLIC_API_URL). Payments and webhooks still run in your browser.",
    servedBy: "· via live backend",
  },
  demo: {
    badge: "In-browser SDK",
    title: "Running the real PayKit SDK entirely in your browser against its mock provider: no backend needed.",
    servedBy: "· via in-browser SDK",
  },
};

/**
 * Small badge telling the user where work runs. A backend only ever serves the
 * fraud tab (see lib/api.ts), so "live" says that and no more.
 */
function ModeBadge({ mode }: { mode: ApiMode }) {
  const { badge, title } = MODE_COPY[mode];
  return (
    <span title={title} className="mono-tight inline-flex min-h-6 items-center border-[1.5px] border-ink px-2 text-xs font-bold">
      {badge}
    </span>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// ── THE TRACE ────────────────────────────────────────────────────────────────

/** A charge the executor answered. Both witnesses come from after the call. */
type Answered = { kind: "answered"; seq: number; intent: PaymentIntent; providerCalls: number };
/** A charge that threw instead: bad input, or one key on two different requests. */
type Refused = { kind: "refused"; seq: number; key: string; reason: string; providerCalls: number };
/** The cache was dropped here, which is why the next repeat of a key is a MISS. */
type Dropped = { kind: "dropped" };
type TraceEvent = Answered | Refused | Dropped;

/** Everything the band and the payments tab read, updated in one step so they cannot disagree. */
type Ledger = { trace: TraceEvent[]; providerCalls: number; charges: number };

const isAnswered = (e: TraceEvent): e is Answered => e.kind === "answered";
const isRefused = (e: TraceEvent): e is Refused => e.kind === "refused";

function tally<T>(items: T[], key: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

const cacheVerdict = (tag?: string) => (!tag ? "MISS" : tag === "cache_hit" ? "HIT" : "JOIN");

export default function Home() {
  const [tab, setTab] = useState<Tab>("payment");
  const [mode, setMode] = useState<ApiMode>("demo");
  const [ledger, setLedger] = useState<Ledger>({ trace: [], providerCalls: 0, charges: 0 });
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  // Detect whether a live backend is reachable. On any failure we stay in
  // "demo" mode (the real SDK runs in-browser), so the page always works.
  useEffect(() => {
    let cancelled = false;
    if (!isApiConfigured) return;
    pingBackend()
      .then((ok) => {
        if (!cancelled && ok) setMode("live");
      })
      .catch(() => {
        /* stay in demo mode */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // shared instances per session — the REAL paykit primitives
  const providerRef = useRef(new CountingMockProvider({ successRate: 1.0 }));
  const storeRef = useRef(new InMemoryIdempotencyStore());
  const executorRef = useRef(new IdempotentPaymentExecutor(providerRef.current, { store: storeRef.current }));
  const webhookRef = useRef(new BrowserWebhookEngine());
  const fraudRef = useRef(new FraudDetector());

  return (
    <div className="flex min-h-screen flex-col">
      <header className="wrap flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="mono-wide text-lg font-extrabold">PayKit</h1>
          <p className="text-sm text-ink-2">TypeScript payments SDK · Playground</p>
        </div>
        <div className="flex items-center gap-3">
          <ModeBadge mode={mode} />
          <a
            href="https://github.com/ROROK20/PayKit"
            aria-label="View PayKit source on GitHub"
            className="mono-tight inline-flex min-h-6 items-center text-xs font-semibold underline decoration-[1.5px] underline-offset-[3px] hover:bg-signal"
          >
            View Source
          </a>
        </div>
      </header>

      <Band ledger={ledger} />

      <section aria-labelledby="what-runs" className="wrap w-full py-5">
        <h2 id="what-runs" className="mono text-[0.8125rem] font-bold">Interactive SDK Playground</h2>
        <div className="mt-2 grid gap-x-8 gap-y-2 text-[0.9375rem] leading-[1.45] md:grid-cols-3">
          <p>
            Test idempotent payments, webhook signature verification, and fraud detection: powered by the
            {" "}<strong className="font-semibold">real PayKit SDK</strong> imported straight from the
            {" "}<code className="mono-tight text-[0.8125rem]">paykit</code> package.
          </p>
          <p>
            Payments go to its in-memory mock provider, so nothing is charged.
            The webhook tab runs a Web Crypto reimplementation of its engine, held to it by a parity test.
          </p>
          <p>
            By default everything runs in your browser (no backend); set <code className="mono-tight text-[0.8125rem]">NEXT_PUBLIC_API_URL</code> to send fraud checks to a live backend instead.
          </p>
        </div>
      </section>

      <div className="bench">
        <div className="wrap">
          <div className="flex overflow-x-auto" role="tablist" aria-label="SDK feature tabs">
            {[
              { id: "payment" as const, label: "Idempotent Payments" },
              { id: "webhook" as const, label: "Webhooks" },
              { id: "fraud" as const, label: "Fraud Detection" },
            ].map(({ id, label }) => (
              <button
                key={id}
                id={`tab-${id}`}
                role="tab"
                aria-selected={tab === id}
                aria-label={label}
                onClick={() => setTab(id)}
                className="tab"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="flex-1">
        <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "payment" && (
            <PaymentTab executor={executorRef.current} provider={providerRef.current} store={storeRef.current} ledger={ledger} setLedger={setLedger} />
          )}
          {tab === "webhook" && <WebhookTab engine={webhookRef.current} deliveries={deliveries} setDeliveries={setDeliveries} />}
          {tab === "fraud" && <FraudTab detector={fraudRef.current} mode={mode} />}
        </div>
      </main>

      <footer className="mt-10 border-t border-ink">
        <div className="wrap flex justify-between gap-4 py-4 text-[0.8125rem]">
          <p>PayKit · Open-source TypeScript SDK · MIT License</p>
          <p className="mono-tight text-xs">v0.1.0</p>
        </div>
      </footer>
    </div>
  );
}

// ── THE BAND ─────────────────────────────────────────────────────────────────

/**
 * The SDK's point, then what this session has actually done. Every figure is
 * read from the ledger, and the provider's own list of payments is what counts
 * as a charge, so the line starts at zero and only ever says what happened.
 */
function Band({ ledger }: { ledger: Ledger }) {
  const answered = ledger.trace.filter(isAnswered);
  const refused = ledger.trace.filter(isRefused).length;
  const requests = answered.length + refused;
  const { charges, providerCalls } = ledger;
  const fewerChargesThanRequests = charges > 0 && requests > charges;

  const hits = answered.filter((a) => a.intent.metadata?._idempotency).length;
  const seen = new Set<string>();
  let replays = 0;
  for (const a of answered) {
    if (a.providerCalls > 0 && seen.has(a.intent.id)) replays++;
    seen.add(a.intent.id);
  }

  const note: string[] = [];
  if (requests === 0) {
    note.push("Nothing sent yet. Press Charge Card, then press it again with the same key.");
  } else {
    note.push(`The provider was called ${times(providerCalls)}.`);
    if (hits > 0) note.push(`${count(hits, "request")} stopped at the idempotency cache.`);
    if (replays > 0) note.push(`It replayed the key's original payment ${times(replays)}, charging nothing new.`);
    if (refused > 0) note.push(`${refused} refused.`);
    if (requests === 1 && answered.length === 1) note.push("Press Charge Card again with the same key.");
  }

  return (
    <section className="band" aria-labelledby="the-point">
      <div className="wrap py-5 md:py-6">
        <h2 id="the-point" className="max-w-[60ch] text-lg font-semibold leading-snug md:text-[1.375rem]">
          A retried request does not charge twice, within the window a key is remembered.
        </h2>
        <p className="counters mt-2" aria-live="polite">
          {count(requests, "request")},{" "}
          <span className={clsx(fewerChargesThanRequests && "counters-proved")}>{count(charges, "charge")}</span>
        </p>
        <p className="mt-2 max-w-[75ch] text-base font-medium leading-snug">{note.join(" ")}</p>
        <noscript>
          <p className="mt-2 text-base font-semibold">This playground runs the SDK in your browser, so it needs JavaScript.</p>
        </noscript>
      </div>
    </section>
  );
}

// ── SHARED PARTS ─────────────────────────────────────────────────────────────

function Field({ id, label, note, children }: { id: string; label: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="field-label">{label}</label>
      {children}
      {note && <p className="field-note">{note}</p>}
    </div>
  );
}

/** A highlighter mark, only when the thing it covers really matched something. */
function Matched({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <mark>{children}</mark> : <>{children}</>;
}

function LaneHeads({ left, middle, right }: { left: string; middle: string; right: string }) {
  return (
    <div className="lane-heads" aria-hidden="true">
      <span>{left}</span>
      <span>{middle}</span>
      <span>{right}</span>
    </div>
  );
}

function TryThis({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-[75ch] text-[0.9375rem] leading-[1.5]">
      <strong className="font-bold">Try this:</strong> {children}
    </p>
  );
}

// ── PAYMENT TAB ──────────────────────────────────────────────────────────────

/** What the executor itself says about a result: `metadata._idempotency`, absent on a call that reached the provider. */
function CacheResult({ tag }: { tag?: string }) {
  if (!tag) return <span className="font-semibold">MISS</span>;
  return (
    <span>
      <mark className="font-bold">{cacheVerdict(tag)}</mark> <code>{tag}</code>
    </span>
  );
}

const LADDER_EVENTS = 4;

/** The trace log narrows a long key's cell, but never past this many leading characters (see .trace-key). */
const KEY_UNBROKEN = 10;

function PaymentTab({ executor, provider, store, ledger, setLedger }: {
  executor: IdempotentPaymentExecutor;
  provider: CountingMockProvider;
  store: InMemoryIdempotencyStore;
  ledger: Ledger;
  setLedger: Dispatch<SetStateAction<Ledger>>;
}) {
  const [amount, setAmount] = useState(4999);
  const [key, setKey] = useState("order_abc123");
  const [description, setDescription] = useState("Premium subscription");
  const [loading, setLoading] = useState(false);
  // The executor refuses invalid input before any provider call (amount 0, a
  // float like 49.99, a value past Number.MAX_SAFE_INTEGER); show why.
  const [chargeError, setChargeError] = useState("");

  const handleCharge = async () => {
    setLoading(true);
    setChargeError("");
    // Two independent witnesses, both read AFTER the call: what the executor
    // tagged the result with, and whether the provider was actually called.
    const before = provider.createPaymentCalls;
    let outcome: Omit<Answered, "seq"> | Omit<Refused, "seq">;
    try {
      const intent = await executor.execute({
        amount: { amount, currency: "USD" },
        idempotencyKey: key,
        description,
      });
      outcome = { kind: "answered", intent, providerCalls: provider.createPaymentCalls - before };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Charge refused";
      setChargeError(reason);
      outcome = { kind: "refused", key, reason, providerCalls: provider.createPaymentCalls - before };
    }
    // A charge is a payment the provider holds: ask it, rather than infer it here.
    const held = await provider.listPayments({ limit: Number.MAX_SAFE_INTEGER });
    setLedger((l) => {
      const seq = l.trace.filter((e) => e.kind !== "dropped").length + 1;
      return {
        trace: [...l.trace, { ...outcome, seq } as TraceEvent],
        providerCalls: provider.createPaymentCalls,
        charges: held.filter((p) => p.status === "succeeded").length,
      };
    });
    setLoading(false);
  };

  const answered = ledger.trace.filter(isAnswered);
  const refused = ledger.trace.filter(isRefused).length;
  const keyCounts = tally(answered, (a) => a.intent.idempotencyKey);
  const idCounts = tally(answered, (a) => a.intent.id);

  // The trace log scrolls sideways when its columns are wider than its box (on
  // a phone, always). The hint says so only while that is measured to be true.
  const traceRef = useRef<HTMLDivElement>(null);
  const [traceScrolls, setTraceScrolls] = useState(false);
  useEffect(() => {
    const box = traceRef.current;
    if (!box) return;
    const measure = () => setTraceScrolls(box.scrollWidth > box.clientWidth);
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    // The first charge swaps the empty-state line for the table: watch that too.
    if (box.firstElementChild) watch.observe(box.firstElementChild);
    measure();
    return () => watch.disconnect();
  }, [answered.length]);

  // The three fields share their room 2:3:4, as much as each tends to hold:
  // an amount, a key, a sentence. Past 1180px the buttons take what they need
  // first. With fixed 9rem and 13rem columns the description had only what
  // was left, so at 1180px its own default ran past the box.
  return (
    <>
      <div className="bench !border-t-0">
        <form
          className="wrap grid gap-x-4 gap-y-3 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,4fr)] min-[1180px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,4fr)_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            handleCharge();
          }}
        >
          <Field id="charge-amount" label="Amount (cents)" note={`= ${dollars(amount)} USD`}>
            <input
              id="charge-amount"
              type="number"
              aria-label="Amount in cents"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="input"
            />
          </Field>
          <Field id="charge-key" label="Idempotency Key">
            <input
              id="charge-key"
              type="text"
              aria-label="Idempotency key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="input"
            />
          </Field>
          <Field id="charge-description" label="Description">
            <input
              id="charge-description"
              type="text"
              aria-label="Payment description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2 md:col-span-3 md:flex md:flex-wrap min-[1180px]:col-span-1 min-[1180px]:mt-6 min-[1180px]:items-start">
            <button type="submit" disabled={loading} aria-label="Charge card" className="btn btn-primary col-span-2 md:min-w-[9rem]">
              {loading ? "Processing..." : "Charge Card"}
            </button>
            <button
              type="button"
              onClick={() => {
                store.clear();
                setLedger((l) => (l.trace[l.trace.length - 1]?.kind === "dropped" ? l : { ...l, trace: [...l.trace, { kind: "dropped" }] }));
              }}
              aria-label="Drop idempotency cache"
              className="btn btn-quiet"
            >
              Drop Idempotency Cache
            </button>
            <button
              type="button"
              onClick={() => { provider.reset(); store.clear(); setChargeError(""); setLedger({ trace: [], providerCalls: 0, charges: 0 }); }}
              aria-label="Reset provider and idempotency cache"
              className="btn btn-quiet"
            >
              Reset Provider & Cache
            </button>
          </div>
          {chargeError && (
            <p role="alert" className="mono-tight text-xs font-semibold leading-5 text-refuse md:col-span-3 min-[1180px]:col-span-4 [overflow-wrap:anywhere]">
              {chargeError}
            </p>
          )}
        </form>
      </div>

      <div className="wrap mt-6 grid gap-x-10 gap-y-8 min-[1180px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Ladder trace={ledger.trace} keyCounts={keyCounts} idCounts={idCounts} />

        <div className="min-w-0">
          <section aria-labelledby="trace-log">
            <div className="flex min-h-7 flex-wrap items-baseline justify-between gap-x-4 pb-1.5">
              <h3 id="trace-log" className="mono text-[0.8125rem] font-bold">Trace log</h3>
              <div className="mono-tight flex flex-wrap items-baseline gap-x-3 text-xs leading-5">
                <span>{answered.length} total</span>
                {refused > 0 && <span className="font-semibold text-refuse">{refused} refused</span>}
                <span>Provider calls: <span aria-label="Provider calls" className="font-bold">{ledger.providerCalls}</span></span>
              </div>
            </div>
            {traceScrolls && (
              <p data-scroll-hint className="mono-tight pb-1.5 text-xs leading-5 text-ink-2">
                Scroll the log sideways for every column →
              </p>
            )}
            <div ref={traceRef} className="max-h-96 overflow-auto border-t-[1.5px] border-ink" tabIndex={0} role="region" aria-labelledby="trace-log">
              {answered.length === 0 ? (
                <p className="py-6 text-[0.9375rem]">
                  No charges yet. Click &quot;Charge Card&quot; to start.
                </p>
              ) : (
                <table className="trace">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">ID</th>
                      <th scope="col">Key</th>
                      <th scope="col">Status</th>
                      <th scope="col" className="num">Amount</th>
                      <th scope="col">Cache</th>
                      <th scope="col" className="num">Provider</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...answered].reverse().slice(0, 10).map((p) => (
                      <tr key={p.seq}>
                        <th scope="row">{p.seq}</th>
                        <td><Matched on={(idCounts.get(p.intent.id) ?? 0) > 1}>{p.intent.id.slice(0, 22)}…</Matched></td>
                        <td>
                          <span className="trace-key" title={p.intent.idempotencyKey}>
                            <Matched on={(keyCounts.get(p.intent.idempotencyKey) ?? 0) > 1}>
                              <span className="whitespace-nowrap">{p.intent.idempotencyKey.slice(0, KEY_UNBROKEN)}</span>
                              {p.intent.idempotencyKey.slice(KEY_UNBROKEN)}
                            </Matched>
                          </span>
                        </td>
                        <td className={clsx(p.intent.status === "failed" && "font-semibold text-refuse")}>{p.intent.status}</td>
                        <td className="num">{dollars(p.intent.amount.amount)}</td>
                        <td><CacheResult tag={p.intent.metadata?._idempotency} /></td>
                        <td className={clsx("num", p.providerCalls === 0 && "font-bold")}>+{p.providerCalls}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {answered.length > 10 && <p className="mono-tight pt-1.5 text-xs leading-5 text-ink-2">Newest 10 shown.</p>}
          </section>

          <div className="mt-4 border-t border-rule pt-4">
            <TryThis>
              Click &quot;Charge Card&quot; twice without changing the key. The second is a <strong>HIT</strong>, served by the executor&apos;s idempotency cache, and the provider-call count does not move. Then drop the cache and charge again: a <strong>MISS</strong>, the provider IS called, and it replays the same payment because it honours the key too.
            </TryThis>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The request ladder. Each rung is drawn from what the call reported, never from
 * what it should have done: a request reaches the provider's lifeline only if
 * the provider's own call count moved.
 */
function Ladder({ trace, keyCounts, idCounts }: { trace: TraceEvent[]; keyCounts: Map<string, number>; idCounts: Map<string, number> }) {
  const recent = trace.slice(-LADDER_EVENTS);
  const earlier = trace.slice(0, -LADDER_EVENTS).filter((e) => e.kind !== "dropped").length;
  const seenIds = new Set<string>();
  const replayed = new Set<number>();
  for (const e of trace) {
    if (e.kind !== "answered") continue;
    if (e.providerCalls > 0 && seenIds.has(e.intent.id)) replayed.add(e.seq);
    seenIds.add(e.intent.id);
  }

  return (
    <section aria-labelledby="ladder" className="min-w-0">
      <div className="flex min-h-7 flex-wrap items-baseline justify-between gap-x-4 pb-1.5">
        <h3 id="ladder" className="mono text-[0.8125rem] font-bold">Request ladder</h3>
        {earlier > 0 && <p className="mono-tight text-xs leading-5 text-ink-2">{earlier} earlier, in the trace log</p>}
      </div>
      <div className="border-t-[1.5px] border-ink pt-1.5">
        <LaneHeads left="client" middle="PayKit executor" right="mock provider" />
        {recent.length === 0 ? (
          <div className="lanes lanes-empty">
            <p>Nothing on the wire yet. Press Charge Card and the first request draws here.</p>
          </div>
        ) : (
          <ol className="lanes" aria-labelledby="ladder">
            {recent.map((e, i) => {
              const fresh = i === recent.length - 1;
              if (e.kind === "dropped") {
                return <li key={`drop-${trace.indexOf(e)}`} className="marker"><span>idempotency cache dropped</span></li>;
              }
              if (e.kind === "refused") return <RefusedRung key={e.seq} attempt={e} fresh={fresh} />;
              return (
                <AnsweredRung
                  key={e.seq}
                  attempt={e}
                  fresh={fresh}
                  keyMatched={(keyCounts.get(e.intent.idempotencyKey) ?? 0) > 1}
                  idMatched={(idCounts.get(e.intent.id) ?? 0) > 1}
                  replayed={replayed.has(e.seq)}
                />
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

function Wire({ back }: { back?: boolean }) {
  return <span aria-hidden="true" className={clsx("wire", back && "wire-back")} />;
}

function AnsweredRung({ attempt, fresh, keyMatched, idMatched, replayed }: {
  attempt: Answered;
  fresh: boolean;
  keyMatched: boolean;
  idMatched: boolean;
  replayed: boolean;
}) {
  const { intent, seq, providerCalls } = attempt;
  const tag = intent.metadata?._idempotency;
  const reachedProvider = providerCalls > 0;
  const shortId = `${intent.id.slice(0, 22)}…`;

  return (
    <li className={clsx("rung", fresh && "rung-new")}>
      <span aria-hidden="true" className={clsx("act act-mid", !reachedProvider && "act-stop")} />
      {reachedProvider && <span aria-hidden="true" className="act act-end" />}

      <div className="hop">
        <p className="hop-label">
          <b>#{seq}</b>
          <span className="hop-clip" title={intent.idempotencyKey}><span className="max-sm:hidden">charge </span><Matched on={keyMatched}>{intent.idempotencyKey}</Matched></span>
        </p>
        <Wire />
      </div>
      {reachedProvider ? (
        <div className="hop">
          <p className="hop-label">
            <b>{cacheVerdict(tag)}</b>
            <span>createPayment</span>
            <b className="ml-auto">+{providerCalls}</b>
          </p>
          <Wire />
        </div>
      ) : (
        <div className="hop">
          <p className="stop stop-match">{cacheVerdict(tag)}</p>
          <code className="mono-tight ml-2 text-xs">{tag}</code>
        </div>
      )}

      <div className="hop">
        <p className="hop-label">
          <span>{intent.status}</span>
          <span>{dollars(intent.amount.amount)}</span>
          {!reachedProvider && <span className="hop-clip"><Matched on={idMatched}>{shortId}</Matched></span>}
        </p>
        <Wire back />
      </div>
      {reachedProvider ? (
        <div className="hop">
          <p className="hop-label">
            <span className="hop-clip"><Matched on={idMatched}>{shortId}</Matched></span>
            {replayed && <span>replayed, same payment</span>}
          </p>
          <Wire back />
        </div>
      ) : (
        <div className="hop">
          <p className="hop-label hop-quiet"><span>provider not called, +{providerCalls}</span></p>
        </div>
      )}
    </li>
  );
}

function RefusedRung({ attempt, fresh }: { attempt: Refused; fresh: boolean }) {
  const reachedProvider = attempt.providerCalls > 0;
  return (
    <li className={clsx("rung", fresh && "rung-new")}>
      <span aria-hidden="true" className={clsx("act act-mid act-short", !reachedProvider && "act-refused")} />
      {reachedProvider && <span aria-hidden="true" className="act act-end act-short act-refused" />}

      <div className="hop">
        <p className="hop-label">
          <b>#{attempt.seq}</b>
          <span className="hop-clip" title={attempt.key}><span className="max-sm:hidden">charge </span>{attempt.key}</span>
        </p>
        <Wire />
      </div>
      {reachedProvider ? (
        <div className="hop">
          <p className="hop-label"><span>createPayment</span><b className="ml-auto">+{attempt.providerCalls}</b></p>
          <Wire />
        </div>
      ) : (
        <div className="hop"><p className="stop stop-refused">REFUSED</p></div>
      )}

      <div className="col-span-2 min-w-0 bg-paper">
        <p className="hop-label !block">
          {reachedProvider && <b className="mr-2 text-refuse">REFUSED</b>}
          <span>{attempt.reason}</span>
        </p>
      </div>
    </li>
  );
}

// ── WEBHOOK TAB ──────────────────────────────────────────────────────────────

type Delivery = {
  id: number;
  timestamp: string;
  eventId: string;
  eventType: string;
  canonicalType: string;
  signature: string | undefined;
  /** The value the body held when signed, and what it was changed to afterwards. */
  tampered: { signed: string; received: string } | null;
  handlersRun: number;
  duplicate: boolean;
  signatureValid: boolean;
  rejectReason: string;
  invalidPayload: string;
  notAcked: string;
  logs: string[];
};

type Outcome = "invalid_sig" | "rejected" | "deduped" | "not_acked" | "ran";

function outcomeOf(r: Delivery): Outcome {
  if (!r.signatureValid) return "invalid_sig";
  if (r.invalidPayload) return "rejected";
  if (r.duplicate) return "deduped";
  if (r.notAcked) return "not_acked";
  return "ran";
}

/** The verdict each outcome reads, and why, as a total map. */
const VERDICTS: Record<Outcome, (r: Delivery) => { label: string; detail: string }> = {
  invalid_sig: (r) => ({ label: "INVALID SIG", detail: r.rejectReason }),
  rejected: (r) => ({ label: "REJECTED · NO EVENT ID", detail: r.invalidPayload }),
  deduped: () => ({ label: "DEDUPED", detail: "this event id was already processed: 0 handlers" }),
  not_acked: (r) => ({ label: `NOT ACKED · ${r.notAcked}`, detail: "a real provider would redeliver" }),
  ran: (r) => ({ label: `${r.handlersRun} HANDLER${r.handlersRun !== 1 ? "S" : ""} RAN`, detail: "" }),
};

const shortSignature = (signature: string) => signature.replace(/(v1=[0-9a-f]{12})[0-9a-f]+/, "$1…");

function WebhookTab({ engine, deliveries, setDeliveries }: {
  engine: BrowserWebhookEngine;
  deliveries: Delivery[];
  setDeliveries: Dispatch<SetStateAction<Delivery[]>>;
}) {
  // Real Stripe event types. The handler below is registered under PayKit's
  // canonical name (payment_intent.succeeded → payment.succeeded), so every
  // successful fire demonstrates the mapping the SDK applies.
  const [eventType, setEventType] = useState("payment_intent.succeeded");
  // Dedup is keyed on the EVENT ID, so the id has to be user-controlled and
  // reusable for the demo to be able to show a duplicate delivery at all.
  const [eventId, setEventId] = useState("evt_demo_001");
  const [paymentId, setPaymentId] = useState("pay_xyz789");
  const [useSecret, setUseSecret] = useState(true);
  const [tamperBody, setTamperBody] = useState(false);

  const fire = async () => {
    const data = { object: { id: paymentId, amount: 4999, currency: "usd" } };
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      type: eventType,
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data,
    });
    const canonicalType = normalizeStripeEventType(eventType, data);

    // Register a handler that logs. `off` (not `reset`) — reset() would also
    // clear processedIds, which is the dedup cache this tab exists to
    // demonstrate; off() just replaces this type's handler so re-firing does
    // not stack duplicates of it.
    const logs: string[] = [];
    engine.off(canonicalType);
    engine.on(canonicalType, async (e) => {
      logs.push(`✓ handler called: type=${e.type} (stripe: ${e.providerType}), id=${e.id}`);
      const obj = (e.data as { object?: { id?: string } }).object;
      logs.push(`  → fulfilling order for payment ${obj?.id ?? "unknown"}`);
    });

    const signature = useSecret ? await engine.computeSignature(payload, SECRET) : undefined;
    const bodyToProcess = useSecret && tamperBody ? payload.replace(paymentId, "TAMPERED_ID") : payload;

    // The engine throws WebhookSignatureError on a bad OR missing signature;
    // catch it so we can render INVALID SIG rather than crashing the page. The
    // receiver ALWAYS has its secret configured — the "Sign" checkbox only
    // controls whether the sender signs, so an unsigned delivery shows the
    // engine failing closed (missing_signature) instead of being processed.
    let signatureValid = true;
    let rejectReason = "";
    // A rejection that is NOT about the signature (e.g. an event with no id,
    // which the engine refuses rather than process without dedup).
    let invalidPayload = "";
    let handlersRun = 0;
    let duplicate = false;
    let notAcked = "";
    try {
      const result = await engine.process({
        rawBody: bodyToProcess,
        signature,
        secret: SECRET,
        provider: "stripe",
      });
      handlersRun = result.handlersRun;
      duplicate = result.error === "duplicate_event";
      // in_flight / handler_failed: the engine did not ack, so a real
      // provider would redeliver. Never shown as DEDUPED.
      notAcked = !result.processed && !duplicate ? result.error ?? "not_processed" : "";
    } catch (err) {
      if (err instanceof WebhookSignatureError) {
        signatureValid = false;
        rejectReason = err.reason ?? err.message;
      } else {
        invalidPayload = err instanceof Error ? err.message : "rejected";
      }
    }

    setDeliveries((previous) => [{
      id: previous.length === 0 ? 1 : previous[0].id + 1,
      timestamp: new Date().toLocaleTimeString(),
      eventId,
      eventType,
      canonicalType,
      signature,
      tampered: bodyToProcess !== payload && paymentId ? { signed: paymentId, received: "TAMPERED_ID" } : null,
      handlersRun,
      duplicate,
      signatureValid,
      rejectReason,
      invalidPayload,
      notAcked,
      logs: !signatureValid
        ? [`✗ rejected (${rejectReason}): no handlers dispatched`]
        : invalidPayload
          ? [`✗ rejected: ${invalidPayload}: no handlers dispatched`]
          : logs,
    }, ...previous]);
  };

  const handlersRun = deliveries.reduce((sum, r) => sum + r.handlersRun, 0);
  const refusals = deliveries.filter((r) => ["invalid_sig", "rejected", "not_acked"].includes(outcomeOf(r))).length;
  const dedupedIds = new Set(deliveries.filter((r) => outcomeOf(r) === "deduped").map((r) => r.eventId));

  // A select cannot be scrolled to read what it holds, so the event type's
  // column is as wide as its widest option (auto) at any width and font size,
  // and the text fields share the rest. A third of the form at 768px, or 17rem
  // past 1180px, cut payment_intent.payment_failed short.
  return (
    <>
      <div className="bench !border-t-0">
        <form
          className="wrap grid gap-x-4 gap-y-3 py-4 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] min-[1180px]:grid-cols-[auto_10rem_9rem_minmax(0,1fr)_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            fire();
          }}
        >
          <Field id="webhook-type" label="Event Type">
            <select
              id="webhook-type"
              value={eventType}
              aria-label="Webhook event type"
              onChange={(e) => setEventType(e.target.value)}
              className="input"
            >
              <option value="payment_intent.succeeded">payment_intent.succeeded</option>
              <option value="payment_intent.payment_failed">payment_intent.payment_failed</option>
              <option value="refund.created">refund.created</option>
              <option value="charge.dispute.created">charge.dispute.created</option>
            </select>
          </Field>
          <Field id="webhook-event-id" label={<>Event ID <span className="font-normal">(dedup key)</span></>}>
            <input
              id="webhook-event-id"
              type="text"
              aria-label="Event ID"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              className="input"
            />
          </Field>
          <Field id="webhook-payment-id" label="Payment ID">
            <input
              id="webhook-payment-id"
              type="text"
              aria-label="Payment ID"
              value={paymentId}
              onChange={(e) => setPaymentId(e.target.value)}
              className="input"
            />
          </Field>
          <div className="flex min-w-0 flex-col gap-1 md:col-span-2 min-[1180px]:col-span-1 min-[1180px]:mt-5">
            <label className="check">
              <input type="checkbox" checked={useSecret} onChange={(e) => setUseSecret(e.target.checked)} />
              Sign with HMAC-SHA256
            </label>
            {useSecret && (
              <label className="check check-refuse">
                <input type="checkbox" checked={tamperBody} onChange={(e) => setTamperBody(e.target.checked)} />
                Tamper body after signing (test verification)
              </label>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-start min-[1180px]:mt-6">
            <button type="submit" aria-label="Fire webhook" className="btn btn-primary md:min-w-[9rem]">
              Fire Webhook
            </button>
            <button
              type="button"
              onClick={() => { engine.reset(); setDeliveries([]); }}
              aria-label="Clear webhook dedup cache"
              className="btn btn-quiet"
            >
              Clear Cache
            </button>
          </div>
        </form>
      </div>

      <div className="wrap mt-6 grid gap-x-10 gap-y-6 min-[1180px]:grid-cols-[minmax(0,8fr)_minmax(0,4fr)]">
        <section aria-labelledby="deliveries" className="min-w-0">
          <h3 id="deliveries" className="mono-wide text-xl font-extrabold leading-tight md:text-2xl" aria-live="polite">
            <span className="whitespace-nowrap">{deliveries.length === 1 ? "1 delivery" : `${deliveries.length} deliveries`},</span>{" "}
            <span className="whitespace-nowrap">{count(handlersRun, "handler")} run{refusals > 0 && ","}</span>
            {refusals > 0 && <> <span className="whitespace-nowrap text-refuse">{refusals} refused</span></>}
          </h3>
          <div className="mt-3 border-t-[1.5px] border-ink pt-1.5">
            <LaneHeads left="sender" middle="BrowserWebhookEngine" right="handler" />
            {deliveries.length === 0 ? (
              <div className="lanes lanes-empty">
                <p>No webhooks fired yet.</p>
              </div>
            ) : (
              <ol>
                {deliveries.slice(0, 8).map((r, i) => (
                  <Receipt key={r.id} r={r} fresh={i === 0} idMatched={dedupedIds.has(r.eventId) && (outcomeOf(r) === "deduped" || outcomeOf(r) === "ran")} />
                ))}
              </ol>
            )}
          </div>
          {deliveries.length > 8 && <p className="mono-tight pt-1.5 text-xs leading-5 text-ink-2">Newest 8 shown.</p>}
        </section>

        <div className="border-t border-rule pt-4 min-[1180px]:border-t-0 min-[1180px]:pt-0">
          <TryThis>
            Tamper the body after signing: verification fails. Untick <em>Sign</em>: the receiver still holds its secret, so the unsigned delivery is rejected (fail closed). Or press <em>Fire Webhook</em> twice without changing the <strong>Event ID</strong>: dedup is keyed on the event id, so the second delivery is DEDUPED and runs 0 handlers. Change the Event ID (or press <em>Clear Cache</em>) to get a fresh delivery.
          </TryThis>
        </div>
      </div>
    </>
  );
}

function Receipt({ r, fresh, idMatched }: { r: Delivery; fresh: boolean; idMatched: boolean }) {
  const outcome = outcomeOf(r);
  const { label, detail } = VERDICTS[outcome](r);
  const passed = outcome === "ran";

  return (
    <li data-testid="webhook-delivery" className="receipt">
      <div className="mono-tight flex flex-wrap items-baseline justify-between gap-x-4 text-xs leading-5">
        <span className="font-bold">{r.eventType}</span>
        <span className="[overflow-wrap:anywhere]">{r.eventId && <><Matched on={idMatched}>{r.eventId}</Matched> · </>}{r.timestamp}</span>
      </div>
      <div className="lanes mt-1">
        <div className={clsx("rung !py-2", fresh && "rung-new")}>
          <span aria-hidden="true" className={clsx("act act-mid !top-1 !bottom-1", outcome === "deduped" && "act-stop", !passed && outcome !== "deduped" && "act-refused")} />
          {passed && <span aria-hidden="true" className="act act-end !top-1 !bottom-1" />}
          <div className="hop self-end">
            <p className="hop-label"><span>{r.signature ? shortSignature(r.signature) : "no signature header"}</span></p>
            <Wire />
          </div>
          {passed ? (
            <div className="hop self-end">
              <p className="hop-label"><span>{r.canonicalType}</span><b className="ml-auto">{label}</b></p>
              <Wire />
            </div>
          ) : (
            <div className="hop min-w-0">
              <p className={clsx("stop", outcome === "deduped" ? "stop-match" : "stop-refused stop-loud")}>{label}</p>
              <p className="hop-label mt-0.5"><span>{detail}</span></p>
            </div>
          )}
        </div>
      </div>
      {r.tampered && (
        <dl className="mono-tight mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-xs leading-5">
          <dt>signed over</dt>
          <dd className="[overflow-wrap:anywhere]">&quot;id&quot;:&quot;{r.tampered.signed}&quot;</dd>
          <dt className="font-semibold text-refuse">received</dt>
          <dd className="font-semibold text-refuse [overflow-wrap:anywhere]">&quot;id&quot;:&quot;{r.tampered.received}&quot;</dd>
        </dl>
      )}
      {r.logs.length > 0 && (
        <pre className="receipt-log">{r.logs.join("\n")}</pre>
      )}
    </li>
  );
}

// ── FRAUD TAB ────────────────────────────────────────────────────────────────

const RECOMMENDATION_STYLE: Record<FraudCheckResult["recommendation"], { verdict: string; fill: string }> = {
  approve: { verdict: "verdict-approve", fill: "bg-ink" },
  review: { verdict: "verdict-review", fill: "bg-signal" },
  decline: { verdict: "verdict-decline", fill: "bg-refuse" },
};

function FraudTab({ detector, mode }: { detector: FraudDetector; mode: ApiMode }) {
  const [amount, setAmount] = useState(25000);
  const [customerId, setCustomerId] = useState("cus_123");
  const [userAgent, setUserAgent] = useState("Mozilla/5.0");
  const [accountAgeDays, setAccountAgeDays] = useState(180);
  const [isNewPaymentMethod, setIsNewPaymentMethod] = useState(false);
  const [previousPaymentCount, setPreviousPaymentCount] = useState(3);
  const [servedBy, setServedBy] = useState<ApiMode>("demo");

  // Local synchronous evaluation with the REAL FraudDetector — always available,
  // used both as the initial render and as the fallback if the backend is down.
  const ctx = {
    amount: { amount, currency: "USD" },
    customerId: customerId || undefined,
    userAgent: userAgent || undefined,
    accountAgeDays,
    isNewPaymentMethod,
    previousPaymentCount,
  };
  const localResult: FraudCheckResult = detector.check(ctx);
  const [result, setResult] = useState<FraudCheckResult>(localResult);

  // When inputs change, try the live backend first (if configured), then fall
  // back to the in-browser detector. Never throws into the render tree.
  useEffect(() => {
    let cancelled = false;
    withFallback<FraudCheckResult>(
      () => checkFraud(ctx),
      () => detector.check(ctx),
    ).then(({ data, mode: served }) => {
      if (cancelled) return;
      setResult(data);
      setServedBy(served);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, customerId, userAgent, accountAgeDays, isNewPaymentMethod, previousPaymentCount, mode]);

  const style = RECOMMENDATION_STYLE[result.recommendation];
  const matched = result.signals.filter((s) => s.triggered);
  const rawScore = matched.reduce((sum, s) => sum + s.weight, 0);
  // Reasons no rule row states: a hard ceiling that raised the recommendation.
  const ruleReasons = new Set(matched.map((s) => s.reason));
  const otherReasons = result.reasons.filter((r) => !ruleReasons.has(r));

  // Where one matched rule's weight ends and the next begins, inside the score.
  const joints: number[] = [];
  let running = 0;
  for (const s of matched) {
    running += s.weight;
    if (running < result.riskScore) joints.push(running);
  }

  return (
    <>
      <div className="bench !border-t-0">
        <div className="wrap grid gap-x-6 gap-y-3 py-4 md:grid-cols-3">
          <div className="min-w-0 md:col-span-3">
            <h3 className="mono text-[0.8125rem] font-bold">Transaction Context</h3>
          </div>
          <Field id="fraud-amount" label={`Amount: ${dollars(amount)}`}>
            <input
              id="fraud-amount"
              type="range"
              aria-label="Transaction amount in cents"
              min={100}
              max={2_000_000}
              step={100}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="range"
            />
          </Field>
          <Field id="fraud-age" label={`Account Age: ${accountAgeDays} days`}>
            <input
              id="fraud-age"
              type="range"
              aria-label="Account age in days"
              min={0}
              max={730}
              value={accountAgeDays}
              onChange={(e) => setAccountAgeDays(Number(e.target.value))}
              className="range"
            />
          </Field>
          <Field id="fraud-velocity" label={`Payments in velocity window: ${previousPaymentCount}`}>
            <input
              id="fraud-velocity"
              type="range"
              aria-label="Payments in the velocity window"
              min={0}
              max={30}
              value={previousPaymentCount}
              onChange={(e) => setPreviousPaymentCount(Number(e.target.value))}
              className="range"
            />
          </Field>
          <Field id="fraud-customer" label="Customer ID">
            <input
              id="fraud-customer"
              type="text"
              aria-label="Customer ID"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="(leave blank for anonymous)"
              className="input"
            />
          </Field>
          <Field id="fraud-agent" label="User Agent">
            <input
              id="fraud-agent"
              type="text"
              aria-label="User agent"
              value={userAgent}
              onChange={(e) => setUserAgent(e.target.value)}
              className="input"
            />
          </Field>
          <label className="check md:mt-6 md:self-start">
            <input type="checkbox" checked={isNewPaymentMethod} onChange={(e) => setIsNewPaymentMethod(e.target.checked)} />
            New payment method
          </label>
        </div>
      </div>

      <div className="wrap mt-6 grid gap-x-10 gap-y-8 min-[1180px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby="decision" className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b-[1.5px] border-ink pb-2">
            <h3 id="decision" className="mono text-[0.8125rem] font-bold">
              Decision{" "}
              <span className="mono-tight text-xs font-normal">{MODE_COPY[servedBy].servedBy}</span>
            </h3>
            <span className={clsx("verdict", style.verdict)}>{result.recommendation.toUpperCase()}</span>
          </div>

          <dl className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <dt className="text-[0.8125rem] font-semibold">Risk Score</dt>
              <dd className="mono-wide text-5xl font-extrabold leading-none">{result.riskScore}</dd>
            </div>
            <div>
              <dt className="text-[0.8125rem] font-semibold">Risk Level</dt>
              <dd className="mono text-lg font-bold capitalize">{result.riskLevel}</dd>
            </div>
            <div>
              <dt className="text-[0.8125rem] font-semibold">Triggered Rules</dt>
              <dd className="mono text-lg font-bold">{result.reasons.length} / {result.signals.length}</dd>
            </div>
          </dl>

          <div className="mt-6">
            <div className="rail">
              <div className={clsx("rail-fill", style.fill)} style={{ width: `${result.riskScore}%` }} />
              {joints.map((at) => (
                <span key={at} className="rail-joint" style={{ left: `${at}%` }} />
              ))}
              <span className="rail-tick" style={{ left: "35%" }} />
              <span className="rail-tick" style={{ left: "70%" }} />
            </div>
            <div className="rail-labels">
              <span style={{ left: 0 }}>0</span>
              <span style={{ left: "35%", transform: "translateX(-50%)" }}>35 (Review)</span>
              <span style={{ left: "70%", transform: "translateX(-50%)" }}>70 (Decline)</span>
              <span style={{ right: 0 }}>100</span>
            </div>
          </div>

          {otherReasons.length > 0 && (
            <div className="mt-4 border-t border-rule pt-3">
              <h4 className="text-[0.8125rem] font-semibold">Past the rules</h4>
              <ul className="mt-1 space-y-1 text-[0.9375rem] leading-[1.4]">
                {otherReasons.map((reason) => (
                  <li key={reason}><mark>{reason}</mark></li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section aria-labelledby="rules" className="min-w-0">
          <h3 id="rules" className="mono border-b-[1.5px] border-ink pb-2 text-[0.8125rem] font-bold">Rule Evaluation</h3>
          <table className="w-full border-collapse text-left">
            <tbody>
              {result.signals.map((s) => (
                <tr key={s.name} className="border-b border-rule">
                  <td className="py-1.5 pr-3 align-top">
                    <div className="mono-tight text-xs font-bold leading-5 [overflow-wrap:anywhere]">
                      <Matched on={s.triggered}>{s.name}</Matched>
                    </div>
                    <div className={clsx("text-[0.8125rem] leading-[1.35]", !s.triggered && "text-ink-2")}>{s.reason}</div>
                  </td>
                  <td className={clsx("mono-tight w-20 whitespace-nowrap py-1.5 pr-3 align-top text-xs leading-5", s.triggered ? "font-semibold" : "text-ink-2")}>
                    {s.triggered ? "matched" : "no match"}
                  </td>
                  <td className={clsx("mono-tight w-10 py-1.5 text-right align-top text-xs leading-5", s.triggered ? "font-bold" : "text-ink-2")}>
                    +{s.weight}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2} className="py-2 pr-3 text-left text-[0.8125rem] font-semibold">
                  Risk Score{rawScore > result.riskScore ? `, ${rawScore} capped at ${result.riskScore}` : ""}
                </th>
                <td className="mono py-2 text-right text-sm font-extrabold">{result.riskScore}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      </div>
    </>
  );
}
