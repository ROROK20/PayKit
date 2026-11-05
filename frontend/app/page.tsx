"use client";

import { useState, useRef, useEffect } from "react";
import {
  CountingMockProvider, IdempotentPaymentExecutor, InMemoryIdempotencyStore, BrowserWebhookEngine, FraudDetector,
  WebhookSignatureError, normalizeStripeEventType, type PaymentIntent, type FraudCheckResult,
} from "@/lib/sdk";
import { pingBackend, isApiConfigured, checkFraud, withFallback, type ApiMode } from "@/lib/api";
import {
  CreditCard, Github, Webhook, Shield, RefreshCw, Send, CheckCircle2,
  XCircle, AlertCircle, KeyRound, Zap, Wifi, WifiOff,
} from "lucide-react";
import clsx from "clsx";

// DEMO-ONLY webhook secret. The playground signs and verifies webhooks entirely
// in your browser against this fake value — it is not a real Stripe secret and
// touches no real account. In a real app, never hardcode a webhook secret in
// client code: keep it server-side in an env var (e.g. process.env.STRIPE_WEBHOOK_SECRET).
const SECRET = "whsec_demo_secret_key_for_playground_only";

type Tab = "payment" | "webhook" | "fraud";

/**
 * Small badge telling the user where work runs. A backend only ever serves the
 * fraud tab (see lib/api.ts), so "live" says that and no more.
 */
