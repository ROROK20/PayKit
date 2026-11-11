/**
 * PayKit scripted live-fire smoke driver.
 *
 * PayKit has NO HTTP API: the SDK is a
 * TypeScript library and the playground imports the REAL compiled package
 * (`frontend/package.json` -> "paykit": "file:..") and runs it client-side.
 * So there is no server to preflight-and-connect-to; the live-fire surface IS
 * the browser, and this driver is pure Playwright against it.
 *
 * What it proves (PayKit's core guarantees, made visible and assertable in the UI):
 *   1. A signed, untouched webhook is verified and dispatched -> "1 HANDLER RAN".
 *   2. A payload tampered AFTER signing is rejected -> "INVALID SIG", 0 handlers.
 *   3. The same webhook event id delivered twice is deduplicated -> "DEDUPED",
 *      0 handlers on the second delivery; a DIFFERENT id still dispatches, the
 *      control that keeps the DEDUPED assertion from passing trivially.
 *   3b. Verification fails closed: an UNSIGNED delivery to a receiver that has
 *      its secret configured is rejected -> "INVALID SIG" (missing_signature),
 *      0 handlers — on a fresh event id with a cleared cache, so a fail-open
 *      engine would visibly dispatch instead.
 *   4. The same payment fired twice under one idempotency key is served from
 *      the idempotency cache -> "HIT" with `cache_hit`, the result's own
 *      `metadata._idempotency`, the provider-call count unmoved, and the SAME
 *      payment id as >1s earlier (one payment, no double charge).
 *   5. A different key on the same executor still mints a NEW payment id and
 *      calls the provider — the positive control for assertion 4.
 *   6. With the cache dropped, the same key is a "MISS", the provider IS called,
 *      and the id is STILL the same. That is what a broken cache looks like, so
 *      it shows that the HIT and the count discriminate where the id cannot.
 *   7. Reset clears every cached key, not only the one typed in the form.
 *   8. The share card's og:url is this site's own, on the same origin as og:image.
 *   9. Layout: from 1180px to 1440px the trace log fits its column with no
 *      scroll hint, even holding the longest key the executor takes (255
 *      characters) on a cache HIT; at 320px and 360px the tab strip fits and
 *      every tab is at least 44px tall; at 360px the trace log scrolls under a
 *      visible hint, and no text field or select is under 16px (iOS zooms into
 *      those). On a touch screen at 844px and 1024px no field is under 16px
 *      either, the event-type select is as wide as its widest option, and
 *      nothing scrolls sideways.
 *  10. Form fields, in headless Chromium and WebKit, with a mouse at 768, 900,
 *      1180 and 1440px and on a touch screen at 768x1024 and 1180x820: on every
 *      tab the fields are one height, no field's default value scrolls inside
 *      it, and the event-type select is as wide as its widest option.
 *  11. Zero console errors across the whole run.
 *
 * It self-provisions: builds the SDK (so the playground exercises the CURRENT
 * source, never a stale dist/), spawns `next dev` on :3005, asserts, and tears
 * the server down in a `finally` (also on failure). Nothing is left running.
 *
 *   node e2e/smoke.mjs        # from the repo root; exit 0 = all pass, 1 = any fail
 *
 * This drives the Playwright *library* from a plain .mjs — NOT
 * @playwright/test, whose TS spec loader breaks under Node 23. Playwright is a
 * devDependency of frontend/, so it is resolved from there even though this
 * file lives at the repo root.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FRONTEND = join(ROOT, "frontend");
const require = createRequire(join(FRONTEND, "package.json"));
const { chromium, webkit } = require("playwright");

const UI_PORT = 3005; // the port `npm run dev` binds in frontend/package.json
const UI = `http://127.0.0.1:${UI_PORT}`;

// Expected badge text, exactly as `frontend/app/page.tsx` renders it.
const BADGE_INVALID = "INVALID SIG";
const BADGE_HANDLERS = "1 HANDLER RAN";
const BADGE_DEDUPED = "DEDUPED";
// A second charge must return the FIRST intent. MockProvider mints ids as
// `mock_pay_${Date.now()}_${rand}` and the table renders id.slice(0, 22) — i.e.
// through the millisecond timestamp — so waiting this long between the two
// charges makes id-equality proof that no second payment was created. It does
// not prove the provider was not called: MockProvider replays a re-sent key's
// original payment, per the provider idempotency contract, so a broken cache
// shows the same id. That proof is the provider-call count, which the playground
// reads from the provider itself, next to the result's own `_idempotency` tag.
const DUPLICATE_GAP_MS = 1200;

// ---- pass/fail bookkeeping: count checks, print each, exit non-zero on any fail ---
let pass = 0,
  fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ✓ ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  ✗ ${n}${e ? " — " + e : ""}`);
};
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, (e && e.message ? e.message : String(e)).split("\n")[0].slice(0, 180));
  }
}

// ---- server lifecycle -----------------------------------------------------
const children = [];
function launch(label, cmd, args, cwd) {
  // detached:true -> the server leads its own process group so teardown can
  // SIGKILL the whole tree (`next dev` spawns compiler children).
  const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.label = label;
  child.errtail = [];
  const keep = (d) => {
    for (const line of String(d).split("\n")) {
      if (line.trim()) {
        child.errtail.push(line);
        if (child.errtail.length > 30) child.errtail.shift();
      }
    }
  };
  child.stderr.on("data", keep);
  child.stdout.on("data", keep);
  child.on("error", (e) => keep(`spawn error: ${e.message}`));
  children.push(child);
  return child;
}
function killAll() {
  for (const c of children) {
    if (c.pid == null || c.exitCode !== null) continue;
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      try {
        c.kill("SIGKILL");
      } catch {}
    }
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killAll();
    process.exit(1);
  });
}

/** Run a command to completion; reject on non-zero exit (build gates the run). */
function run(label, cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const tail = [];
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (d) => {
      for (const line of String(d).split("\n")) {
        if (line.trim()) {
          tail.push(line);
          if (tail.length > 20) tail.shift();
        }
      }
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${tail.slice(-6).join(" | ")}`)),
    );
  });
}

function portListening(port) {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
}
async function waitUntil(what, fn, timeoutMs, child) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child && child.exitCode !== null) {
      throw new Error(`${child.label} exited early (code ${child.exitCode}): ${child.errtail.slice(-6).join(" | ")}`);
    }
    try {
      if (await fn()) return;
    } catch {}
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${what} after ${timeoutMs}ms${child ? ": " + child.errtail.slice(-6).join(" | ") : ""}`);
}

