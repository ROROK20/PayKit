/**
 * StripeProvider when the optional `stripe` peer dependency cannot be loaded.
 *
 * Each case swaps in its own `stripe` module failure (jest.doMock + a fresh
 * module registry) and reproduces the error a real resolver raises. Only "the
 * stripe package itself is absent" — CommonJS MODULE_NOT_FOUND or ESM
 * ERR_MODULE_NOT_FOUND naming 'stripe' — may be downgraded to a warning; every
 * other load failure must surface as itself.
 */

type ProviderModule = typeof import("../src/providers/stripe");

function loadProviderWithStripe(factory: () => unknown): ProviderModule["StripeProvider"] {
  let StripeProvider!: ProviderModule["StripeProvider"];
  jest.isolateModules(() => {
    jest.doMock("stripe", factory, { virtual: true });
    ({ StripeProvider } = require("../src/providers/stripe") as ProviderModule);
  });
  return StripeProvider;
}

const resolverError = (code: string, message: string) => Object.assign(new Error(message), { code });

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  jest.resetModules();
});

test.each([
  ["CommonJS", "MODULE_NOT_FOUND", "Cannot find module 'stripe'\nRequire stack:\n- /app/node_modules/paykit/dist/index.js"],
  ["ES module", "ERR_MODULE_NOT_FOUND", "Cannot find package 'stripe' imported from /app/node_modules/paykit/dist/index.mjs"],
])("%s: a missing stripe package warns, ready() is false, and calls fail NOT_INITIALIZED", async (_kind, code, message) => {
  const StripeProvider = loadProviderWithStripe(() => {
    throw resolverError(code, message);
  });
  const provider = new StripeProvider({ secretKey: "sk_test_x" });
  await expect(provider.ready()).resolves.toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("stripe package not installed"));
  await expect(provider.getPayment("pi_1")).rejects.toMatchObject({ code: "NOT_INITIALIZED", provider: "stripe" });
});

test.each([
  ["a missing dependency OF stripe", resolverError("MODULE_NOT_FOUND", "Cannot find module 'qs'\nRequire stack:\n- /app/node_modules/stripe/cjs/stripe.cjs.node.js")],
  ["a stripe install missing its entry file", resolverError("ERR_MODULE_NOT_FOUND", "Cannot find module '/app/node_modules/stripe/esm/stripe.esm.node.js' imported from /app/x.mjs")],
  ["an SDK that throws while loading", new SyntaxError("Unexpected token 'export'")],
])("%s surfaces as itself from ready() and every call — never as 'not installed'", async (_name, error) => {
  const StripeProvider = loadProviderWithStripe(() => {
    throw error;
  });
  const provider = new StripeProvider({ secretKey: "sk_test_x" });
  await expect(provider.ready()).rejects.toBe(error);
  await expect(provider.getPayment("pi_1")).rejects.toBe(error);
  await expect(
    provider.createPayment({ amount: { amount: 100, currency: "USD" }, idempotencyKey: "k" }),
  ).rejects.toBe(error);
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("not installed"));
});

test("a load failure on a provider nobody calls is not an unhandled rejection", async () => {
  const StripeProvider = loadProviderWithStripe(() => {
    throw new Error("boom while loading");
  });
  const unhandled = jest.fn();
  process.on("unhandledRejection", unhandled);
  try {
    new StripeProvider({ secretKey: "sk_test_x" });
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});
