import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit test: keep storage in-memory so the pipeline doesn't reach real DynamoDB.
vi.mock("@/storage/provider", async () => {
  const { createMemoryKv } = await import("@/storage/memory-kv");
  const { createMemoryDocStore } = await import("@/storage/memory-doc");
  const { createMemoryBlobStore } = await import("@/storage/memory-blob");
  const provider = {
    kv: createMemoryKv(),
    doc: createMemoryDocStore(),
    blob: createMemoryBlobStore(),
  };
  return {
    getStorageProvider: () => provider,
    createStorageProvider: () => provider,
    __resetStorageProviderForTests: () => {},
  };
});

import { POST } from "@/app/api/channels/[channel]/route";
import { defineProvider } from "@/agent/providers/registry";
import { __setSlackCredentialProviderForTests } from "@/channels/slack/credentials";
import { __resetServerEnvForTests } from "@/lib/env";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

const ORIGINAL = { ...process.env };

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const slackSecret = "slack-signing-secret";

defineProvider({
  id: "openai",
  getModel: () =>
    new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "route answer" },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              logprobs: undefined,
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: 2,
                  text: 2,
                  reasoning: undefined,
                },
              },
            },
          ],
        }),
      }),
    }),
});

const signedSlackBody = (body: unknown) => {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", slackSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return { rawBody, timestamp, signature };
};

describe("channel route", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    process.env.API_CHANNEL_TOKENS = `tenant-a:${hash("secret-token")}`;
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL = "mock-model";
    __resetServerEnvForTests();
    __setSlackCredentialProviderForTests({
      async getAppCredentials(apiAppId) {
        return apiAppId === "A123" ? { signingSecret: slackSecret } : null;
      },
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
    __setSlackCredentialProviderForTests(undefined);
  });

  it("runs http channels synchronously and returns the channel response", async () => {
    const response = await POST(
      new Request("http://localhost/api/channels/api", {
        method: "POST",
        headers: { authorization: "Bearer secret-token" },
        body: JSON.stringify({ userId: "user-1", text: "hello", dedupKey: "req-1" }),
      }),
      { params: Promise.resolve({ channel: "api" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ text: "route answer" });
  });

  it("returns adapter ack responses before running the pipeline", async () => {
    const response = await POST(
      new Request("http://localhost/api/channels/api", {
        method: "POST",
        body: JSON.stringify({ userId: "user-1", text: "hello" }),
      }),
      { params: Promise.resolve({ channel: "api" }) },
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("unauthorized");
  });

  it("returns Slack url_verification challenges from the webhook route", async () => {
    const { rawBody, timestamp, signature } = signedSlackBody({
      type: "url_verification",
      api_app_id: "A123",
      team_id: "T123",
      challenge: "slack-challenge",
    });

    const response = await POST(
      new Request("http://localhost/api/channels/slack", {
        method: "POST",
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body: rawBody,
      }),
      { params: Promise.resolve({ channel: "slack" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("slack-challenge");
  });
});
