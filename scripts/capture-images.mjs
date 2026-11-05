#!/usr/bin/env node
/**
 * Re-captures the README screenshot and the social (OG) card from a PRODUCTION
 * build of the playground, and records what they were captured from.
 *
 *   npm run capture              # builds the SDK + playground, then captures
 *   npm run capture -- --no-build  # reuse an existing production build
 *
 * The playground is built WITHOUT NEXT_PUBLIC_API_URL / NEXT_PUBLIC_SITE_URL,
 * so it runs in its default, truthful mode: the real SDK in the browser
 * ("In-browser SDK" badge). Every figure in the images is what that build
 * renders. The script writes docs/screenshots.json — capture date, a SHA-256
 * of the frontend sources the images depict, and each image's SHA-256 — and
 * tests/docs_examples.test.ts fails when those sources change without a
 * re-capture, or when an image is replaced outside this flow.
 *
 * It starts its own `next start` on CAPTURE_PORT and stops only that process.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");
// Playwright is a devDependency of frontend/: resolve that pinned copy.
const { chromium } = createRequire(join(FRONTEND, "package.json"))("playwright");

const CAPTURE_PORT = 3007;
const URL = `http://127.0.0.1:${CAPTURE_PORT}`;
const OG = "frontend/public/og.png";
const SCREENSHOT = "docs/screenshot.png";
const MANIFEST = "docs/screenshots.json";

/**
 * The frontend sources the images depict. Keep in sync with
 * `screenshotSources` in tests/docs_examples.test.ts (a mismatch fails that
 * test right after a capture, so drift between the two cannot go unnoticed).
 */
export function frontendSourcesSha256(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const rel = join(dir, name);
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (rel !== OG) files.push(rel);
    }
  };
  for (const dir of ["frontend/app", "frontend/lib", "frontend/public"]) walk(dir);
  files.push("frontend/tailwind.config.ts", "frontend/postcss.config.js", "frontend/next.config.mjs");
  const hash = createHash("sha256");
  for (const rel of files.sort()) hash.update(rel).update("\0").update(readFileSync(join(root, rel))).update("\0");
  return hash.digest("hex");
}

const sha256File = (rel) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");

function run(cmd, args, cwd, env = process.env) {
  console.log(`$ ${cmd} ${args.join(" ")}  (${relative(ROOT, cwd) || "."})`);
  execFileSync(cmd, args, { cwd, env, stdio: "inherit" });
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms`);
}

/** Click until `done()` holds — a click before hydration is silently ignored. */
async function clickUntil(locator, done, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await locator.click();
    for (let i = 0; i < 10; i++) {
      if (await done()) return;
      await sleep(100);
    }
  }
  throw new Error("the click never took effect");
}

const buildEnv = { ...process.env };
delete buildEnv.NEXT_PUBLIC_API_URL;
delete buildEnv.NEXT_PUBLIC_SITE_URL;

if (!process.argv.includes("--no-build")) {
  run("npm", ["run", "build"], ROOT, buildEnv);
  run("npm", ["run", "build"], FRONTEND, buildEnv);
}

const server = spawn(join(FRONTEND, "node_modules/.bin/next"), ["start", "-p", String(CAPTURE_PORT)], {
  cwd: FRONTEND,
  env: buildEnv,
  detached: true,
  stdio: "ignore",
});
const stopServer = () => {
  try {
    process.kill(-server.pid, "SIGTERM"); // our own process group only
  } catch {
    // already gone
  }
};
process.on("exit", stopServer);

let browser;
try {
  await waitForHttp(URL, 60_000);
  browser = await chromium.launch();

  // Social card: the landing view, 1200×630 (the OG size) at 2×.
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await og.goto(URL);
  await og.getByText("In-browser SDK", { exact: true }).waitFor({ timeout: 30_000 });
  await og.getByText("0 total").waitFor();
  await og.screenshot({ path: join(ROOT, OG) });

  // README screenshot: two charges with one key — the second served from the
  // idempotency cache (MISS, then HIT, one provider call) — at 1440×925, 2×.
  const page = await browser.newPage({ viewport: { width: 1440, height: 925 }, deviceScaleFactor: 2 });
  await page.goto(URL);
  await page.getByText("In-browser SDK", { exact: true }).waitFor({ timeout: 30_000 });
  const charge = page.getByRole("button", { name: "Charge card" });
  const rows = page.locator("tbody tr");
  await clickUntil(charge, async () => (await rows.count()) === 1);
  await sleep(1200); // the second id would differ in its timestamp if a new payment were minted
  await clickUntil(charge, async () => (await rows.count()) === 2);
  const cacheColumn = (await rows.allInnerTexts()).join("\n");
  if (!cacheColumn.includes("HIT") || !cacheColumn.includes("MISS")) {
    throw new Error(`expected a MISS and a HIT row, got:\n${cacheColumn}`);
  }
  const providerCalls = (await page.getByLabel("Provider calls").innerText()).trim();
  if (providerCalls !== "1") {
    throw new Error(`expected one provider call for two charges, got ${providerCalls}`);
  }
  await page.screenshot({ path: join(ROOT, SCREENSHOT) });

  const capturedAt = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local date
  const manifest = {
    capturedAt,
    capturedFrom:
      "production build of the playground (next build, next start) without NEXT_PUBLIC_API_URL: the real SDK in the browser",
    frontendSourcesSha256: frontendSourcesSha256(ROOT),
    images: {
      [OG]: { sha256: sha256File(OG), viewport: "1200x630 @2x", shows: "landing view, no charges yet" },
      [SCREENSHOT]: {
        sha256: sha256File(SCREENSHOT),
        viewport: "1440x925 @2x",
        shows: "two charges with one idempotency key: MISS, then HIT, and one provider call",
      },
    },
  };
  writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`captured ${OG} and ${SCREENSHOT} (${capturedAt}); wrote ${MANIFEST}`);
} finally {
  await browser?.close();
  stopServer();
}
