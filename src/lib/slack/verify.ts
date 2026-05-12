/**
 * Slack request signature verification.
 *
 * Slack signs each event request with HMAC-SHA256 over `v0:{timestamp}:{body}`
 * using the app's signing secret. We must:
 *
 *   1. Reject requests with a timestamp more than 5 minutes from now (replay
 *      guard — Slack's documented window).
 *   2. Compute `v0=` + HMAC-SHA256 hex.
 *   3. Compare in constant time to defeat timing oracles.
 *
 * The raw request body must be passed in unmodified (no JSON parse → stringify
 * round-trip), because Slack hashes the bytes it sent.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const FIVE_MINUTES_SECONDS = 5 * 60;

export interface VerifyInput {
  /** Raw body string. Must be the exact bytes Slack sent. */
  body: string;
  /** Value of the `X-Slack-Request-Timestamp` header. */
  timestamp: string | null | undefined;
  /** Value of the `X-Slack-Signature` header. */
  signature: string | null | undefined;
  /** Slack app's signing secret (from SSM). */
  signingSecret: string;
  /** Override clock for tests (seconds since epoch). */
  nowSeconds?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing-header" | "stale-timestamp" | "bad-signature" };

const safeEqualHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
};

export const verifySlackSignature = (input: VerifyInput): VerifyResult => {
  const { body, timestamp, signature, signingSecret } = input;
  if (!timestamp || !signature || !signingSecret) {
    return { ok: false, reason: "missing-header" };
  }
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) {
    return { ok: false, reason: "missing-header" };
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > FIVE_MINUTES_SECONDS) {
    return { ok: false, reason: "stale-timestamp" };
  }
  const base = `v0:${timestamp}:${body}`;
  const digest = createHmac("sha256", signingSecret).update(base).digest("hex");
  const expected = `v0=${digest}`;
  if (!safeEqualHex(expected, signature)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true };
};
