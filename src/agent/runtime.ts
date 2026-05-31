import { stepCountIs, streamText, type ModelMessage } from "ai";

import { getModel } from "@/agent/providers/registry";
import { buildSystemPrompt } from "@/agent/system-prompt";
import { buildToolset } from "@/agent/tools/registry";
import type { Capabilities, Responder } from "@/channels/types";
import type { TenantConfig } from "@/core/tenant";
import type { MediaRef, HistoryEntry, InboundMessage } from "@/core/types";
import { getServerEnv } from "@/lib/env";
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

const historyToMessages = (history: HistoryEntry[]): ModelMessage[] =>
  history.map((entry) => ({
    role: entry.author === "assistant" ? "assistant" : "user",
    content: entry.text,
  }));

const buildMessages = (input: AgentRunInput): ModelMessage[] => [
  ...historyToMessages(input.history),
  { role: "user", content: input.msg.text },
];

export const aiSdkAgentRuntime: AgentRuntime = {
  async run(input): Promise<AgentRunResult> {
    const env = getServerEnv();
    const tools = buildToolset({
      msg: input.msg,
      caps: input.caps,
      tenant: input.tenant,
      log: input.log,
    });

    const result = streamText({
      model: getModel({ provider: env.LLM_PROVIDER, model: env.LLM_MODEL }),
      system: buildSystemPrompt({
        rendering: input.rendering,
        systemMessage: env.SYSTEM_MESSAGE,
        persona: input.tenant?.persona ?? env.PERSONA_MESSAGE,
        language: input.tenant?.language ?? env.RESPONSE_LANGUAGE,
      }),
      messages: buildMessages(input),
      tools,
      stopWhen: stepCountIs(env.AGENT_MAX_STEPS),
      maxOutputTokens: env.MAX_OUTPUT_TOKENS,
      experimental_telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
    });

    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
      await input.responder.append({ kind: "delta", text: delta });
    }

    const [steps, totalUsage, toolCalls] = await Promise.all([
      result.steps,
      result.totalUsage,
      result.toolCalls,
    ]);

    return {
      text,
      steps: steps.length,
      toolCallCount: toolCalls.length,
      tokensIn: totalUsage.inputTokens ?? 0,
      tokensOut: totalUsage.outputTokens ?? 0,
      forcedCompose: false,
    };
  },
};
