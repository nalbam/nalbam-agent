/** LLM provider plugin (architecture §5.3). */
import type { LanguageModel } from "ai";

export interface ModelSpec {
  provider: string;
  model: string;
}

export interface LlmProvider {
  readonly id: string;
  getModel(spec: ModelSpec): LanguageModel;
}
