/**
 * Slack agent tool registry.
 *
 * Tools are Vercel AI SDK `tool({ description, inputSchema, execute })`
 * values, grouped into a dict keyed by tool name and passed straight to
 * `streamText({ tools })`.
 *
 * PR2 ships an empty registry — the agent loop runs without tool calls so
 * we can validate the receiver/streamText/after() end-to-end path. PR3
 * fills this in with Slack/web/image tools (memory excluded by design).
 *
 * Each tool's `execute` reads shared per-request state (Slack client,
 * channel, thread, user, settings) via the `ToolContext` passed into the
 * registry factory. Keep tools pure-ish — they should depend only on
 * their inputs + ToolContext, not on module globals.
 */
import type { WebClient } from "@slack/web-api";
import type { Tool } from "ai";

export interface SlackToolEvent {
  channel?: string;
  thread_ts?: string;
  ts?: string;
  user?: string;
  text?: string;
  files?: unknown[];
}

export interface ToolContext {
  client: WebClient;
  channel: string | undefined;
  threadTs: string | undefined;
  user: string | undefined;
  apiAppId: string;
  event: SlackToolEvent;
}

export type ToolDict = Record<string, Tool>;

/**
 * Build the tool dict for an agent run. PR2 returns an empty dict so the
 * agent can iterate purely on the LLM (no function calling). PR3 expands
 * this with Slack/web/image/time tools.
 */
export const buildToolRegistry = (context: ToolContext): ToolDict => {
  // PR3 will close over `context` to build tools that read from Slack /
  // call the WebClient / etc. Touching the parameter here avoids an
  // unused-arg warning while keeping the signature stable for PR3.
  void context;
  return {};
};
