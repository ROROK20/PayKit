/**
 * Documentation examples are executed, not trusted: a snippet whose comments
 * promise output it does not produce is a doc that lies (the README's fraud
 * example once promised 65 / "high" / "review" and printed 0 / "low" /
 * "approve").
 *
 * Each case takes the first ```typescript block after a heading, transpiles
 * it with the repo's TypeScript, runs it with `paykit` mapped to the source,
 * and requires every `console.log(x); // <value>` line to print exactly
 * `<value>` (JSON; anything after " — " is commentary). Every console.log in
 * the block must carry such a comment, so no printed value goes unchecked.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";

import * as paykit from "../src/index";

function firstTypescriptBlockAfter(file: string, heading: RegExp): string {
  const markdown = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const at = markdown.search(heading);
  if (at < 0) throw new Error(`${file}: heading ${heading} not found`);
  const block = /```typescript\n([\s\S]*?)\n```/.exec(markdown.slice(at));
  if (!block) throw new Error(`${file}: no typescript block after ${heading}`);
  return block[1];
}

function run(code: string, prelude: string): { printed: string[]; expected: string[] } {
  const js = ts.transpileModule(prelude + code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const printed: string[] = [];
  const snippetConsole = { log: (...args: unknown[]) => printed.push(args.map((a) => JSON.stringify(a)).join(" ")) };
  const snippetRequire = (id: string) => {
    if (id === "paykit") return paykit;
    throw new Error(`the snippet imports ${id}, which this test does not provide`);
  };
  new Function("require", "console", "exports", "module", js)(snippetRequire, snippetConsole, {}, { exports: {} });
  const lines = code.split("\n").filter((l) => /^\s*console\.log\(/.test(l));
  const expected = lines.map((line) => {
    const comment = /\);\s*\/\/\s*(.+)$/.exec(line);
    if (!comment) throw new Error(`console.log without an expected-output comment: ${line.trim()}`);
    return comment[1].split(" — ")[0].trim();
  });
  return { printed, expected };
}

describe("documented examples print exactly what their comments say", () => {
  test.each([
    ["README.md", /^## Fraud Detection$/m, ""],
    ["README.md", /^## Reconciliation$/m, ""],
    ["docs/usage.md", /^## 5\. Fraud detection$/m, 'import { FraudDetector, FraudRule } from "paykit";\n'],
  ])("%s %s", (file, heading, prelude) => {
    const { printed, expected } = run(firstTypescriptBlockAfter(file, heading), prelude);
    expect(expected.length).toBeGreaterThan(0);
    expect(printed).toEqual(expected);
  });
});

/**
 * Every TypeScript snippet a reader can copy compiles under `strict`, against
 * the real API. A snippet is a fragment of a program, so its surroundings are
 * supplied the way a reader's app would: each runs as its own module, PayKit's
 * exports it did not import are imported for it, and `SNIPPET_SURROUNDINGS`
 * declares the app's own names. Nothing else is forgiven: no diagnostic is
 * filtered, and a line a doc says must not compile carries `@ts-expect-error`,
 * so that claim is checked too.
 */
const SNIPPET_SURROUNDINGS = `
type Redis = { get(key: string): Promise<string | null>; set(...args: any[]): Promise<"OK" | null>; eval(...args: any[]): Promise<unknown> };
declare const redis: Redis;
declare const provider: import("paykit").PaymentProvider_Interface;
declare const store: import("paykit").IdempotencyStore;
declare const stripe: import("paykit").StripeProvider;
declare const executor: import("paykit").IdempotentPaymentExecutor;
declare const engine: import("paykit").WebhookEngine;
declare const request: import("paykit").CreatePaymentRequest;
declare const renewal: import("paykit").CreatePaymentRequest;
declare const internalRecords: import("paykit").InternalRecord[];
declare const providerRecords: import("paykit").ProviderRecord[];
declare const handler: (event: import("paykit").WebhookEvent, data: unknown) => Promise<void>;
declare const orderId: string, userId: string, billingCycleId: string, stripeCustomerId: string, savedPaymentMethodId: string;
declare const HIGH_RISK_COUNTRIES: string[];
declare const fulfillOrder: (paymentId: string) => Promise<void>;
declare const sendConfirmationEmail: (userId: string) => Promise<void>;
declare const notifyCustomer: (customer: string, reason: string) => Promise<void>;
declare const escalateToSupport: (data: unknown) => Promise<void>;
declare const emailCustomer: (link: string) => Promise<void>;
declare const orders: { setPaymentIntent(orderId: string, id: string): Promise<void>; get(orderId: string): Promise<{ paymentIntentId: string }> };
declare const auditLog: { record(type: string, id: string): Promise<void> };
declare const logger: { warn(message: string): void };
type Req = { body: Buffer; rawBody: string; headers: Record<string, string | undefined> };
type Res = { json(body: unknown): void; status(code: number): Res; send(body: string): void; end(): void };
declare const req: Req;
declare const res: Res;
declare const app: { post(path: string, middleware: unknown, handler: (req: Req, res: Res) => Promise<void>): void };
declare const express: { raw(options: { type: string }): unknown };
`;

