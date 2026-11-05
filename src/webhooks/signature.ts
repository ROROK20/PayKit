/**
 * Stripe `Stripe-Signature` header parsing and digest-format validation.
 *
 * Dependency-free and browser-safe: the Node `WebhookEngine` and the
 * playground's `BrowserWebhookEngine` both call these, so the two cannot
 * disagree about which headers are well-formed.
 */

export interface StripeSignatureHeader {
  /** The `t=` timestamp exactly as sent (unix seconds). The first one wins. */
  timestamp: string;
  /**
   * Every `v1=` signature. Stripe sends one per active endpoint secret, so a
   * header carries several while a secret is being rolled; a match against
   * ANY of them is valid.
   */
  signatures: string[];
}

/**
 * Parse `t=<ts>,v1=<hex>[,v1=<hex>...][,v0=...]`. Returns `null` when there is
 * no timestamp or no `v1` signature. Unknown schemes (`v0`) are ignored.
 */
export function parseStripeSignatureHeader(header: string): StripeSignatureHeader | null {
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t" && timestamp === undefined) timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * True only for exactly 64 lowercase hex characters — the canonical encoding
 * of an HMAC-SHA256 digest, and what Stripe sends. Checked BEFORE decoding:
 * Node's `Buffer.from(s, "hex")` silently stops at the first non-hex
 * character and drops a trailing odd nibble, so `<valid digest>zz` or a
 * 65-character string would otherwise decode to the valid digest.
 */
export function isSha256HexDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
