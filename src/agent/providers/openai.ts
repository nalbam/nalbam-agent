import { openai } from "@ai-sdk/openai";

import { defineProvider } from "@/agent/providers/registry";

export const openaiProvider = defineProvider({
  id: "openai",
  getModel: (spec) => openai(spec.model),
});
