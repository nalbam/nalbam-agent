/**
 * Slack event payload router.
 *
 * Receives a parsed Slack `event_callback` body and dispatches to the
 * appropriate handler. Handlers are designed to run from within the
 * route's `after()` callback (after the HTTP 200 ack has been returned),
 * so they must never throw outward — they swallow errors via structured
 * logging and stream a user-visible notice when possible.
 *
 * Supported event types in PR2:
 *   - `app_mention`          → handlers/message (channel mention)
 *   - `message` (`im` only)  → handlers/message (DM)
 *
 * PR3+ will add `reaction_added` for the `:x:` delete handler.
 */
import type { WebClient } from "@slack/web-api";

import { logger } from "@/lib/logger";
import { sanitizeError } from "@/lib/slack/formatter";
import { handleMessage, type SlackMessageEvent } from "@/lib/slack/handlers/message";

export interface SlackEventCallback {
  type?: string;
  api_app_id?: string;
  team_id?: string;
  event?: SlackMessageEvent & { type?: string };
  challenge?: string;
}

export interface DispatchInput {
  client: WebClient;
  apiAppId: string;
  payload: SlackEventCallback;
}

export const dispatchEvent = async (input: DispatchInput): Promise<void> => {
  const { client, apiAppId, payload } = input;
  const event = payload.event;
  if (!event || !event.type) {
    logger.info("slack.router.no_event", { apiAppId });
    return;
  }
  try {
    if (event.type === "app_mention") {
      await handleMessage({ client, apiAppId, isDm: false, event });
      return;
    }
    if (event.type === "message") {
      // Only direct messages — ignore in-channel `message.channels` to avoid
      // duplicating `app_mention` and to skip threaded chatter the bot wasn't
      // addressed in.
      if (event.channel_type !== "im") return;
      // Drop bot-authored messages and message subtypes (joins, edits, etc.).
      if (event.bot_id || event.subtype) return;
      await handleMessage({ client, apiAppId, isDm: true, event });
      return;
    }
    logger.info("slack.router.unhandled", { apiAppId, eventType: event.type });
  } catch (err) {
    // handleMessage already handles its own errors; this catches anything
    // that escapes (defense in depth, since we run inside after()).
    logger.error("slack.router.unhandled_error", {
      apiAppId,
      eventType: event.type,
      error: sanitizeError(err),
    });
  }
};