/** Names a snippet binds at its top level; PayKit's are not imported over them. */
function namesBoundBy(code: string): Set<string> {
  const names = new Set<string>();
  for (const st of ts.createSourceFile("snippet.ts", code, ts.ScriptTarget.ES2022).statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (clause?.name) names.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) names.add(el.name.text);
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
    } else if (ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
      if (st.name) names.add(st.name.text);
    }
  }
  return names;
}

/** `strict` diagnostics per snippet label ("README.md:123"); one program, so it stays fast. */
function strictDiagnostics(snippets: Map<string, string>): Map<string, string[]> {
  const repo = path.join(__dirname, "..");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    skipLibCheck: true,
    baseUrl: repo,
    paths: { paykit: ["src/index.ts"] },
    typeRoots: [path.join(repo, "node_modules", "@types")],
    types: ["node", "jest"],
  };
  const virtual = new Map<string, string>([[path.join(repo, "__snippets__", "surroundings.d.ts"), SNIPPET_SURROUNDINGS]]);
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => virtual.has(f) || fileExists.call(host, f);
  host.readFile = (f) => virtual.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, version, ...rest) => {
    const text = virtual.get(f);
    return text !== undefined ? ts.createSourceFile(f, text, version) : getSourceFile.call(host, f, version, ...rest);
  };

  const index = path.join(repo, "src", "index.ts");
  const api = ts.createProgram([index], options, host);
  const checker = api.getTypeChecker();
  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(api.getSourceFile(index)!)!).map((e) => e.name);

  const labels = new Map<string, string>();
  [...snippets].forEach(([label, code], i) => {
    const file = path.join(repo, "__snippets__", `snippet_${i}.ts`);
    const bound = namesBoundBy(code);
    const imports = exported.filter((name) => !bound.has(name));
    // Appended, so a diagnostic's line is the snippet's own.
    virtual.set(file, `${code}\nimport { ${imports.join(", ")} } from "paykit";\nexport {};\n`);
    labels.set(file, label);
  });
  const program = ts.createProgram([...virtual.keys()], options, host, api);
  const result = new Map<string, string[]>([...snippets.keys()].map((label) => [label, []]));
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const label = d.file ? labels.get(d.file.fileName) : undefined;
    const text = `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    if (label === undefined) throw new Error(`diagnostic outside any snippet: ${d.file?.fileName}: ${text}`);
    const line = d.file!.getLineAndCharacterOfPosition(d.start!).line;
    result.get(label)!.push(`+${line + 1}: ${text}`);
  }
  return result;
}

/** Every ```typescript block in a markdown file, labelled with the line it starts on. */
function typescriptBlocksOf(file: string): Map<string, string> {
  const markdown = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  return new Map(
    [...markdown.matchAll(/```typescript\n([\s\S]*?)\n```/g)].map((m) => [`${file}:${markdown.slice(0, m.index).split("\n").length}`, m[1]]),
  );
}

/** Every `@example` code block in the source's JSDoc, labelled likewise. */
function jsdocExamplesOf(file: string): Map<string, string> {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  return new Map(
    [...source.matchAll(/@example\n\s*\* ```ts\n([\s\S]*?)\n\s*\* ```/g)].map((m) => [
      `${file}:${source.slice(0, m.index).split("\n").length}`,
      m[1].replace(/^\s*\* ?/gm, ""),
    ]),
  );
}

