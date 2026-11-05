#!/usr/bin/env node
/**
 * Exercises the BUILT package (dist/) the way consumers load it: a CommonJS
 * consumer (`require("paykit")`) and an ES-module consumer
 * (`import ... from "paykit"`), each run by plain `node` against a copy of the
 * package installed under node_modules/ — no jest, no TypeScript transform, no
 * module mocks. Run after `npm run build` (`npm run test:dist`; CI does both).
 *
 * Why it exists: the ESM build once loaded the optional `stripe` peer through
 * a `require` shim that plain Node ESM does not provide, so StripeProvider
 * reported "stripe package not installed" and never initialised under ESM,
 * while every jest test (CommonJS) passed.
 *
 * Scenarios, each for both consumers:
 *   1. stripe installed (a fake, dual CJS/ESM package)  -> client built, calls reach it
 *   2. stripe not installed                              -> warning, ready() false, NOT_INITIALIZED
 *   3. stripe installed but its own dependency missing   -> the real error surfaces, no "not installed"
 * plus, CommonJS only: a `Module._load` hook supplying "stripe" (the mechanism
 * require hooks and test-runner mocks rely on) is honoured — the CJS build
 * loads stripe through `require`, not a native import() that bypasses it;
 * plus: the ESM bundle contains no `require` of stripe, and the package's
 * type declarations resolve for .cts and .mts consumers (moduleResolution node16).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repo, "dist");
for (const f of ["index.js", "index.mjs", "index.d.ts", "index.d.mts"]) {
  if (!existsSync(path.join(dist, f))) {
    console.error(`dist/${f} is missing — run \`npm run build\` first.`);
    process.exit(2);
  }
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

const work = mkdtempSync(path.join(tmpdir(), "paykit-dist-"));

/** A consumer project with paykit installed as a copy (package.json + dist). */
function project(name, stripe) {
  const dir = path.join(work, name);
  const pkg = path.join(dir, "node_modules", "paykit");
  mkdirSync(pkg, { recursive: true });
  cpSync(path.join(repo, "package.json"), path.join(pkg, "package.json"));
  cpSync(dist, path.join(pkg, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `consumer-${name}`, private: true }));
  if (stripe) {
    const s = path.join(dir, "node_modules", "stripe");
    mkdirSync(s, { recursive: true });
    for (const [file, body] of Object.entries(stripe)) writeFileSync(path.join(s, file), body);
  }
  writeFileSync(path.join(dir, "consumer.cjs"), CONSUMER.replace("__LOAD__", 'const pk = require("paykit");').replace("__MAIN__", "main()"));
  writeFileSync(path.join(dir, "consumer.mjs"), CONSUMER.replace("__LOAD__", 'import * as pk from "paykit";').replace("__MAIN__", "await main()"));
  writeFileSync(
    path.join(dir, "consumer-hooked.cjs"),
    CONSUMER.replace(
      "__LOAD__",
      `const Module = require("module");
const realLoad = Module._load;
${FAKE_BODY}
Module._load = function (request, ...rest) {
  return request === "stripe" ? Stripe : realLoad.call(this, request, ...rest);
};
const pk = require("paykit");`,
    ).replace("__MAIN__", "main()"),
  );
  return dir;
}

// Prints one JSON line describing what the consumer observed.
const CONSUMER = `__LOAD__
async function main() {
  const out = { version: pk.VERSION, exports: typeof pk.StripeProvider };
  const provider = new pk.StripeProvider({ secretKey: "sk_test_dist_check" });
  try {
    out.ready = await provider.ready();
  } catch (e) {
    out.readyError = { code: e.code, message: String(e.message).split("\\n")[0] };
  }
  try {
    const intent = await provider.createPayment({ amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_dist" });
    out.intent = { id: intent.id, status: intent.status, clientSecret: intent.clientSecret };
    out.constructedWith = globalThis.__fakeStripe;
  } catch (e) {
    out.callError = { code: e.code, message: String(e.message).split("\\n")[0] };
  }
  console.log(JSON.stringify(out));
}
__MAIN__;
`;

// A fake stripe-node: dual package like the real one (ESM for import, CJS for require).
const FAKE_BODY = `class Stripe {
  constructor(key, options) {
    globalThis.__fakeStripe = { key, options };
    this.paymentIntents = {
      create: async (params, opts) => ({
        id: "pi_fake_" + opts.idempotencyKey, status: "requires_payment_method", amount: params.amount,
        currency: params.currency, metadata: {}, created: 1700000000, client_secret: "pi_fake_secret",
      }),
    };
  }
}`;
const FAKE_STRIPE = {
  "package.json": JSON.stringify({
    name: "stripe",
    version: "0.0.0-fake",
    exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
  }),
  "index.cjs": `${FAKE_BODY}\nmodule.exports = Stripe;\nmodule.exports.default = Stripe;\n`,
  "index.mjs": `${FAKE_BODY}\nexport default Stripe;\n`,
};
const BROKEN_STRIPE = {
  "package.json": FAKE_STRIPE["package.json"],
  "index.cjs": `require("paykit-dist-check-missing-dep");\n`,
  "index.mjs": `import "paykit-dist-check-missing-dep";\n`,
};

