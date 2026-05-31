import { afterEach, beforeEach, describe, expect, it } from "vitest";

import "@/agent/providers/openai-compatible";
import { getModel } from "@/agent/providers/registry";
import { __resetServerEnvForTests } from "@/lib/env";

const ORIGINAL = { ...process.env };

describe("OpenAI-compatible providers", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
  });

  it("registers xai, gemini, and claude provider ids", () => {
    process.env.XAI_API_KEY = "xai-key";
    process.env.XAI_BASE_URL = "https://example.com/xai";
    process.env.GEMINI_API_KEY = "gemini-key";
    process.env.GEMINI_BASE_URL = "https://example.com/gemini";
    process.env.CLAUDE_API_KEY = "claude-key";
    process.env.CLAUDE_BASE_URL = "https://example.com/claude";
    __resetServerEnvForTests();

    expect(getModel({ provider: "xai", model: "grok-model" })).toBeDefined();
    expect(getModel({ provider: "gemini", model: "gemini-model" })).toBeDefined();
    expect(getModel({ provider: "claude", model: "claude-model" })).toBeDefined();
  });

  it("fails fast when provider credentials are incomplete", () => {
    process.env.XAI_API_KEY = "xai-key";
    delete process.env.XAI_BASE_URL;
    __resetServerEnvForTests();

    expect(() => getModel({ provider: "xai", model: "grok-model" })).toThrow(
      /XAI_API_KEY and XAI_BASE_URL/,
    );
  });
});