describe("every TypeScript snippet in the docs compiles under strict mode", () => {
  const JSDOC_FILES = ["src/payments/idempotent.ts", "src/webhooks/handler.ts", "src/reconciliation/engine.ts", "src/fraud/detector.ts"];
  // Each sample is an error the check exists to catch; "control" must stay clean.
  const SAMPLES: Record<string, string> = {
    "sample:unknown-data": 'engine.on("payment.succeeded", async (event, data) => { await fulfillOrder(data.object.id); });',
    "sample:missing-field": "detector.addRule((ctx) => ({ name: 'x', triggered: ctx.country === 'XX', weight: 1, reason: 'x' }));\nconst detector = new FraudDetector();",
    "sample:undeclared-name": "await noSuchFunction();",
    "sample:unused-expect-error": "// @ts-expect-error\nconst fine = 1;",
    "sample:control": 'const mock = new MockProvider();\nconst paid = await mock.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "k" });\nconst id: string = paid.id;',
  };
  let diagnostics: Map<string, string[]>;
  const blocks = (labelPrefix: string) => [...diagnostics].filter(([label]) => label.startsWith(labelPrefix));

  beforeAll(() => {
    diagnostics = strictDiagnostics(
      new Map([...typescriptBlocksOf("README.md"), ...typescriptBlocksOf("docs/usage.md"), ...JSDOC_FILES.flatMap((f) => [...jsdocExamplesOf(f)]), ...Object.entries(SAMPLES)]),
    );
  }, 120_000);

  test.each(["README.md", "docs/usage.md"])("%s", (file) => {
    const found = blocks(`${file}:`);
    expect(found.length).toBeGreaterThanOrEqual(10);
    expect(found.filter(([, errors]) => errors.length > 0)).toEqual([]);
  });

  test.each(JSDOC_FILES)("%s: its @example", (file) => {
    const found = blocks(`${file}:`);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter(([, errors]) => errors.length > 0)).toEqual([]);
  });

  test("any provider compiles: an adapter of your own, wherever PayKit takes a provider's name", () => {
    const adapter = `
class AdyenProvider implements PaymentProvider_Interface {
  readonly name = "adyen";
  async createPayment(request: CreatePaymentRequest): Promise<PaymentIntent> {
    const now = new Date();
    return { id: "a_1", idempotencyKey: request.idempotencyKey, provider: this.name, status: "succeeded", amount: request.amount, createdAt: now, updatedAt: now };
  }
  capturePayment(_id: string): Promise<PaymentIntent> { throw new ProviderError("no", "unsupported", this.name); }
  cancelPayment(_id: string): Promise<PaymentIntent> { throw new PayKitError("no", "unsupported", this.name); }
  refundPayment(_request: RefundRequest): Promise<RefundResult> { throw new IdempotencyError("k", this.name); }
  getPayment(_id: string): Promise<PaymentIntent> { throw new WebhookSignatureError(this.name, "no"); }
  async listPayments(): Promise<PaymentIntent[]> { return []; }
}
const service = new IdempotentPaymentExecutor(new AdyenProvider());
const label: PaymentProvider = "adyen";
const known: PaymentProvider = "stripe";
void new WebhookEngine().process({ rawBody: "{}", provider: "adyen" });
void new ReconciliationEngine({ provider: "adyen" });
void [service, label, known];
// @ts-expect-error -- a provider's name is still a string
const notAName: PaymentProvider = 5;
void notAName;
`;
    expect(strictDiagnostics(new Map([["adapter", adapter]])).get("adapter")).toEqual([]);
  });

  test("autocomplete still offers the known provider names", () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/types/index.ts"), "utf8");
    const declaration = /export type PaymentProvider = ([^;]+);/.exec(source)![1];
    expect(declaration).toContain('"stripe"');
    expect(declaration).toContain('"mock"');
    // A bare `| string` collapses the whole union to `string`, and the names with it.
    expect(declaration).not.toMatch(/\|\s*string\s*$/);
  });

  test("no snippet silences the webhook payload with `data: any`", () => {
    const snippets = [...typescriptBlocksOf("README.md"), ...typescriptBlocksOf("docs/usage.md"), ...JSDOC_FILES.flatMap((f) => [...jsdocExamplesOf(f)])];
    expect(snippets.filter(([, code]) => /\bdata: any\b/.test(code)).map(([label]) => label)).toEqual([]);
  });

  test("the check itself: every kind of error it exists for is caught, and a clean snippet passes", () => {
    expect(diagnostics.get("sample:unknown-data")!.join()).toContain("TS18046");
    expect(diagnostics.get("sample:missing-field")!.join()).toContain("TS2339");
    expect(diagnostics.get("sample:undeclared-name")!.join()).toContain("TS2304");
    expect(diagnostics.get("sample:unused-expect-error")!.join()).toContain("TS2578");
    expect(diagnostics.get("sample:control")).toEqual([]);
  });
});

