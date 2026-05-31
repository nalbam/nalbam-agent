/** LLM provider registry (architecture §5.3). */
import type { LanguageModel } from "ai";

import type { LlmProvider, ModelSpec } from "@/agent/providers/types";

const providers = new Map<string, LlmProvider>();

export const defineProvider = (provider: LlmProvider): LlmProvider => {
  providers.set(provider.id, provider);
  return provider;
};

export const getModel = (spec: ModelSpec): LanguageModel => {
  const provider = providers.get(spec.provider);
  if (!provider) throw new Error(`unknown LLM provider: ${spec.provider}`);
  return provider.getModel(spec);
};
