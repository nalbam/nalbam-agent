import { createOpenAI } from "@ai-sdk/openai";

import { defineProvider } from "@/agent/providers/registry";
import type { LlmProvider } from "@/agent/providers/types";
import { getServerEnv, type ServerEnv } from "@/lib/env";

interface OpenAICompatibleConfig {
  id: "xai" | "gemini" | "claude";
  apiKey: (env: ServerEnv) => string | undefined;
  baseURL: (env: ServerEnv) => string | undefined;
}

const defineOpenAICompatibleProvider = (config: OpenAICompatibleConfig): LlmProvider =>
  defineProvider({
    id: config.id,
    getModel: (spec) => {
      const env = getServerEnv();
      const apiKey = config.apiKey(env);
      const baseURL = config.baseURL(env);
      if (!apiKey || !baseURL) {
        throw new Error(
          `${config.id} provider requires both ${config.id.toUpperCase()}_API_KEY and ${config.id.toUpperCase()}_BASE_URL.`,
        );
      }
      return createOpenAI({ name: config.id, apiKey, baseURL })(spec.model);
    },
  });

export const xaiProvider = defineOpenAICompatibleProvider({
  id: "xai",
  apiKey: (env) => env.XAI_API_KEY,
  baseURL: (env) => env.XAI_BASE_URL,
});

export const geminiProvider = defineOpenAICompatibleProvider({
  id: "gemini",
  apiKey: (env) => env.GEMINI_API_KEY,
  baseURL: (env) => env.GEMINI_BASE_URL,
});

export const claudeProvider = defineOpenAICompatibleProvider({
  id: "claude",
  apiKey: (env) => env.CLAUDE_API_KEY,
  baseURL: (env) => env.CLAUDE_BASE_URL,
});