/** The ```typescript block containing `marker`. */
function typescriptBlockContaining(file: string, marker: string): string {
  const markdown = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  for (const m of markdown.matchAll(/```typescript\n([\s\S]*?)\n```/g)) {
    if (m[1].includes(marker)) return m[1];
  }
  throw new Error(`${file}: no typescript block contains ${marker}`);
}

/**
 * An in-memory stand-in for the ioredis calls the examples make. TTLs are not
 * modelled (tests expire a key by deleting it), and `eval` understands only
 * the examples' two scripts — compare-and-delete on equality, and delete
 * unless the value carries the given prefix — so this checks how the store
 * wires them, not Lua itself.
 */
class FakeRedis {
  data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: unknown[]): Promise<"OK" | null> {
    if (args.includes("NX") && this.data.has(key)) return null;
    this.data.set(key, value);
    return "OK";
  }
  async eval(script: string, _numKeys: number, key: string, arg: string): Promise<number> {
    const value = this.data.get(key);
    if (script.includes("== ARGV[1]")) {
      if (value !== arg) return 0;
      this.data.delete(key);
      return 1;
    }
    if (script.includes("string.sub")) {
      if (value === undefined || value.startsWith(arg)) return 0;
      this.data.delete(key);
      return 1;
    }
    throw new Error(`FakeRedis does not know this script: ${script}`);
  }
}

