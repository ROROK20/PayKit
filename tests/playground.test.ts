/**
 * The payments tab's two witnesses, with the same classes the page uses. A
 * payment id cannot show whether the provider was called, because MockProvider
 * replays a re-sent key's original payment. e2e/smoke.mjs drives the same cases
 * through the browser; this keeps them in the suite CI runs.
 */

import fs from "fs";
import path from "path";

import { IdempotentPaymentExecutor, InMemoryIdempotencyStore } from "../src/payments/idempotent";

// `require`, so a missing export fails an assertion here rather than the compile.
const sdk = require("../frontend/lib/sdk");
const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const page = read("frontend/app/page.tsx");
const driver = read("e2e/smoke.mjs");

describe("the provider-call count and the _idempotency tag", () => {
  function setup() {
    expect(typeof sdk.CountingMockProvider).toBe("function");
    const provider = new sdk.CountingMockProvider({ successRate: 1 });
    const store = new InMemoryIdempotencyStore();
    return { provider, store, executor: new IdempotentPaymentExecutor(provider, { store }) };
  }
  const charge = (key: string) => ({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: key });

  test("a duplicate is tagged cache_hit and never reaches the provider", async () => {
    const { provider, executor } = setup();
    const first = await executor.execute(charge("k"));
    expect(first.metadata?._idempotency).toBeUndefined();
    expect(provider.createPaymentCalls).toBe(1);
    const second = await executor.execute(charge("k"));
    expect(second.metadata?._idempotency).toBe("cache_hit");
    expect(second.id).toBe(first.id);
    expect(provider.createPaymentCalls).toBe(1);
  });

  test("tamper: with the cache gone the id still matches, so only the tag and the count can tell", async () => {
    const { provider, store, executor } = setup();
    const first = await executor.execute(charge("k"));
    store.clear();
    const again = await executor.execute(charge("k"));
    expect(again.id).toBe(first.id); // the provider replayed it
    expect(again.metadata?._idempotency).toBeUndefined();
    expect(provider.createPaymentCalls).toBe(2);
  });

  test("reset forgets the count along with the payments", async () => {
    const { provider, executor } = setup();
    await executor.execute(charge("k"));
    provider.reset();
    expect(provider.createPaymentCalls).toBe(0);
    expect(await provider.listPayments()).toEqual([]);
  });
});

describe("the payments tab and its driver say what they measure", () => {
  test("the tab reads the result, not a question asked before the call", () => {
    expect(page).not.toContain("isDuplicate");
    expect(page).toContain("p.intent.metadata?._idempotency");
    expect(page).toContain("provider.createPaymentCalls - before");
  });

  test("Reset clears the whole store, not just the key in the form", () => {
    expect(page).not.toContain("executor.invalidate(key)");
    expect(page).toMatch(/provider\.reset\(\); store\.clear\(\);/);
  });

  test("the driver's claim rests on the count, and it runs the broken-cache case", () => {
    expect(driver).not.toMatch(/"HIT" column[\s\S]{0,120}proves the provider was\s+\/\/ not called/);
    expect(driver).toContain('getByLabel("Provider calls")');
    expect(driver).toContain("tamper: with the cache dropped");
    expect(driver).toContain("reset clears every cached key");
  });
});

describe("the playground is described as what it is", () => {
  test("the real SDK classes against a mock provider: nothing claims a real payment or a full stack", () => {
    const readme = read("README.md");
    expect(readme).toContain("runs the real SDK classes against a mock provider");
    expect(readme).not.toContain("**not** a mock");
    for (const file of ["README.md", "docker-compose.yml", "Makefile"]) {
      expect({ file, fullStack: /full[- ]stack/i.test(read(file)) }).toEqual({ file, fullStack: false });
    }
    expect(page).toContain("new CountingMockProvider(");
    expect(page).toContain("Payments go to its in-memory mock provider");
  });

  test("the comments and the playground's README name only what it runs", () => {
    expect(read("frontend/next.config.mjs")).not.toContain("ReconciliationEngine");
    const frontendReadme = read("frontend/README.md");
    expect(frontendReadme).not.toContain("same algorithms");
    expect(frontendReadme).toContain("`BrowserWebhookEngine`, a Web Crypto reimplementation");
  });

  test("it runs no reconciliation, and nothing says it does", () => {
    expect(page).not.toContain("ReconciliationEngine");
    expect(read("frontend/lib/sdk.ts")).not.toContain("ReconciliationEngine");
    expect(read("docker-compose.yml")).not.toContain("ReconciliationEngine");
    expect(read("frontend/app/layout.tsx")).not.toMatch(/reconciliation/i);
    const readme = read("README.md");
    const architecture = readme.slice(readme.indexOf("### Architecture: frontend"), readme.indexOf("BrowserWebhookEngine` (`frontend/lib/sdk.ts`)"));
    expect(architecture).not.toContain("ReconciliationEngine");
    expect(architecture).toContain("Reconciliation has no tab");
  });
});
