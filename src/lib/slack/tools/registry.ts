/**
 * Slack agent tool registry.
 *
 * Tools are Vercel AI SDK `tool({ description, inputSchema, execute })`
 * values, grouped into a dict keyed by tool name and passed straight to
 * `streamText({ tools })`.
 *
 * PR3 wires in time / web / search / Slack tools. Image generation tools
 * (generate_image / edit_image / attach_image_from_url) land in PR4.
 *
 * Each tool's `execute` reads shared per-request state (Slack client,
 * channel, thread, user, settings) via the `ToolContext` passed into the
 * registry factory. Keep tools pure-ish — they should depend only on
 * their inputs + ToolContext, not on module globals.
 */
import type { WebClient } from "@slack/web-api";
import type { Tool } from "ai";

import { getCurrentTimeTool } from "@/lib/slack/tools/time";
import { fetchWebpageTool } from "@/lib/slack/tools/web";
import { searchImagesTool, searchWebTool } from "@/lib/slack/tools/search";
import {
  fetchThreadHistoryTool,
  fetchUserProfileTool,
  readAttachedDocumentTool,
  readAttachedImagesTool,
} from "@/lib/slack/tools/slack-tools";
import { attachImageFromUrlTool, editImageTool, generateImageTool } from "@/lib/slack/tools/image";

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

export const buildToolRegistry = (context: ToolContext): ToolDict => {
  return {
    get_current_time: getCurrentTimeTool(),
    fetch_webpage: fetchWebpageTool(),
    search_web: searchWebTool(),
    search_images: searchImagesTool(),
    read_attached_images: readAttachedImagesTool(context),
    read_attached_document: readAttachedDocumentTool(context),
    fetch_user_profile: fetchUserProfileTool(context),
    fetch_thread_history: fetchThreadHistoryTool(context),
    generate_image: generateImageTool(context),
    attach_image_from_url: attachImageFromUrlTool(context),
    edit_image: editImageTool(context),
  };
};