describe("the documented Redis IdempotencyStore implements the real interface and keeps its guarantees", () => {
  const cases: [string, string][] = [
    ["README.md", ""],
    ["docs/usage.md", 'import { IdempotencyRecord, IdempotencyStore } from "paykit";\n'],
  ];

  test.each(cases)("%s: the example type-checks against IdempotencyStore (strict)", (file, typeImports) => {
    const block = typescriptBlockContaining(file, "class RedisIdempotencyStore implements IdempotencyStore");
    const prelude = `${typeImports}import { IdempotentPaymentExecutor, PaymentProvider_Interface } from "paykit";
type Redis = { get(key: string): Promise<string | null>; set(...args: any[]): Promise<"OK" | null>; eval(...args: any[]): Promise<unknown> };
declare const redis: Redis;
declare const provider: PaymentProvider_Interface;
`;
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "paykit-docs-"));
    const file_ = path.join(dir, "redis_store.ts");
    try {
      fs.writeFileSync(file_, `${prelude}${block}\nexport { executor };\n`);
      const repo = path.join(__dirname, "..");
      const program = ts.createProgram([file_], {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
        skipLibCheck: true,
        baseUrl: repo,
        paths: { paykit: ["src/index.ts"] },
        typeRoots: [path.join(repo, "node_modules", "@types")],
        types: ["node"],
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function loadExample(file: string, provider: unknown) {
    const block = typescriptBlockContaining(file, "class RedisIdempotencyStore implements IdempotencyStore");
    const redis = new FakeRedis();
    // The examples rely on the guide's surrounding imports for the executor.
    const source = `import { IdempotentPaymentExecutor } from "paykit";\nconst redis: any = __harness.redis;\nconst provider: any = __harness.provider;\n${block}\nmodule.exports = { RedisIdempotencyStore, executor };\n`;
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    const req = (id: string) => (id === "paykit" ? paykit : id === "node:crypto" ? require("crypto") : (() => { throw new Error(id); })());
    new Function("require", "module", "exports", "__harness", js)(req, mod, mod.exports, { redis, provider });
    return { redis, ...(mod.exports as { RedisIdempotencyStore: new (r: unknown) => paykit.IdempotencyStore; executor: paykit.IdempotentPaymentExecutor }) };
  }

  test.each(cases)("%s: one charge under concurrency, release on failure, and a stale release cannot free a newer reservation", async (file) => {
    const provider = new paykit.MockProvider({ successRate: 1.0, latencyMs: 20 });
    const create = jest.spyOn(provider, "createPayment");
    const { redis, RedisIdempotencyStore, executor } = loadExample(file, provider);

    // Concurrent callers: exactly one provider call, both get the same payment.
    const req = { amount: { amount: 4999, currency: "USD" }, idempotencyKey: "order_redis" };
    const [a, b] = await Promise.all([executor.execute(req), executor.execute(req)]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(b.id).toBe(a.id);

    const store = new RedisIdempotencyStore(redis);
    // A token per reservation; a stale token releases nothing.
    const tokenA = await store.reserve("k_stale");
    expect(typeof tokenA).toBe("string");
    redis.data.delete("k_stale"); // A's marker expires (PX)
    const tokenB = await store.reserve("k_stale");
    expect(typeof tokenB).toBe("string");
    expect(tokenB).not.toBe(tokenA);
    await store.release("k_stale", tokenA as string); // A's late release...
    expect(await store.reserve("k_stale")).toBeNull(); // ...left B's reservation alone
    expect(await store.get("k_stale")).toBeNull(); // a marker is never a result
    await store.delete("k_stale"); // delete() never removes an in-flight marker
    expect(await store.reserve("k_stale")).toBeNull();
    await store.release("k_stale", tokenB as string);
    expect(await store.reserve("k_stale")).not.toBeNull();

    // A hard failure releases the reservation, so the key is usable again.
    const failing = new paykit.MockProvider({ successRate: 1.0 });
    jest.spyOn(failing, "createPayment").mockRejectedValue(new paykit.ProviderError("declined", "card_declined", "mock", false));
    const { executor: failingExecutor, redis: redis2 } = loadExample(file, failing);
    await expect(failingExecutor.execute({ ...req, idempotencyKey: "order_fail" })).rejects.toMatchObject({ code: "card_declined" });
    expect(redis2.data.has("order_fail")).toBe(false);
  });
});

describe("documented commands use only declared tools and scripts", () => {
  const root = path.join(__dirname, "..");
  const pkg = (p: string) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
  const rootPkg = pkg("package.json");
  const frontendPkg = pkg("frontend/package.json");
  const scripts = new Set([...Object.keys(rootPkg.scripts ?? {}), ...Object.keys(frontendPkg.scripts ?? {})]);
  const declared = new Set(
    [rootPkg, frontendPkg].flatMap((p) => [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.devDependencies ?? {})]),
  );
  /** npx binary → the package that ships it, where the names differ. */
  const binPackage: Record<string, string> = { tsc: "typescript" };
  const docs = ["README.md", "CONTRIBUTING.md", "docs/usage.md", "docs/architecture.md"].map((f) => [
    f,
    fs.readFileSync(path.join(root, f), "utf8"),
  ]);

  test("every `npm run <script>` names a script that exists (root or frontend)", () => {
    const missing = docs.flatMap(([f, text]) =>
      [...text.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]).filter((s) => !scripts.has(s)).map((s) => `${f}: npm run ${s}`),
    );
    expect(missing).toEqual([]);
  });

  test("every `npx <tool>` is provided by a declared dependency (npx would otherwise fetch an unpinned one)", () => {
    const undeclared = docs.flatMap(([f, text]) =>
      [...text.matchAll(/npx (?:--[\w-]+ )*([a-z@][\w@/.-]*)/g)]
        .map((m) => m[1])
        .filter((tool) => !declared.has(binPackage[tool] ?? tool))
        .map((tool) => `${f}: npx ${tool}`),
    );
    expect(undeclared).toEqual([]);
  });
});

describe("documented claims that are not output", () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

  test("no doc or example puts a client secret in an email or a URL", () => {
    // The type's own rule (src/types/index.ts): never log it or put it in a URL.
    expect(read("src/types/index.ts")).toContain("never log it or put it in a URL");
    const docs = ["README.md", "docs/usage.md", "docs/architecture.md", "examples/basic_payment.ts", "examples/nextjs_integration.ts"];
    const unsafe = /(?:e?mail|send|notify|sms)\w*\([^)\n]*(?:clientSecret|client_secret)|\$\{[^}\n]*(?:clientSecret|client_secret)[^}\n]*\}|[?&](?:client_?[sS]ecret|secret)=/i;
    const hits = docs.flatMap((f) =>
      read(f)
        .split("\n")
        .map((text, i) => ({ where: `${f}:${i + 1}`, text }))
        .filter((l) => unsafe.test(l.text))
        .map((l) => `${l.where}: ${l.text.trim()}`),
    );
    expect(hits).toEqual([]);
    // The guard fires on what it is for, and not on the safe flow.
    expect(unsafe.test("await emailCustomerToAuthenticate(intent.clientSecret);")).toBe(true);
    expect(unsafe.test("`https://shop.example/pay?client_secret=${s}`")).toBe(true);
    expect(unsafe.test("await emailCustomer(`https://shop.example/orders/${orderId}/authenticate`);")).toBe(false);
    expect(read("README.md")).toContain("Never the client secret.");
  });

  test("the README's Provider Abstraction snippet runs: every name it uses is imported", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => run(firstTypescriptBlockAfter("README.md", /^## Provider Abstraction$/m), "")).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  test("README and scripts: no static test badge, and `npm test` cannot pass with no tests", () => {
    expect(read("README.md")).not.toMatch(/badge\/tests-passing/);
    expect(read("README.md")).toMatch(/actions\/workflows\/ci\.yml\/badge\.svg/);
    expect(JSON.parse(read("package.json")).scripts.test).toBe("jest");
  });

  test("no sample reads result.unhandled alongside a wildcard handler, which makes it unreachable", () => {
    for (const file of ["README.md", "docs/usage.md"]) {
      for (const [label, block] of typescriptBlocksOf(file)) {
        const dead = /\.on\("\*"/.test(block) && /\.unhandled\b/.test(block);
        expect({ label, dead }).toEqual({ label, dead: false });
      }
    }
    expect(read("README.md")).toContain("with\none registered, nothing is ever `unhandled`");
    expect(read("docs/usage.md")).toContain("nothing is ever\n// `unhandled`");
  });

  test("the README names exactly what frontend/lib/sdk.ts re-exports from paykit", () => {
    const claim = /`frontend\/lib\/sdk\.ts` wrapper re-exports the real ([^]*?) from\s+the `paykit` package/.exec(read("README.md"));
    if (!claim) throw new Error("the README does not describe the sdk.ts re-exports");
    const claimed = [...claim[1].matchAll(/`(\w+)`/g)].map((m) => m[1]);
    const reExport = /export \{([^}]*)\} from "paykit"/.exec(read("frontend/lib/sdk.ts"));
    if (!reExport) throw new Error("frontend/lib/sdk.ts does not re-export from paykit");
    const actual = reExport[1].split(",").map((name) => name.trim()).filter((name) => name && name !== "VERSION");
    expect(claimed.sort()).toEqual(actual.sort());
  });

  test("the docs say a refund changes a mock payment's status and not a Stripe one's", () => {
    expect(read("README.md")).toContain("**One difference from Stripe.** A refund changes a mock payment's status");
    expect(read("src/types/index.ts")).toContain("`StripeProvider` never\n * returns them");
    // The README's other half of this is true of Stripe: tests/stripe_provider.test.ts
    // pins that a PaymentIntent's status never maps to one; here is the mock's.
    expect(read("src/providers/mock.ts")).toContain('? ("refunded" as PaymentStatus)');
  });

  test("the docs say refund.succeeded never fires for Stripe, and it does not", () => {
    for (const stripeType of ["refund.created", "refund.updated", "refund.failed", "charge.refunded"]) {
      expect(paykit.normalizeStripeEventType(stripeType, {})).toBe(stripeType);
    }
    expect(read("README.md")).toContain("`refund.succeeded` compiles, for a provider that sends it, but it never fires for\nStripe");
    expect(read("docs/usage.md")).toMatch(/`refund\.succeeded` is\s+accepted too, but never fires for Stripe/);
  });

  test("the playground and README say what a backend serves, and what is not the shipped code", () => {
    const page = fs.readFileSync(path.join(__dirname, "../frontend/app/page.tsx"), "utf8");
    const api = fs.readFileSync(path.join(__dirname, "../frontend/lib/api.ts"), "utf8");
    const sdk = fs.readFileSync(path.join(__dirname, "../frontend/lib/sdk.ts"), "utf8");
    const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");
    // A backend serves one thing: the health ping aside, api.ts posts only to /fraud/check.
    expect([...api.matchAll(/postJson<[^>]*>\("([^"]+)"/g)].map((m) => m[1])).toEqual(["/fraud/check"]);
    expect(page).not.toContain('"Live backend"');
    expect(page).toContain("Fraud tab: live backend");
    expect(page).not.toContain("to route through a live backend");
    // The browser engine has its own dispatch and dedup, and the docs say so.
    expect(sdk).toMatch(/class BrowserWebhookEngine[\s\S]*private processedIds[\s\S]*for \(const handler of all\)/);
    expect(readme).not.toContain("Everything except the webhook HMAC is the literal shipped code");
    expect(readme).toContain("reimplements dispatch and\ndeduplication");
  });

  test("SECURITY.md says whether CI runs the browser driver, and it is right", () => {
    const saysNotInCi = /\(`e2e\/smoke\.mjs`\) is not in CI/.test(read("SECURITY.md"));
    expect(saysNotInCi).toBe(!read(".github/workflows/ci.yml").includes("smoke.mjs"));
  });

  test("the architecture guide describes both builds' stripe loaders, and states what the browser engine lacks", () => {
    const guide = read("docs/architecture.md");
    expect(guide).not.toMatch(/same code path/);
    expect(guide).toMatch(/CJS build uses its module's own `require`/);
    expect(guide).toMatch(/ESM build a native dynamic `import\(\)`/);
    expect(guide).not.toMatch(/only\s+intentional difference/);
    expect(guide).toMatch(/\*\*No retries or timeout\.\*\*/);
    expect(guide).toMatch(/\*\*One signature scheme\.\*\*/);
  });
});

describe("every documented way to install the playground installs the SDK first", () => {
  // frontend/ depends on the SDK as `paykit: file:..`, and npm runs the SDK's
  // `prepare` script through that link. Without the root toolchain that dies
  // with `sh: tsup: command not found`, so it must never be a fresh clone's path.
  const root = path.join(__dirname, "..");
  const FRONTEND_INSTALL = /cd frontend(?:\s*&&\s*|\s*\n\s*)npm (?:install|ci)\b/;
  const ROOT_INSTALL = /(?:^|\n|`)\s*npm (?:install|ci)\b/;

  test.each(["frontend-install", "frontend", "frontend-build", "demo-local"])("make %s", (target) => {
    const steps = execFileSync("make", ["-n", target], { cwd: root, encoding: "utf8" });
    const frontendAt = steps.search(FRONTEND_INSTALL);
    expect(frontendAt).toBeGreaterThan(-1);
    expect(steps.slice(0, frontendAt)).toMatch(ROOT_INSTALL);
  });

  test.each(["README.md", "CONTRIBUTING.md", "docs/usage.md", "frontend/README.md"])("%s", (file) => {
    const markdown = fs.readFileSync(path.join(root, file), "utf8");
    const snippets = [...markdown.matchAll(/```bash\n([\s\S]*?)```|`([^`\n]+)`/g)].map((m) => m[1] ?? m[2]);
    const installs = snippets.filter((snippet) => FRONTEND_INSTALL.test(snippet));
    expect(installs.length).toBeGreaterThan(0);
    for (const snippet of installs) {
      expect(snippet.slice(0, snippet.search(FRONTEND_INSTALL))).toMatch(ROOT_INSTALL);
    }
  });

  test("the playground's README counts the built-in rules right", () => {
    const readme = fs.readFileSync(path.join(root, "frontend/README.md"), "utf8");
    expect(readme).toContain(`${new paykit.FraudDetector().getRules().length} built-in rules`);
  });
});

describe("every file the docs mention exists", () => {
  const root = path.join(__dirname, "..");
  const skip = new Set(["node_modules", "dist", "coverage", ".next", ".git"]);
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      if (skip.has(d.name)) return [];
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return files(p);
      return /\.(ts|tsx|mjs|js|md|json|yml)$/.test(d.name) ? [p] : [];
    });
  }
  const scanned = [
    ...["src", "tests", "docs", "examples", "scripts", "e2e", "frontend/app", "frontend/components", "frontend/lib", ".github"].flatMap((d) =>
      fs.existsSync(path.join(root, d)) ? files(path.join(root, d)) : [],
    ),
    ...fs.readdirSync(root).filter((f) => f.endsWith(".md")).map((f) => path.join(root, f)),
    ...(fs.existsSync(path.join(root, "frontend/README.md")) ? [path.join(root, "frontend/README.md")] : []),
  ];
  const lines = scanned.flatMap((f) =>
    fs
      .readFileSync(f, "utf8")
      .split("\n")
      .map((text, i) => ({ where: `${path.relative(root, f)}:${i + 1}`, text, file: f })),
  );

  test("every *.md file the repository mentions exists in it", () => {
    expect(scanned.length).toBeGreaterThan(20);
    const shipped = new Set(lines.map((l) => l.file).filter((f) => f.endsWith(".md")).map((f) => path.basename(f)));
    shipped.add("PULL_REQUEST_TEMPLATE.md");
    const missing = lines.flatMap((l) =>
      [...l.text.matchAll(/[A-Za-z0-9_.-]+\.md\b/g)].map((m) => m[0]).filter((name) => !shipped.has(name)).map((name) => `${l.where}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  test("every relative markdown link resolves to a file in the repository", () => {
    const broken = lines
      .filter((l) => l.file.endsWith(".md"))
      .flatMap((l) =>
        [...l.text.matchAll(/\]\(([^)\s]+)\)/g)]
          .map((m) => m[1].split("#")[0])
          .filter((target) => target && !/^[a-z]+:/i.test(target))
          .filter((target) => !fs.existsSync(path.resolve(path.dirname(l.file), target)))
          .map((target) => `${l.where}: ${target}`),
      );
    expect(broken).toEqual([]);
  });
});

describe("docker: NEXT_PUBLIC_* settings reach the build, where Next.js reads them", () => {
  const root = path.join(__dirname, "..");
  const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "frontend/Dockerfile"), "utf8");

  test("compose passes NEXT_PUBLIC_API_URL as a build arg, never as a (dead) runtime environment variable", () => {
    expect(compose).not.toMatch(/environment:[\s\S]*NEXT_PUBLIC_/);
    expect(compose).toMatch(/args:\s*\n\s*NEXT_PUBLIC_API_URL:/);
  });

  test("the Dockerfile declares the ARG before `next build` runs", () => {
    const arg = dockerfile.indexOf("ARG NEXT_PUBLIC_API_URL");
    const build = dockerfile.indexOf("RUN npm run build", dockerfile.indexOf("WORKDIR /repo/frontend"));
    expect(arg).toBeGreaterThan(-1);
    expect(arg).toBeLessThan(build);
  });
});

describe("the README screenshot and the social card are captured from the current playground", () => {
  const root = path.join(__dirname, "..");
  const OG = "frontend/public/og.png";
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs/screenshots.json"), "utf8")) as {
    capturedAt: string;
    frontendSourcesSha256: string;
    images: Record<string, { sha256: string }>;
  };
  const sha256 = (buf: Buffer | string) => require("crypto").createHash("sha256").update(buf).digest("hex") as string;

  /** Same file set and order as `frontendSourcesSha256` in scripts/capture-images.mjs. */
  function screenshotSources(): string {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
        const rel = path.join(dir, name);
        if (fs.statSync(path.join(root, rel)).isDirectory()) walk(rel);
        else if (rel !== OG) files.push(rel);
      }
    };
    for (const dir of ["frontend/app", "frontend/lib", "frontend/public"]) walk(dir);
    files.push("frontend/tailwind.config.ts", "frontend/postcss.config.js", "frontend/next.config.mjs");
    const hash = require("crypto").createHash("sha256");
    for (const rel of files.sort()) hash.update(rel).update("\0").update(fs.readFileSync(path.join(root, rel))).update("\0");
    return hash.digest("hex");
  }

  test("the frontend sources they depict are unchanged since the capture (else: npm run capture)", () => {
    expect(screenshotSources()).toBe(manifest.frontendSourcesSha256);
  });

  test("each image is the one the capture flow produced", () => {
    expect(Object.keys(manifest.images).sort()).toEqual(["docs/screenshot.png", OG].sort());
    for (const [rel, { sha256: expected }] of Object.entries(manifest.images)) {
      expect({ rel, sha256: sha256(fs.readFileSync(path.join(root, rel))) }).toEqual({ rel, sha256: expected });
    }
  });

  test("the README caption carries the capture date, and it is not in the future", () => {
    expect(manifest.capturedAt <= new Date().toLocaleDateString("en-CA")).toBe(true);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toContain(`Captured ${manifest.capturedAt}`);
  });
});

describe("the README states the conditions on two behaviours", () => {
  const readme = fs.readFileSync(path.join(__dirname, "../README.md"), "utf8");

  test("what a replay changes: tests/idempotent.test.ts holds the code to this", () => {
    expect(readme).toContain("`metadata._idempotency` is set to `cache_hit` or `in_flight_join`, replacing");
    expect(readme).not.toMatch(/first recorded: read a pending/);
  });

  test("fuzzy matching of balance transactions needs fuzzyDate, whose test is in tests/reconciliation.test.ts", () => {
    expect(readme).toContain("leave internal ids empty, set `fuzzyDate: true`, and let fuzzy matching pair");
  });
});
