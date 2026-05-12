/**
 * Vercel AI SDK agent loop wrapper.
 *
 * Wraps `streamText` so the route handler can drive a multi-step agent
 * with native function calling, content streaming to Slack, and uniform
 * usage / step accounting. `stopWhen: stepCountIs(N)` enforces the same
 * 6-hop cap the original lambda-gurumi-bot used.
 *
 * Tools are passed in as a dict; when empty, we omit the `tools` arg
 * entirely so the LLM doesn't see a stale schema with no callbacks.
 */
import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type Tool } from "ai";

import { logger } from "@/lib/logger";
import { sanitizeError } from "@/lib/slack/formatter";
import type { ThreadMessage } from "@/lib/slack/conversation";

export interface AgentRunInput {
  model: LanguageModel;
  system: string;
  history: ThreadMessage[];
  userMessage: string;
  tools: Record<string, Tool>;
  maxSteps: number;
  maxOutputTokens: number;
  /** Streaming delta callback — called once per content chunk. */
  onTextChunk: (delta: string) => Promise<void> | void;
}

export interface AgentRunResult {
  text: string;
  steps: number;
  toolCallCount: number;
  tokensIn: number;
  tokensOut: number;
}

const toModelMessages = (history: ThreadMessage[], userMessage: string): ModelMessage[] => {
  const out: ModelMessage[] = [];
  for (const h of history) {
    if (h.role === "user" || h.role === "assistant" || h.role === "system") {
      out.push({ role: h.role, content: h.content });
    }
    // Tool messages from past turns are dropped — a fresh agent run will
    // re-run any tools it needs based on the current user message.
  }
  out.push({ role: "user", content: userMessage });
  return out;
};

export const runAgent = async ({
  model,
  system,
  history,
  userMessage,
  tools,
  maxSteps,
  maxOutputTokens,
  onTextChunk,
}: AgentRunInput): Promise<AgentRunResult> => {
  const messages = toModelMessages(history, userMessage);
  let toolCallCount = 0;

  const result = streamText({
    model,
    system,
    messages,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens,
    onStepFinish: ({ toolCalls }) => {
      if (toolCalls && Array.isArray(toolCalls)) {
        toolCallCount += toolCalls.length;
      }
    },
  });

  let accumulated = "";
  for await (const delta of result.textStream) {
    accumulated += delta;
    try {
      await onTextChunk(delta);
    } catch (err) {
      logger.warn("slack.agent.on_chunk_failed", { error: sanitizeError(err) });
    }
  }

  // `result.text` resolves to the final text the model produced (which is
  // the same content we streamed). Falling through to `accumulated` keeps
  // the function honest if the provider streamed nothing.
  const finalText = (await result.text) || accumulated;
  const usage = await result.usage;
  const steps = await result.steps;

  return {
    text: finalText,
    steps: steps.length,
    toolCallCount,
    tokensIn: usage.inputTokens ?? 0,
    tokensOut: usage.outputTokens ?? 0,
  };
};
