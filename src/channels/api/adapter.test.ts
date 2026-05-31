import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { apiChannel } from "@/channels/api/adapter";
import { __resetServerEnvForTests } from "@/lib/env";
import { __resetStorageProviderForTests } from "@/storage/provider";

const ORIGINAL = { ...process.env };

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("apiChannel", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    process.env.API_CHANNEL_TOKENS = `tenant-a:${hash("secret-token")}`;
    __resetServerEnvForTests();
    __resetStorageProviderForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
    __resetStorageProviderForTests();
  });

  it("rejects requests without a configured bearer token", async () => {
    const result = await apiChannel.ingest({
      headers: {},
      rawBody: JSON.stringify({ userId: "u1", text: "hello" }),
    });
    expect(result).toEqual({ messages: [], ack: { status: 401, body: "unauthorized" } });
  });

  it("normalizes valid JSON requests into an InboundMessage", async () => {
    const result = await apiChannel.ingest({
      headers: { authorization: "Bearer secret-token" },
      rawBody: JSON.stringify({
        conversationId: "conv-1",
        userId: "user-1",
        text: "hello",
        dedupKey: "req-1",
        attachments: [{ url: "https://example.com/a.txt", mime: "text/plain" }],
      }),
    });

    expect(result.ack).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      channel: "api",
      tenantId: "tenant-a",
      conversationId: "conv-1",
      userId: "user-1",
      text: "hello",
      dedupKey: "req-1",
      surface: "direct",
      attachments: [{ url: "https://example.com/a.txt", mime: "text/plain" }],
    });
  });

  it("returns a 400 ack for malformed JSON", async () => {
    const result = await apiChannel.ingest({
      headers: { authorization: "Bearer secret-token" },
      rawBody: "{",
    });
    expect(result).toEqual({ messages: [], ack: { status: 400, body: "invalid json" } });
  });

  it("uses plain text rendering rules", () => {
    expect(apiChannel.renderingRules()).toContain("plain text");
  });

  it("uploads media through the configured blob store capability", async () => {
    const result = await apiChannel.ingest({
      headers: { authorization: "Bearer secret-token" },
      rawBody: JSON.stringify({ userId: "user-1", text: "hello" }),
    });
    const msg = result.messages[0];
    expect(msg).toBeDefined();

    const uploaded = await apiChannel.capabilities(msg!).uploadMedia?.({
      name: "artifact.txt",
      mime: "text/plain",
      data: new TextEncoder().encode("saved"),
    });

    expect(uploaded?.url).toBe("memory://api/tenant-a/artifact.txt");
  });
});
