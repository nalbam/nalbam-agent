/**
 * Agent runtime (architecture §5.3).
 *
 * Drives a multi-step tool loop over the LLM and streams content to the
 * channel via `Responder`. The concrete implementation (streamText +
 * stepCountIs + forced-compose) lands in a later step; the stub returns an
 * empty result so the pipeline type-checks end to end.
 */
import type { MediaRef, HistoryEntry, InboundMessage } from "@/core/types";
import type { TenantConfig } from "@/core/tenant";
import type { Capabilities, Responder } from "@/channels/types";
import type { Logger } from "@/lib/logger";

export interface AgentRunInput {
  msg: InboundMessage;
  tenant: TenantConfig | null;
  history: HistoryEntry[];
  caps: Capabilities;
  /** Channel rendering rules injected into the system prompt. */
  rendering: string;
  responder: Responder;
  log: Logger;
}

export interface AgentRunResult {
  text: string;
  media?: MediaRef[];
  steps: number;
  toolCallCount: number;
  tokensIn: number;
  tokensOut: number;
  forcedCompose: boolean;
}

export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

const EMPTY_RESULT: AgentRunResult = {
  text: "",
  steps: 0,
  toolCallCount: 0,
  tokensIn: 0,
  tokensOut: 0,
  forcedCompose: false,
};

/** Skeleton stub — replace with the streamText tool loop. */
export const stubAgentRuntime: AgentRuntime = {
  async run(): Promise<AgentRunResult> {
    return EMPTY_RESULT;
  },
};