/**
 * Click until a predicate holds. `next dev` serves fully-formed, clickable HTML
 * before React hydrates, so an early click is silently swallowed — the button
 * is visible and enabled, and nothing happens. Retrying is the honest fix; a
 * fixed sleep either flakes or wastes time.
 */
async function clickUntil(what, locator, predicate, timeoutMs = 45000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      await locator.click({ timeout: 5000 });
      if (await predicate()) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
  }
  throw new Error(`clickUntil(${what}) never took effect${lastErr ? `: ${lastErr.message.split("\n")[0]}` : ""}`);
}

let browser;
const t0 = Date.now();
try {
  // Preflight: refuse to run against a stale server on our port — that would be
  // a false pass on some other checkout (an orphaned dev server can outlive
  // whatever started it).
  if (await portListening(UI_PORT)) {
    throw new Error(`port ${UI_PORT} (frontend) already in use — stop the stale process and re-run`);
  }

  // Build FIRST: the playground's "paykit": "file:.." dependency resolves to
  // dist/, so an unbuilt or stale dist would silently test some other build.
  console.log("Building SDK (dist/ is what the playground imports):");
  await check("npm run build -> dist/", () => run("npm run build", "npm", ["run", "build"], ROOT));

  console.log("Starting playground:");
  const uiProc = launch("frontend", "npm", ["run", "dev"], FRONTEND);
  await check("frontend listening (:3005)", () => waitUntil("frontend port", () => portListening(UI_PORT), 90000, uiProc));
  // `next dev` binds the port before it can serve — a bare port check races the
  // first compile and yields ERR_EMPTY_RESPONSE. Wait for a real 200.
  await check("frontend serving HTTP 200", () =>
    waitUntil(
      "frontend HTTP 200",
      async () => (await fetch(UI, { signal: AbortSignal.timeout(5000) })).ok,
      120000,
      uiProc,
    ),
  );

  // ---- UI live-fire: real browser, real compiled SDK, 0 console errors -----
  console.log("UI (headless Chromium @ :3005):");
  browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(UI, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.getByText("Interactive SDK Playground").waitFor({ timeout: 90000 });

  await check("playground served by the real SDK (in-browser badge)", async () => {
    // No API is configured, so the playground must report that it is running
    // the real package client-side rather than proxying a backend.
    await page.getByText("In-browser SDK", { exact: true }).waitFor({ timeout: 15000 });
  });

  await check("the share card's URL is this site's own, as its image is", async () => {
    const og = await page.evaluate(() => ({
      url: document.querySelector('meta[property="og:url"]')?.content,
      image: document.querySelector('meta[property="og:image"]')?.content,
    }));
    if (!og.url || !og.image) throw new Error(`og:url ${og.url}, og:image ${og.image}`);
    if (new URL(og.url).origin !== new URL(og.image).origin)
      throw new Error(`og:url ${og.url} is not the site of og:image ${og.image}`);
  });

  // ---- Webhook tab: a tampered payload is never dispatched -----------------
  const webhookTab = page.getByRole("tab", { name: "Webhooks" });
  const fireBtn = page.getByRole("button", { name: "Fire webhook" });
  const clearBtn = page.getByRole("button", { name: "Clear webhook dedup cache" });
  const tamperBox = page.locator("label", { hasText: "Tamper body after signing" }).locator("input[type=checkbox]");
  const signBox = page.locator("label", { hasText: "Sign with HMAC-SHA256" }).locator("input[type=checkbox]");
  const eventIdInput = page.getByLabel("Event ID", { exact: true });
  // One receipt per delivery, newest first; the "No webhooks fired yet."
  // placeholder is not one.
  const resultCards = page.getByTestId("webhook-delivery");

  // The tab click doubles as the hydration gate: once React owns the page, every
  // later click lands.
  await check("webhook tab opens (page hydrated)", () =>
    clickUntil("Webhooks tab", webhookTab, async () => (await webhookTab.getAttribute("aria-selected")) === "true"),
  );
  await fireBtn.waitFor({ timeout: 15000 });

  /** Clear the result list, fire once, and return the single resulting card. */
  const fireOnce = async () => {
    await clearBtn.click();
    await waitUntil("results cleared", async () => (await resultCards.count()) === 0, 15000);
    await fireBtn.click();
    await waitUntil("webhook result card", async () => (await resultCards.count()) === 1, 15000);
    return resultCards.first().innerText();
  };

  await check("happy path: signed webhook verified + dispatched -> 1 HANDLER RAN", async () => {
    if (await tamperBox.isChecked()) await tamperBox.uncheck();
    const card = await fireOnce();
    if (!card.includes(BADGE_HANDLERS)) throw new Error(`card lacks "${BADGE_HANDLERS}": ${card.replace(/\n/g, " | ").slice(0, 140)}`);
    if (card.includes(BADGE_INVALID)) throw new Error("valid signature rendered INVALID SIG");
    if (!card.includes("✓ handler called")) throw new Error("handler log line missing — handler did not run");
  });

  await check("tampered payload rejected -> INVALID SIG, 0 handlers run", async () => {
    await tamperBox.check();
    const card = await fireOnce();
    if (!card.includes(BADGE_INVALID)) throw new Error(`card lacks "${BADGE_INVALID}": ${card.replace(/\n/g, " | ").slice(0, 140)}`);
    if (/HANDLERS? RAN/.test(card)) throw new Error("tampered payload still dispatched handlers");
    if (card.includes("✓ handler called")) throw new Error("handler ran on a tampered payload");
  });

  await check("duplicate event id -> DEDUPED, 0 handlers on the second delivery", async () => {
    // The webhook half of "duplicate delivery never double-processes": dedup is
    // keyed on the EVENT ID, so re-firing the same id must run no handlers.
    if (await tamperBox.isChecked()) await tamperBox.uncheck();
    const first = await fireOnce(); // clears the dedup cache, then fires once
    if (!first.includes(BADGE_HANDLERS)) throw new Error(`first delivery not dispatched: ${first.replace(/\n/g, " | ").slice(0, 140)}`);
    await fireBtn.click(); // same event id, NO cache clear -> duplicate delivery
    await waitUntil("second webhook card", async () => (await resultCards.count()) === 2, 15000);
    const dup = await resultCards.first().innerText();
    if (!dup.includes(BADGE_DEDUPED)) throw new Error(`second delivery lacks "${BADGE_DEDUPED}": ${dup.replace(/\n/g, " | ").slice(0, 140)}`);
    if (/HANDLERS? RAN/.test(dup)) throw new Error("duplicate delivery still dispatched handlers");
    if (dup.includes("✓ handler called")) throw new Error("handler ran on a duplicate delivery");
    // Control: without this, DEDUPED above could pass for the trivial reason
    // "every fire after the first is deduped". A NEW id must dispatch normally.
    await eventIdInput.fill("evt_demo_002");
    await fireBtn.click();
    await waitUntil("third webhook card", async () => (await resultCards.count()) === 3, 15000);
    const fresh = await resultCards.first().innerText();
    if (!fresh.includes(BADGE_HANDLERS)) throw new Error(`a new event id was not dispatched: ${fresh.replace(/\n/g, " | ").slice(0, 140)}`);
  });

  await check("unsigned delivery rejected (fail closed) -> INVALID SIG missing_signature, 0 handlers", async () => {
    // The receiver always holds its secret; only the SENDER skips signing.
    // fireOnce clears the dedup cache and the id is new, so an engine that
    // failed open would dispatch ("1 HANDLER RAN") rather than dedupe.
    if (await tamperBox.isChecked()) await tamperBox.uncheck();
    await eventIdInput.fill("evt_unsigned_001");
    await signBox.uncheck();
    try {
      const card = await fireOnce();
      if (!card.includes(BADGE_INVALID)) throw new Error(`card lacks "${BADGE_INVALID}": ${card.replace(/\n/g, " | ").slice(0, 140)}`);
      if (!card.includes("missing_signature")) throw new Error(`rejection reason is not missing_signature: ${card.replace(/\n/g, " | ").slice(0, 140)}`);
      if (/HANDLERS? RAN/.test(card)) throw new Error("unsigned delivery dispatched handlers");
      if (card.includes("✓ handler called")) throw new Error("handler ran on an unsigned delivery");
    } finally {
      await signBox.check();
    }
  });

  // ---- Payment tab: one idempotency key is one charge ---------------------
  const paymentTab = page.getByRole("tab", { name: "Idempotent Payments" });
  const keyInput = page.getByLabel("Idempotency key");
  const chargeBtn = page.getByRole("button", { name: "Charge card" });
  const resetBtn = page.getByRole("button", { name: "Reset provider and idempotency cache" });
  const dropCacheBtn = page.getByRole("button", { name: "Drop idempotency cache" });
  const providerCalls = async () => (await page.getByLabel("Provider calls").innerText()).trim();
  const rows = page.locator("tbody tr");
  // Row shape: [id, key, status, amount, cache, provider] — newest row is prepended.
  const rowCells = async (i) => {
    const tds = rows.nth(i).locator("td");
    const n = await tds.count();
    const out = [];
    for (let c = 0; c < n; c++) out.push((await tds.nth(c).innerText()).trim());
    return out;
  };
  const chargeOnce = async (key, expectRows) => {
    await keyInput.fill(key);
    await chargeBtn.click();
    await waitUntil(`payment row #${expectRows}`, async () => (await rows.count()) === expectRows, 15000);
    return rowCells(0);
  };

  await check("payments tab opens", () =>
    clickUntil("Idempotent Payments tab", paymentTab, async () => (await paymentTab.getAttribute("aria-selected")) === "true"),
  );
  await chargeBtn.waitFor({ timeout: 15000 });
  await resetBtn.click();
  await waitUntil("payment table cleared", async () => (await rows.count()) === 0, 15000);

  let firstId = null;
  await check("first charge succeeds, is a MISS, and calls the provider once", async () => {
    if ((await providerCalls()) !== "0") throw new Error(`provider calls ${await providerCalls()} after reset, expected 0`);
    const [id, key, status, , cache, provider] = await chargeOnce("order_smoke_dup", 1);
    if (key !== "order_smoke_dup") throw new Error(`row key ${key}`);
    if (status !== "succeeded") throw new Error(`status ${status}`);
    if (cache !== "MISS") throw new Error(`cache column ${cache}, expected MISS`);
    if (provider !== "+1") throw new Error(`provider column ${provider}, expected +1`);
    if ((await providerCalls()) !== "1") throw new Error(`provider calls ${await providerCalls()}, expected 1`);
    firstId = id;
  });

  await check("duplicate charge on the same key -> HIT from _idempotency, provider NOT called, same payment id", async () => {
    // Wait past a millisecond boundary first: MockProvider stamps Date.now()
    // into the id, so an id identical to one minted >1s ago is the first
    // payment. The tag says the executor's store served it; the unmoved count
    // says the provider was not called.
    await sleep(DUPLICATE_GAP_MS);
    const [id, key, status, , cache, provider] = await chargeOnce("order_smoke_dup", 2);
    if (key !== "order_smoke_dup") throw new Error(`row key ${key}`);
    if (status !== "succeeded") throw new Error(`status ${status}`);
    if (!/\bHIT\b/.test(cache) || !cache.includes("cache_hit")) throw new Error(`cache column ${cache}, expected HIT with cache_hit`);
    if (provider !== "+0") throw new Error(`provider column ${provider}, expected +0: the provider was called`);
    if ((await providerCalls()) !== "1") throw new Error(`provider calls ${await providerCalls()}, expected 1`);
    if (id !== firstId) throw new Error(`payment id changed ${firstId} -> ${id}: the duplicate was charged again`);
  });

  await check("control: a DIFFERENT key does mint a new payment id", async () => {
    // Without this, id-equality above could pass for a trivial reason (e.g. the
    // UI rendering a constant). A fresh key must produce a different id.
    const [id, , status, , cache, provider] = await chargeOnce("order_smoke_other", 3);
    if (status !== "succeeded") throw new Error(`status ${status}`);
    if (cache !== "MISS") throw new Error(`cache column ${cache}, expected MISS`);
    if (provider !== "+1") throw new Error(`provider column ${provider}, expected +1`);
    if ((await providerCalls()) !== "2") throw new Error(`provider calls ${await providerCalls()}, expected 2`);
    if (id === firstId) throw new Error(`new key reused the cached id ${id} — id is not discriminating`);
  });

  await check("tamper: with the cache dropped the id still matches, but the HIT is gone and the provider IS called", async () => {
    // What a broken executor cache looks like. The id cannot tell (MockProvider
    // replays it), so this is the check that the two witnesses above can fail.
    await dropCacheBtn.click();
    const [id, , status, , cache, provider] = await chargeOnce("order_smoke_dup", 4);
    if (status !== "succeeded") throw new Error(`status ${status}`);
    if (id !== firstId) throw new Error(`provider did not replay the key: ${firstId} -> ${id}`);
    if (cache !== "MISS") throw new Error(`cache column ${cache}, expected MISS: nothing was cached`);
    if (provider !== "+1") throw new Error(`provider column ${provider}, expected +1`);
    if ((await providerCalls()) !== "3") throw new Error(`provider calls ${await providerCalls()}, expected 3`);
  });

  await check("reset clears every cached key, not only the one typed in the form", async () => {
    await keyInput.fill("order_smoke_other"); // a cached key, and not the one charged next
    await resetBtn.click();
    await waitUntil("payment table cleared", async () => (await rows.count()) === 0, 15000);
    if ((await providerCalls()) !== "0") throw new Error(`provider calls ${await providerCalls()} after reset, expected 0`);
    const [id, , , , cache, provider] = await chargeOnce("order_smoke_dup", 1);
    if (cache !== "MISS") throw new Error(`cache column ${cache}: reset left order_smoke_dup cached`);
    if (provider !== "+1") throw new Error(`provider column ${provider}, expected +1`);
    if (id === firstId) throw new Error(`reset left the provider's payment ${id} behind`);
  });

  // ---- Layout: desktop, phones, touch screens ------------------------------
  // The trace log holds rows from the checks above.
  // The scroll box itself: its <section> is a region with the same name.
  const traceBox = page.locator('div[role="region"][aria-labelledby="trace-log"]');
  const scrollHint = page.locator("[data-scroll-hint]");
  const overflowOf = (locator) => locator.evaluate((el) => el.scrollWidth - el.clientWidth);
  // The longest key the executor accepts (MAX_IDEMPOTENCY_KEY_LENGTH).
  const LONGEST_KEY = ("order_" + "0123456789abcdefghijklmnopqrstuvwxyz".repeat(8)).slice(0, 255);

  await check("desktop: with the longest key on a HIT, the trace log fits from 1180px to 1440px and no hint shows", async () => {
    // A HIT row carries the widest cache cell, and the key is the one column
    // whose width the user sets: hold both while measuring. At 13rem the old
    // key cell made this table 71px too wide at 1440px and 106px at 1180px.
    await chargeOnce(LONGEST_KEY, 2);
    const [, key, , , cache] = await chargeOnce(LONGEST_KEY, 3);
    if (key !== LONGEST_KEY) throw new Error(`the key cell does not hold the whole key (${key.length} characters)`);
    if (!/\bHIT\b/.test(cache)) throw new Error(`expected a HIT row to measure, cache column ${cache}`);
    for (const width of [1180, 1181, 1190, 1200, 1205, 1230, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const settled = async () => (await overflowOf(traceBox)) <= 0 && (await scrollHint.count()) === 0;
      try {
        await waitUntil(`${width}px trace log`, settled, 5000);
      } catch {
        throw new Error(`${width}px: trace log over by ${await overflowOf(traceBox)}px, ${await scrollHint.count()} hint(s)`);
      }
    }
  });

  await check("320px and 360px: the tab strip fits the screen and every tab is at least 44px tall", async () => {
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 740 });
      const over = await overflowOf(page.getByRole("tablist"));
      if (over > 0) throw new Error(`${width}px: tab strip over by ${over}px`);
      const heights = await page.getByRole("tab").evaluateAll((tabs) => tabs.map((t) => t.getBoundingClientRect().height));
      if (heights.some((h) => h < 44)) throw new Error(`${width}px: tab heights ${heights.map(Math.round).join(", ")}px`);
    }
  });

  await check("360px: the trace log scrolls sideways under a visible hint", async () => {
    try {
      await waitUntil("scroll hint", async () => (await overflowOf(traceBox)) > 0 && (await scrollHint.isVisible()), 5000);
    } catch {
      throw new Error(`trace log over by ${await overflowOf(traceBox)}px, hint visible: ${await scrollHint.isVisible()}`);
    }
  });

  const TABS = ["Idempotent Payments", "Webhooks", "Fraud Detection"];
  /** Open a tab, then throw if any text field or select on it is under 16px (iOS zooms into those on focus). */
  const assertFieldsAtLeast16px = async (p, label, where) => {
    const tab = p.getByRole("tab", { name: label });
    await clickUntil(`${where} ${label} tab`, tab, async () => (await tab.getAttribute("aria-selected")) === "true");
    const sizes = await p
      .locator('[role="tabpanel"] input, [role="tabpanel"] select, [role="tabpanel"] textarea')
      .evaluateAll((els) =>
        els
          .filter((e) => !["checkbox", "radio", "range", "hidden"].includes(e.type))
          .map((e) => [e.id || e.tagName, parseFloat(getComputedStyle(e).fontSize)]),
      );
    if (sizes.length === 0) throw new Error(`${where} ${label}: no field found`);
    const small = sizes.filter(([, px]) => px < 16);
    if (small.length) throw new Error(`${where} ${label}: ${small.map(([id, px]) => `${id} ${px}px`).join(", ")}`);
  };

  await check("360px: every text field and select on every tab is at least 16px (no iOS focus zoom)", async () => {
    for (const label of TABS) await assertFieldsAtLeast16px(page, label, "360px");
  });

  /** A fresh playground page in `ctx`, its console watched, its fonts loaded: every field holds its default value. */
  const openPlayground = async (ctx) => {
    const p = await ctx.newPage();
    p.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    p.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    await p.goto(UI, { waitUntil: "domcontentloaded", timeout: 90000 });
    await p.evaluate(() => document.fonts.ready.then(() => undefined));
    return p;
  };

  await check("touch screen at 844px and 1024px: fields are 16px, the event-type select fits its widest option, nothing scrolls sideways", async () => {
    // Safari zooms into a field under 16px on any touch screen, not only below
    // 640px: an iPhone held sideways is 844px wide, an iPad 1024px. At 16px a
    // select laid out for 13px would cut off the event type it shows.
    for (const [width, height] of [[844, 390], [1024, 1366]]) {
      const where = `touch ${width}px`;
      const touch = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      try {
        const tp = await openPlayground(touch);
        if (!(await tp.evaluate(() => matchMedia("(pointer: coarse)").matches))) throw new Error(`${where}: the context is not a coarse pointer`);
        for (const label of TABS) {
          await assertFieldsAtLeast16px(tp, label, where);
          const sideways = await tp.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
          if (sideways > 0) throw new Error(`${where} ${label}: the page scrolls sideways by ${sideways}px`);
        }
        await assertFieldsAtLeast16px(tp, "Webhooks", where);
        // A select's max-content width is the engine's own measure of its widest option.
        const select = await tp.locator("#webhook-type").evaluate((el) => {
          const box = el.getBoundingClientRect().width;
          const was = el.style.width;
          el.style.width = "max-content";
          const widest = el.getBoundingClientRect().width;
          el.style.width = was;
          return { box, widest };
        });
        if (select.box + 0.5 < select.widest) {
          throw new Error(`${where}: event-type select is ${Math.round(select.box)}px, its widest option needs ${Math.round(select.widest)}px`);
        }
      } finally {
        await touch.close();
      }
    }
  });

  // ---- Form fields in Chromium and WebKit ----------------------------------
  // WebKit is Safari's engine, on a Mac as on an iPad or iPhone, and it draws a
  // native select its own way: as a 21px menu button beside 40px text fields.
  const FIELDS = ["text", "number"].map((t) => `[role="tabpanel"] input[type="${t}"]`).concat('[role="tabpanel"] select').join(", ");
  /** On every tab, throw unless the fields are one height, no default value scrolls inside its field, and the event-type select holds its widest option. */
  const assertFieldsFit = async (p, where) => {
    for (const label of TABS) {
      const tab = p.getByRole("tab", { name: label });
      await clickUntil(`${where} ${label} tab`, tab, async () => (await tab.getAttribute("aria-selected")) === "true");
      const fields = await p.locator(FIELDS).evaluateAll((els) =>
        els.map((e) => {
          const { width, height } = e.getBoundingClientRect();
          // A select's max-content width is the engine's own measure of its widest option.
          let widest = null;
          if (e.tagName === "SELECT") {
            const was = e.style.width;
            e.style.width = "max-content";
            widest = e.getBoundingClientRect().width;
            e.style.width = was;
          }
          return { id: e.id, width, height, widest, scrolls: e.tagName === "SELECT" ? 0 : e.scrollWidth - e.clientWidth };
        }),
      );
      if (fields.length === 0) throw new Error(`${where} ${label}: no field found`);
      const heights = fields.map((f) => f.height);
      if (Math.max(...heights) - Math.min(...heights) > 0.5) {
        throw new Error(`${where} ${label}: field heights ${fields.map((f) => `${f.id} ${Math.round(f.height)}px`).join(", ")}`);
      }
      const scrolled = fields.filter((f) => f.scrolls > 0);
      if (scrolled.length) throw new Error(`${where} ${label}: default value scrolls inside ${scrolled.map((f) => `${f.id} by ${f.scrolls}px`).join(", ")}`);
      for (const f of fields.filter((f) => f.widest !== null && f.width + 0.5 < f.widest)) {
        throw new Error(`${where} ${label}: ${f.id} is ${Math.round(f.width)}px, its widest option needs ${Math.round(f.widest)}px`);
      }
    }
  };

  for (const [name, engine] of [["Chromium", chromium], ["WebKit", webkit]]) {
    let launched = null;
    const engineBrowser = async () => (engine === chromium ? browser : (launched ??= await engine.launch()));
    await check(`${name}, with a mouse at 768, 900, 1180 and 1440px: on every tab the fields are one height, no default value scrolls, the event-type select holds its widest option`, async () => {
      // At 768px the select had a third of the form, and from 1180px 17rem:
      // both cut payment_intent.payment_failed short. At 1180px the description
      // had what the buttons left, 4px less than its own default.
      const ctx = await (await engineBrowser()).newContext({ viewport: { width: 768, height: 900 } });
      try {
        const p = await openPlayground(ctx);
        for (const width of [768, 900, 1180, 1440]) {
          await p.setViewportSize({ width, height: 900 });
          await assertFieldsFit(p, `${name} ${width}px`);
        }
      } finally {
        await ctx.close();
      }
    });
    await check(`${name}, on a touch screen at 360x800, 375x812, 390x844, 768x1024 and 1180x820: the same, at 16px`, async () => {
      // Three phones, an iPad in portrait and an iPad Air held sideways. At 16px
      // the old description scrolled its default by 6px and 43px in Chromium,
      // and on a phone the select was up to 18px short of payment_intent.payment_failed.
      for (const [width, height] of [[360, 800], [375, 812], [390, 844], [768, 1024], [1180, 820]]) {
        const where = `${name} touch ${width}px`;
        const ctx = await (await engineBrowser()).newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
        try {
          const p = await openPlayground(ctx);
          if (!(await p.evaluate(() => matchMedia("(pointer: coarse)").matches))) throw new Error(`${where}: the context is not a coarse pointer`);
          await assertFieldsFit(p, where);
        } finally {
          await ctx.close();
        }
      }
    });
    if (launched) await launched.close();
  }

  await check("0 console errors", () => {
    if (consoleErrors.length) throw new Error(`${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(" | ")}`);
  });
} catch (e) {
  fail++;
  console.log(`\n✗ FATAL — ${e && e.message ? e.message : String(e)}`);
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  killAll();
}

console.log(`\n${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(fail === 0 ? 0 : 1);
