import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifySlackSignature } from "@/lib/slack/verify";

const SECRET = "test-signing-secret";

const sign = (body: string, ts: number, secret = SECRET): string => {
  const digest = createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return `v0=${digest}`;
};

describe("verifySlackSignature", () => {
  const now = 1_700_000_000;
  const body = '{"type":"event_callback","event":{"type":"app_mention"}}';

  it("accepts a fresh, well-signed request", () => {
    const sig = sign(body, now);
    const r = verifySlackSignature({
      body,
      timestamp: String(now),
      signature: sig,
      signingSecret: SECRET,
      nowSeconds: now,
    });
    expect(r).toEqual({ ok: true });
  });

  it("rejects stale timestamps (>5 min)", () => {
    const stale = now - 6 * 60;
    const sig = sign(body, stale);
    const r = verifySlackSignature({
      body,
      timestamp: String(stale),
      signature: sig,
      signingSecret: SECRET,
      nowSeconds: now,
    });
    expect(r).toEqual({ ok: false, reason: "stale-timestamp" });
  });

  it("rejects future-skewed timestamps (>5 min)", () => {
    const future = now + 6 * 60;
    const sig = sign(body, future);
    const r = verifySlackSignature({
      body,
      timestamp: String(future),
      signature: sig,
      signingSecret: SECRET,
      nowSeconds: now,
    });
    expect(r).toEqual({ ok: false, reason: "stale-timestamp" });
  });

  it("rejects a tampered signature", () => {
    const sig = sign(body, now);
    const tampered = sig.slice(0, -2) + (sig.endsWith("a") ? "00" : "aa");
    const r = verifySlackSignature({
      body,
      timestamp: String(now),
      signature: tampered,
      signingSecret: SECRET,
      nowSeconds: now,
    });
    expect(r).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a signature computed under a different secret", () => {
    const sig = sign(body, now, "wrong-secret");
    const r = verifySlackSignature({
      body,
      timestamp: String(now),
      signature: sig,
      signingSecret: SECRET,
      nowSeconds: now,
    });
    expect(r).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects when timestamp header missing", () => {
    const sig = sign(body, now);
    const r = verifySlackSignature({
      body,
      timestamp: null,
      signature: sig,
      signingSecret: SECRET,
      nowSeconds: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-header");
  });

  it("rejects when signature header missing", () => {
    const r = verifySlackSignature({
      body,
      timestamp: String(now),
      signature: null,
      signingSecret: SECRET,
      nowSeconds: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-header");
  });

  it("rejects when timestamp is not a number", () => {
    const sig = sign(body, now);
    const r = verifySlackSignature({
      body,
      timestamp: "not-a-number",
      signature: sig,
      signingSecret: SECRET,
      nowSeconds: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-header");
  });

  it("rejects when signing secret missing", () => {
    const sig = sign(body, now);
    const r = verifySlackSignature({
      body,
      timestamp: String(now),
      signature: sig,
      signingSecret: "",
      nowSeconds: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing-header");
  });
});
