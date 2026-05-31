import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineProvider } from "@/agent/providers/registry";
import { aiSdkAgentRuntime } from "@/agent/runtime";
import type { Responder } from "@/channels/types";
import type { InboundMessage } from "@/core/types";
import { __resetServerEnvForTests } from "@/lib/env";
import { logger } from "@/lib/logger";

const ORIGINAL = { ...process.env };

const model = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "hello" },
        { type: "text-delta", id: "text-1", delta: " world" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: undefined },
          logprobs: undefined,
          usage: {
            inputTokens: {
              total: 7,
              noCache: 7,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: 3,
              text: 3,
              reasoning: undefined,
            },
          },
        },
      ],
    }),
  }),
});

defineProvider({
  id: "openai",
  getModel: () => model,
});

const msg: InboundMessage = {
  channel: "api",
  tenantId: "tenant-a",
  conversationId: "c1",
  userId: "u1",
  text: "Say hello",
  attachments: [],
  mentions: [],
  surface: "direct",
  dedupKey: "k1",
  receivedAt: 0,
  raw: null,
};

describe("aiSdkAgentRuntime", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL, LLM_PROVIDER: "openai", LLM_MODEL: "mock-model" };
    __resetServerEnvForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
  });

  it("streams deltas to the responder and returns usage accounting", async () => {
    const appended: string[] = [];
    const responder: Responder = {
      append: async (chunk) => {
        appended.push(chunk.text);
      },
      finalize: async () => {},
    };

    const result = await aiSdkAgentRuntime.run({
      msg,
      tenant: { channel: "api", tenantId: "tenant-a", language: "en" },
      history: [{ author: "assistant", text: "Earlier answer", ts: "1" }],
      caps: {},
      rendering: "Plain text.",
      responder,
      log: logger,
    });

    expect(appended).toEqual(["hello", " world"]);
    expect(result).toMatchObject({
      text: "hello world",
      steps: 1,
      toolCallCount: 0,
      tokensIn: 7,
      tokensOut: 3,
      forcedCompose: false,
    });
    expect(model.doStreamCalls.at(-1)?.prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "user" }),
      ]),
    );
  });
});
