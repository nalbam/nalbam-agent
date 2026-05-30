/**
 * Vercel AI SDK agent loop wrapper.
 *
 * Wraps `streamText` so the route handler can drive a multi-step agent
 * with native function calling, content streaming to Slack, and uniform
 * usage / step accounting. `stopWhen: stepCountIs(N)` enforces the agent's
 * hop cap (`AGENT_MAX_STEPS`, default 6).
 *
 * Tools are passed in as a dict; when empty, we omit the `tools` arg
 * entirely so the LLM doesn't see a stale schema with no callbacks.
 *
 * Forced-compose: when `stepCountIs(N)` halts on a turn that only
 * produced tool-calls (no final text), we issue one extra `generateText`
 * call with the tool conversation history and an explicit "no more tools"
 * directive so the user actually gets an answer.
 */
import {
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type Tool,
} from "ai";

import { logger as defaultLogger, type Logger } from "@/lib/logger";
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
  logger?: Logger;
}

export interface AgentRunResult {
  text: string;
  steps: number;
  toolCallCount: number;
  tokensIn: number;
  tokensOut: number;
  /** True when forced-compose ran because the streamed turn ended on tool-calls. */
  forcedCompose: boolean;
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

const FORCE_COMPOSE_DIRECTIVE =
  "Provide the final answer now based on the tool results so far. Do not request any more tools.";

export const runAgent = async ({
  model,
  system,
  history,
  userMessage,
  tools,
  maxSteps,
  maxOutputTokens,
  onTextChunk,
  logger = defaultLogger,
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

  const finalText = (await result.text) || accumulated;
  const usage = await result.usage;
  const steps = await result.steps;
  const finishReason = await result.finishReason;

  let composedText = "";
  let composeIn = 0;
  let composeOut = 0;
  let forcedCompose = false;

  // The stream halted on `tool-calls` without producing user-facing text.
  // Common cause: `stepCountIs(N)` ran out while the model was still in a
  // tool-call turn. Surface a real answer by running one tool-less follow-up
  // with the accumulated tool conversation in context.
  if (!finalText.trim() && finishReason === "tool-calls") {
    forcedCompose = true;
    const response = await result.response;
    const responseMessages = Array.isArray(response.messages) ? response.messages : [];
    try {
      const composed = await generateText({
        model,
        system,
        messages: [
          ...messages,
          ...responseMessages,
          { role: "user", content: FORCE_COMPOSE_DIRECTIVE },
        ],
        maxOutputTokens,
      });
      composedText = composed.text;
      composeIn = composed.usage.inputTokens ?? 0;
      composeOut = composed.usage.outputTokens ?? 0;
      if (composedText) {
        try {
          await onTextChunk(composedText);
        } catch (err) {
          logger.warn("slack.agent.on_chunk_failed", { error: sanitizeError(err) });
        }
      }
      logger.info("slack.agent.forced_compose", {
        chars: composedText.length,
        tokensIn: composeIn,
        tokensOut: composeOut,
      });
    } catch (err) {
      logger.warn("slack.agent.forced_compose_failed", { error: sanitizeError(err) });
    }
  }

  return {
    text: finalText.trim() || composedText,
    steps: steps.length + (forcedCompose ? 1 : 0),
    toolCallCount,
    tokensIn: (usage.inputTokens ?? 0) + composeIn,
    tokensOut: (usage.outputTokens ?? 0) + composeOut,
    forcedCompose,
  };
};
