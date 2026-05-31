import { bedrock } from "@ai-sdk/amazon-bedrock";

import { defineProvider } from "@/agent/providers/registry";

export const bedrockProvider = defineProvider({
  id: "bedrock",
  getModel: (spec) => bedrock(spec.model),
});
