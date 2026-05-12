import { describe, expect, it } from "vitest";

import { sanitizeError, splitMessage } from "@/lib/slack/formatter";

describe("splitMessage", () => {
  it("returns [\"\"] for empty input", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  it("returns single chunk when within limit", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  it("splits on paragraph boundary", () => {
    const text = "a".repeat(20) + "\n\n" + "b".repeat(20);
    const chunks = splitMessage(text, 25);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(25));
    expect(chunks.join("\n\n")).toBe(text);
  });

  it("falls back to sentence boundary when no paragraph fits", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const chunks = splitMessage(text, 20);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(20));
  });

  it("hard-slices when no boundary exists", () => {
    const text = "x".repeat(100);
    const chunks = splitMessage(text, 30);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(30));
    expect(chunks.join("")).toBe(text);
  });

  it("balances code fences when the cut splits a block", () => {
    // The first chunk would otherwise end with an opening fence and no close.
    const before = "intro paragraph.\n\n";
    const block = "```\n" + ("line\n".repeat(40)) + "```";
    const text = before + block;
    const chunks = splitMessage(text, 120);
    // Every chunk must have an even number of fences (balanced).
    chunks.forEach((c) => {
      const count = (c.match(/```/g) || []).length;
      expect(count % 2).toBe(0);
    });
  });

  it("respects max length even when splitting mid-block", () => {
    const block = "```\n" + ("x".repeat(500)) + "\n```";
    const chunks = splitMessage(block, 100);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(100));
  });
});

describe("sanitizeError", () => {
  it("redacts OpenAI keys", () => {
    expect(sanitizeError(new Error("call failed: sk-proj-abcdefghijklmnop123"))).toContain(
      "[redacted-openai-key]",
    );
  });

  it("redacts Anthropic keys", () => {
    expect(sanitizeError(new Error("sk-ant-abcdefghij1234567890"))).toContain(
      "[redacted-anthropic-key]",
    );
  });

  it("redacts Slack tokens", () => {
    expect(sanitizeError(new Error("xoxb-1234-5678-abcdef"))).toContain(
      "[redacted-slack-token]",
    );
  });

  it("redacts xAI keys", () => {
    expect(sanitizeError(new Error("xai-abcdefghij1234567890"))).toContain(
      "[redacted-xai-key]",
    );
  });

  it("redacts Tavily keys", () => {
    expect(sanitizeError(new Error("tvly-abcdefghij1234567890"))).toContain(
      "[redacted-tavily-key]",
    );
  });

  it("redacts AWS access keys", () => {
    expect(sanitizeError(new Error("got AKIAIOSFODNN7EXAMPLE back"))).toContain(
      "[redacted-aws-key]",
    );
  });

  it("strips ts/js paths", () => {
    expect(
      sanitizeError(new Error("at /src/lib/slack/verify.ts:42 thing failed")),
    ).toContain("[path]");
  });

  it("truncates very long messages", () => {
    const r = sanitizeError(new Error("x".repeat(1000)));
    expect(r.length).toBeLessThanOrEqual(300);
    expect(r.endsWith("...")).toBe(true);
  });

  it("falls back on non-Error inputs", () => {
    expect(sanitizeError("plain string error")).toBe("plain string error");
  });
});