function ModeBadge({ mode }: { mode: ApiMode }) {
  const live = mode === "live";
  return (
    <span
      className={clsx(
        "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border",
        live
          ? "bg-accent-green/10 text-accent-green border-accent-green/30"
          : "bg-accent-blue/10 text-accent-blue border-accent-blue/30",
      )}
      title={
        live
          ? "Fraud checks are served by a live PayKit backend (NEXT_PUBLIC_API_URL). Payments and webhooks still run in your browser."
          : "Running the real PayKit SDK entirely in your browser against its mock provider — no backend needed."
      }
    >
      {live ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      {live ? "Fraud tab: live backend" : "In-browser SDK"}
    </span>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("payment");
  const [mode, setMode] = useState<ApiMode>("demo");

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
    <main className="min-h-screen">
      <header className="border-b border-border bg-panel/30 backdrop-blur sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-gradient-to-br from-accent-blue to-purple-500 rounded-lg flex items-center justify-center glow">
              <CreditCard className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">PayKit</h1>
              <p className="text-xs text-gray-500">TypeScript payments SDK · Playground</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ModeBadge mode={mode} />
            <a href="https://github.com/ROROK20/PayKit" aria-label="View PayKit source on GitHub" className="flex items-center gap-2 px-3 py-1.5 text-xs border border-border hover:border-accent-blue rounded-md">
              <Github className="w-3.5 h-3.5" aria-hidden="true" /> View Source
            </a>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold mb-2">Interactive SDK Playground</h2>
          <p className="text-sm text-gray-400">
            Test idempotent payments, webhook signature verification, and fraud detection — powered by the
            {" "}<span className="text-accent-blue font-medium">real PayKit SDK</span> imported straight from the
            {" "}<code className="text-xs bg-bg px-1 py-0.5 rounded border border-border">paykit</code> package.
            Payments go to its in-memory mock provider, so nothing is charged.
            The webhook tab runs a Web Crypto reimplementation of its engine, held to it by a parity test.
            By default everything runs in your browser (no backend); set <code className="text-xs bg-bg px-1 py-0.5 rounded border border-border">NEXT_PUBLIC_API_URL</code> to send fraud checks to a live backend instead.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex overflow-x-auto border-b border-border mb-6" role="tablist" aria-label="SDK feature tabs">
          {[
            { id: "payment" as const, label: "Idempotent Payments", icon: CreditCard },
            { id: "webhook" as const, label: "Webhooks", icon: Webhook },
            { id: "fraud" as const, label: "Fraud Detection", icon: Shield },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              aria-label={label}
              onClick={() => setTab(id)}
              className={clsx(
                "flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors",
                tab === id
                  ? "border-b-2 border-accent-blue text-accent-blue"
                  : "text-gray-500 hover:text-gray-300",
              )}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>

        {tab === "payment" && <PaymentTab executor={executorRef.current} provider={providerRef.current} store={storeRef.current} />}
        {tab === "webhook" && <WebhookTab engine={webhookRef.current} />}
        {tab === "fraud" && <FraudTab detector={fraudRef.current} mode={mode} />}

        <footer className="mt-12 pt-6 border-t border-border text-xs text-gray-500 flex justify-between">
          <p>PayKit · Open-source TypeScript SDK · MIT License</p>
          <p>v0.1.0</p>
        </footer>
      </div>
    </main>
  );
}

// ── PAYMENT TAB ──────────────────────────────────────────────────────────────

/** What the executor itself says about a result: `metadata._idempotency`, absent on a call that reached the provider. */
function CacheResult({ tag }: { tag?: string }) {
  if (!tag) {
    return (
      <span className="text-accent-green flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3" /> MISS
      </span>
    );
  }
  return (
    <span className="text-yellow-400 flex items-center gap-1">
      <RefreshCw className="w-3 h-3" /> {tag === "cache_hit" ? "HIT" : "JOIN"}
      <code className="text-[10px] text-gray-500">{tag}</code>
    </span>
  );
}

function PaymentTab({ executor, provider, store }: { executor: IdempotentPaymentExecutor; provider: CountingMockProvider; store: InMemoryIdempotencyStore }) {
  const [amount, setAmount] = useState(4999);
  const [key, setKey] = useState("order_abc123");
  const [description, setDescription] = useState("Premium subscription");
  const [payments, setPayments] = useState<{ intent: PaymentIntent; providerCalls: number }[]>([]);
  const [providerCalls, setProviderCalls] = useState(provider.createPaymentCalls);
  const [loading, setLoading] = useState(false);
  // The executor refuses invalid input before any provider call (amount 0, a
  // float like 49.99, a value past Number.MAX_SAFE_INTEGER); show why.
  const [chargeError, setChargeError] = useState("");

  const handleCharge = async () => {
    setLoading(true);
    setChargeError("");
    try {
      // Two independent witnesses, both read AFTER the call: what the executor
      // tagged the result with, and whether the provider was actually called.
      const before = provider.createPaymentCalls;
      const intent = await executor.execute({
        amount: { amount, currency: "USD" },
        idempotencyKey: key,
        description,
      });
      setPayments([{ intent, providerCalls: provider.createPaymentCalls - before }, ...payments].slice(0, 10));
    } catch (err) {
      setChargeError(err instanceof Error ? err.message : "Charge refused");
    } finally {
      setProviderCalls(provider.createPaymentCalls);
      setLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Zap className="w-4 h-4" /> Charge Card
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Amount (cents)</label>
            <input
              type="number"
              aria-label="Amount in cents"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:border-accent-blue outline-none"
            />
            <div className="text-xs text-gray-500 mt-1">= ${(amount / 100).toFixed(2)} USD</div>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Idempotency Key</label>
            <input
              type="text"
              aria-label="Idempotency key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:border-accent-blue outline-none"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Description</label>
            <input
              type="text"
              aria-label="Payment description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm focus:border-accent-blue outline-none"
            />
          </div>
          <button
            onClick={handleCharge}
            disabled={loading}
            aria-label="Charge card"
            className="w-full bg-accent-blue/20 hover:bg-accent-blue/30 text-accent-blue rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {loading ? "Processing..." : "Charge Card"}
          </button>
          {chargeError && (
            <p role="alert" className="text-xs text-accent-red">
              {chargeError}
            </p>
          )}
          <button
            onClick={() => store.clear()}
            aria-label="Drop idempotency cache"
            className="w-full border border-border hover:border-yellow-400 text-gray-400 hover:text-yellow-400 rounded-md px-4 py-2 text-xs flex items-center justify-center gap-1"
          >
            <RefreshCw className="w-3 h-3" aria-hidden="true" /> Drop Idempotency Cache
          </button>
          <button
            onClick={() => { provider.reset(); store.clear(); setProviderCalls(0); setPayments([]); }}
            aria-label="Reset provider and idempotency cache"
            className="w-full border border-border hover:border-accent-red text-gray-400 hover:text-accent-red rounded-md px-4 py-2 text-xs flex items-center justify-center gap-1"
          >
            <RefreshCw className="w-3 h-3" aria-hidden="true" /> Reset Provider & Cache
          </button>
        </div>
        <div className="mt-5 p-3 bg-bg/50 rounded text-xs text-gray-400 border border-border">
          <strong className="text-accent-blue">💡 Try this:</strong> Click "Charge Card" twice without changing the key. The second is a <strong>HIT</strong>, served by the executor's idempotency cache, and the provider-call count does not move. Then drop the cache and charge again: a <strong>MISS</strong>, the provider IS called, and it replays the same payment because it honours the key too.
        </div>
      </div>

      <div className="lg:col-span-2 bg-panel border border-border rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent Attempts</h3>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{payments.length} total</span>
            <span>Provider calls: <span aria-label="Provider calls" className="text-gray-300 tabular-nums">{providerCalls}</span></span>
          </div>
        </div>
        <div className="overflow-auto max-h-96">
          {payments.length === 0 ? (
            <div className="p-12 text-center text-gray-500 text-sm">
              No charges yet. Click "Charge Card" to start.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-bg sticky top-0">
                <tr className="text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-2 text-left">ID</th>
                  <th className="px-4 py-2 text-left">Key</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th className="px-4 py-2 text-left">Cache</th>
                  <th className="px-4 py-2 text-right">Provider</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p, i) => (
                  <tr key={`${p.intent.id}-${i}`} className="border-t border-border">
                    <td className="px-4 py-2 font-mono text-[10px] text-gray-400">{p.intent.id.slice(0, 22)}…</td>
                    <td className="px-4 py-2 text-gray-300">{p.intent.idempotencyKey}</td>
                    <td className="px-4 py-2">
                      <span className={clsx(
                        "px-1.5 py-0.5 rounded text-[10px]",
                        p.intent.status === "succeeded" && "bg-accent-green/20 text-accent-green",
                        p.intent.status === "failed" && "bg-accent-red/20 text-accent-red",
                      )}>{p.intent.status}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">${(p.intent.amount.amount / 100).toFixed(2)}</td>
                    <td className="px-4 py-2">
                      <CacheResult tag={p.intent.metadata?._idempotency} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-300">+{p.providerCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── WEBHOOK TAB ──────────────────────────────────────────────────────────────

function WebhookTab({ engine }: { engine: BrowserWebhookEngine }) {
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
  const [results, setResults] = useState<{
    timestamp: string;
    eventId: string;
    eventType: string;
    handlersRun: number;
    duplicate: boolean;
    signatureValid: boolean;
    rejectReason: string;
    invalidPayload: string;
    notAcked: string;
    logs: string[];
  }[]>([]);

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
    const bodyToProcess = tamperBody ? payload.replace(paymentId, "TAMPERED_ID") : payload;

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

    setResults([{
      timestamp: new Date().toLocaleTimeString(),
      eventId,
      eventType,
      handlersRun,
      duplicate,
      signatureValid,
      rejectReason,
      invalidPayload,
      notAcked,
      logs: !signatureValid
        ? [`✗ rejected (${rejectReason}) — no handlers dispatched`]
        : invalidPayload
          ? [`✗ rejected: ${invalidPayload} — no handlers dispatched`]
          : logs,
    }, ...results].slice(0, 8));
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <Send className="w-4 h-4" /> Simulate Webhook
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Event Type</label>
            <select
              value={eventType}
              aria-label="Webhook event type"
              onChange={(e) => setEventType(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm"
            >
              <option value="payment_intent.succeeded">payment_intent.succeeded</option>
              <option value="payment_intent.payment_failed">payment_intent.payment_failed</option>
              <option value="refund.created">refund.created</option>
              <option value="charge.dispute.created">charge.dispute.created</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">
              Event ID <span className="text-gray-600">(dedup key)</span>
            </label>
            <input
              type="text"
              aria-label="Event ID"
              value={eventId}
              onChange={(e) => setEventId(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Payment ID</label>
            <input
              type="text"
              aria-label="Payment ID"
              value={paymentId}
              onChange={(e) => setPaymentId(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={useSecret} onChange={(e) => setUseSecret(e.target.checked)} />
            Sign with HMAC-SHA256
          </label>
          {useSecret && (
            <label className="flex items-center gap-2 text-xs text-accent-red">
              <input type="checkbox" checked={tamperBody} onChange={(e) => setTamperBody(e.target.checked)} />
              Tamper body after signing (test verification)
            </label>
          )}
          <button
            onClick={fire}
            aria-label="Fire webhook"
            className="w-full bg-accent-blue/20 hover:bg-accent-blue/30 text-accent-blue rounded-md px-4 py-2 text-sm font-semibold"
          >
            Fire Webhook
          </button>
          <button
            onClick={() => { engine.reset(); setResults([]); }}
            aria-label="Clear webhook dedup cache"
            className="w-full border border-border hover:border-accent-red text-gray-400 hover:text-accent-red rounded-md px-4 py-2 text-xs flex items-center justify-center gap-1"
          >
            <RefreshCw className="w-3 h-3" aria-hidden="true" /> Clear Cache
          </button>
        </div>
        <div className="mt-5 p-3 bg-bg/50 rounded text-xs text-gray-400 border border-border">
          <strong className="text-accent-blue">💡 Try this:</strong> Tamper the body after signing — verification fails. Untick <em>Sign</em> — the receiver still holds its secret, so the unsigned delivery is rejected (fail closed). Or press <em>Fire Webhook</em> twice without changing the <strong>Event ID</strong> — dedup is keyed on the event id, so the second delivery is DEDUPED and runs 0 handlers. Change the Event ID (or press <em>Clear Cache</em>) to get a fresh delivery.
        </div>
      </div>

      <div className="lg:col-span-2 space-y-3">
        {results.length === 0 ? (
          <div className="bg-panel border border-border rounded-lg p-12 text-center text-gray-500 text-sm">
            No webhooks fired yet.
          </div>
        ) : (
          results.map((r, i) => (
            <div key={i} className="bg-panel border border-border rounded-lg p-4">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="text-sm font-semibold">{r.eventType}</div>
                  <div className="text-[10px] text-gray-500 font-mono">{r.eventId} · {r.timestamp}</div>
                </div>
                <div className="flex gap-2 text-[10px]">
                  {!r.signatureValid && (
                    <span className="bg-accent-red/20 text-accent-red px-2 py-0.5 rounded flex items-center gap-1">
                      <XCircle className="w-3 h-3" /> INVALID SIG
                    </span>
                  )}
                  {r.signatureValid && r.invalidPayload && (
                    <span className="bg-accent-red/20 text-accent-red px-2 py-0.5 rounded flex items-center gap-1">
                      <XCircle className="w-3 h-3" /> REJECTED · NO EVENT ID
                    </span>
                  )}
                  {r.signatureValid && !r.invalidPayload && r.duplicate && (
                    <span className="bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> DEDUPED
                    </span>
                  )}
                  {r.signatureValid && !r.invalidPayload && !r.duplicate && r.notAcked && (
                    <span className="bg-accent-red/20 text-accent-red px-2 py-0.5 rounded flex items-center gap-1">
                      <XCircle className="w-3 h-3" /> NOT ACKED · {r.notAcked}
                    </span>
                  )}
                  {r.signatureValid && !r.invalidPayload && !r.duplicate && !r.notAcked && (
                    <span className="bg-accent-green/20 text-accent-green px-2 py-0.5 rounded flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> {r.handlersRun} HANDLER{r.handlersRun !== 1 ? "S" : ""} RAN
                    </span>
                  )}
                </div>
              </div>
              {r.logs.length > 0 && (
                <pre className="bg-bg p-2 rounded text-[10px] font-mono text-gray-300 overflow-auto">
                  {r.logs.join("\n")}
                </pre>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── FRAUD TAB ────────────────────────────────────────────────────────────────

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

  const recColor =
    result.recommendation === "approve" ? "accent-green" :
    result.recommendation === "review" ? "yellow-400" : "accent-red";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1 bg-panel border border-border rounded-lg p-5">
        <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> Transaction Context
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">
              Amount: ${(amount / 100).toFixed(2)}
            </label>
            <input
              type="range"
              aria-label="Transaction amount in cents"
              min={100}
              max={2_000_000}
              step={100}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-full accent-accent-blue"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Customer ID</label>
            <input
              type="text"
              aria-label="Customer ID"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="(leave blank for anonymous)"
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">User Agent</label>
            <input
              type="text"
              aria-label="User agent"
              value={userAgent}
              onChange={(e) => setUserAgent(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Account Age: {accountAgeDays} days</label>
            <input
              type="range"
              aria-label="Account age in days"
              min={0}
              max={730}
              value={accountAgeDays}
              onChange={(e) => setAccountAgeDays(Number(e.target.value))}
              className="w-full accent-accent-blue"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Payments in velocity window: {previousPaymentCount}</label>
            <input
              type="range"
              aria-label="Payments in the velocity window"
              min={0}
              max={30}
              value={previousPaymentCount}
              onChange={(e) => setPreviousPaymentCount(Number(e.target.value))}
              className="w-full accent-accent-blue"
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={isNewPaymentMethod} onChange={(e) => setIsNewPaymentMethod(e.target.checked)} />
            New payment method
          </label>
        </div>
      </div>

      <div className="lg:col-span-2 space-y-4">
        <div className="bg-panel border border-border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              Decision
              <span className="text-[10px] font-normal text-gray-500">
                {servedBy === "live" ? "· via live backend" : "· via in-browser SDK"}
              </span>
            </h3>
            <span className={clsx(
              "px-3 py-1 rounded-md text-sm font-bold tracking-wider",
              `bg-${recColor}/20 text-${recColor}`,
            )} style={{
              backgroundColor: recColor === "yellow-400" ? "rgb(234 179 8 / 0.2)" :
                recColor === "accent-green" ? "rgb(16 185 129 / 0.2)" : "rgb(239 68 68 / 0.2)",
              color: recColor === "yellow-400" ? "rgb(250 204 21)" :
                recColor === "accent-green" ? "#10b981" : "#ef4444",
            }}>
              {result.recommendation.toUpperCase()}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-gray-500 uppercase">Risk Score</div>
              <div className="text-4xl font-bold tabular-nums">{result.riskScore}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 uppercase">Risk Level</div>
              <div className="text-xl font-bold mt-1 capitalize">{result.riskLevel}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 uppercase">Triggered Rules</div>
              <div className="text-xl font-bold mt-1">{result.reasons.length} / {result.signals.length}</div>
            </div>
          </div>

          {/* Risk bar */}
          <div className="mt-4">
            <div className="relative h-3 bg-bg rounded-full overflow-hidden">
              <div
                className="absolute top-0 left-0 h-full transition-all duration-300"
                style={{
                  width: `${result.riskScore}%`,
                  background: result.riskScore < 35 ? "#10b981" :
                    result.riskScore < 70 ? "rgb(250 204 21)" : "#ef4444",
                }}
              />
              <div className="absolute top-0 h-full w-px bg-gray-500" style={{ left: "35%" }} />
              <div className="absolute top-0 h-full w-px bg-gray-500" style={{ left: "70%" }} />
            </div>
            <div className="flex justify-between text-[10px] text-gray-500 mt-1">
              <span>0</span><span>35 (Review)</span><span>70 (Decline)</span><span>100</span>
            </div>
          </div>
        </div>

        <div className="bg-panel border border-border rounded-lg p-5">
          <h3 className="text-sm font-semibold mb-3">Rule Evaluation</h3>
          <div className="space-y-1">
            {result.signals.map((s) => (
              <div key={s.name} className="flex items-start gap-3 text-xs py-1.5 border-b border-border last:border-b-0">
                <div className="w-6 mt-0.5">
                  {s.triggered ? (
                    <XCircle className="w-4 h-4 text-accent-red" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-gray-600" />
                  )}
                </div>
                <div className="flex-1">
                  <div className={clsx("font-semibold", s.triggered ? "text-white" : "text-gray-500")}>
                    {s.name}
                  </div>
                  <div className="text-gray-500">{s.reason}</div>
                </div>
                <div className={clsx(
                  "px-2 py-0.5 rounded text-[10px] font-bold",
                  s.triggered ? "bg-accent-red/20 text-accent-red" : "bg-gray-700/20 text-gray-500",
                )}>+{s.weight}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
