/**
 * Vercel AI SDK provider factory.
 *
 * Maps `LLM_PROVIDER` / `IMAGE_PROVIDER` env to the corresponding ai-sdk
 * provider instance. Adding a new provider:
 *   1. install `@ai-sdk/<name>`
 *   2. add the enum value to `env.ts` (LLM_PROVIDER / IMAGE_PROVIDER zod schema)
 *   3. branch here.
 *
 * The provider modules use the AWS / OpenAI credential chains by default
 * (env vars / IAM compute role on Amplify), so we don't pass keys explicitly.
 */
import type { LanguageModel } from "ai";

import { bedrock } from "@ai-sdk/amazon-bedrock";
import { openai } from "@ai-sdk/openai";

import { getServerEnv } from "@/lib/env";

export type SupportedProvider = "openai" | "bedrock";

export interface ModelInput {
  provider: SupportedProvider;
  model: string;
}

export const getModel = ({ provider, model }: ModelInput): LanguageModel => {
  switch (provider) {
    case "openai":
      return openai(model);
    case "bedrock":
      return bedrock(model);
    default: {
      const _exhaustive: never = provider;
      throw new Error(`unsupported LLM provider: ${String(_exhaustive)}`);
    }
  }
};

/** Convenience: read text-model from env. Server-only. */
export const getTextModelFromEnv = (): LanguageModel => {
  const env = getServerEnv();
  return getModel({ provider: env.LLM_PROVIDER, model: env.LLM_MODEL });
};
