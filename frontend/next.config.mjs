/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The `paykit` package is imported into the browser bundle for its
  // browser-safe primitives (MockProvider, IdempotentPaymentExecutor,
  // InMemoryIdempotencyStore, FraudDetector). The same package also ships a
  // Node-only `WebhookEngine` that statically imports `node:crypto`, and a
  // `StripeProvider` that dynamically imports `stripe` (marked webpackIgnore,
  // so webpack leaves that import alone). We never call those from the client, but
  // the static import must still resolve at bundle time — so we map the Node
  // built-ins to empty modules in the browser build. The playground uses
  // `BrowserWebhookEngine` (Web Crypto) for webhook HMAC instead.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        stripe: false,
      };
    }
    return config;
  },
};
export default nextConfig;