function run(dir, consumer) {
  const r = spawnSync(process.execPath, [consumer], { cwd: dir, encoding: "utf8" });
  let result = null;
  try {
    result = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    // reported below
  }
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, result };
}

try {
  console.log("Built dist/ under plain Node (" + process.version + "):");

  const esm = readFileSync(path.join(dist, "index.mjs"), "utf8");
  check("ESM bundle never require()s stripe", !/require\(\s*["']stripe["']\s*\)/.test(esm) && !/__require\(/.test(esm));

  const withStripe = project("with-stripe", FAKE_STRIPE);
  const without = project("without-stripe", null);
  const broken = project("broken-stripe", BROKEN_STRIPE);

  for (const consumer of ["consumer.cjs", "consumer.mjs"]) {
    const kind = consumer.endsWith(".cjs") ? "CJS" : "ESM";

    const a = run(withStripe, consumer);
    const r = a.result ?? {};
    check(
      `${kind}, stripe installed: client built and createPayment reaches it`,
      a.status === 0 && r.ready === true && r.intent?.id === "pi_fake_order_dist" && r.intent?.status === "pending" &&
        r.intent?.clientSecret === "pi_fake_secret",
      a.stdout + a.stderr,
    );
    check(
      `${kind}, stripe installed: constructed with the pinned options`,
      r.constructedWith?.key === "sk_test_dist_check" &&
        JSON.stringify(r.constructedWith?.options) === JSON.stringify({ apiVersion: "2024-06-20", timeout: 20000, maxNetworkRetries: 1 }),
      JSON.stringify(r.constructedWith),
    );
    check(`${kind}, stripe installed: no "not installed" warning`, !/not installed/.test(a.stderr), a.stderr);

    const b = run(without, consumer);
    const rb = b.result ?? {};
    check(
      `${kind}, stripe absent: warns "not installed", ready() false, NOT_INITIALIZED`,
      b.status === 0 && rb.ready === false && rb.callError?.code === "NOT_INITIALIZED" && /stripe package not installed/.test(b.stderr),
      b.stdout + b.stderr,
    );

    const c = run(broken, consumer);
    const rc = c.result ?? {};
    check(
      `${kind}, stripe's own dependency missing: the real error surfaces (ready() and calls)`,
      c.status === 0 &&
        /paykit-dist-check-missing-dep/.test(rc.readyError?.message ?? "") &&
        /MODULE_NOT_FOUND/.test(rc.readyError?.code ?? "") &&
        /paykit-dist-check-missing-dep/.test(rc.callError?.message ?? "") &&
        !/not installed/.test(c.stderr),
      c.stdout + c.stderr,
    );
  }

  const h = run(without, "consumer-hooked.cjs");
  const rh = h.result ?? {};
  check(
    "CJS, stripe supplied by a Module._load hook (no package installed): the hook is honoured",
    h.status === 0 && rh.ready === true && rh.intent?.id === "pi_fake_order_dist" && !/not installed/.test(h.stderr),
    h.stdout + h.stderr,
  );

  // Type declarations resolve through package.json "exports" for both module kinds.
  const types = path.join(work, "types");
  mkdirSync(types, { recursive: true });
  cpSync(path.join(without, "node_modules"), path.join(types, "node_modules"), { recursive: true });
  writeFileSync(path.join(types, "package.json"), JSON.stringify({ name: "consumer-types", private: true }));
  const typedUse = `const p: StripeProvider = new StripeProvider({ timeoutMs: 1000 });
const ready: Promise<boolean> = p.ready();
const v: string = VERSION;
export { ready, v };
`;
  writeFileSync(path.join(types, "use.mts"), `import { StripeProvider, VERSION } from "paykit";\n${typedUse}`);
  writeFileSync(path.join(types, "use.cts"), `import { StripeProvider, VERSION } from "paykit";\n${typedUse}`);
  writeFileSync(
    path.join(types, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "node16", moduleResolution: "node16", target: "es2020", strict: true, noEmit: true, skipLibCheck: true, types: [] },
      files: ["use.mts", "use.cts"],
    }),
  );
  let tscOut = "";
  let tscOk = true;
  try {
    execFileSync(process.execPath, [path.join(repo, "node_modules", "typescript", "bin", "tsc"), "-p", types], { encoding: "utf8" });
  } catch (e) {
    tscOk = false;
    tscOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  check("types resolve via exports for .mts and .cts consumers (moduleResolution node16)", tscOk, tscOut);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
