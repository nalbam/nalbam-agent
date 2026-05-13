/**
 * Slack event payload router.
 *
 * Receives a parsed Slack `event_callback` body and dispatches to the
 * appropriate handler. Handlers are designed to run from within the
 * route's `after()` callback (after the HTTP 200 ack has been returned),
 * so they must never throw outward — they swallow errors via structured
 * logging and stream a user-visible notice when possible.
 *
 * Supported event types:
 *   - `app_mention`               → handlers/message (channel mention)
 *   - `message` (`im` only)       → handlers/message (DM)
 *   - `reaction_added` (filtered) → handlers/reactions (e.g. :x: delete)
 *
 * Unhandled reactions are dropped at the router so they don't enter the
 * dedup table.
 */
import type { WebClient } from "@slack/web-api";

import { logger as defaultLogger, type Logger } from "@/lib/logger";
import { sanitizeError } from "@/lib/slack/formatter";
import { handleMessage, type SlackMessageEvent } from "@/lib/slack/handlers/message";
import {
  handleReaction,
  isHandledReaction,
  type SlackReactionEvent,
} from "@/lib/slack/handlers/reactions";

export interface SlackEventCallback {
  type?: string;
  api_app_id?: string;
  team_id?: string;
  event?: (SlackMessageEvent & { type?: string }) | (SlackReactionEvent & { type?: string });
  challenge?: string;
}

export interface DispatchInput {
  client: WebClient;
  apiAppId: string;
  payload: SlackEventCallback;
  logger?: Logger;
}

const isReactionEvent = (
  e: NonNullable<SlackEventCallback["event"]>,
): e is SlackReactionEvent & { type: "reaction_added" } => e.type === "reaction_added";

const isMessageLikeEvent = (
  e: NonNullable<SlackEventCallback["event"]>,
): e is SlackMessageEvent & { type: string } => e.type === "app_mention" || e.type === "message";

export const dispatchEvent = async (input: DispatchInput): Promise<void> => {
  const { client, apiAppId, payload } = input;
  const log = input.logger ?? defaultLogger;
  const event = payload.event;
  if (!event || !event.type) {
    log.info("slack.router.no_event", { apiAppId });
    return;
  }
  try {
    if (isReactionEvent(event)) {
      if (!isHandledReaction(event.reaction)) return;
      if (event.item?.type !== "message") return;
      await handleReaction({ client, apiAppId, event, logger: log });
      return;
    }
    if (isMessageLikeEvent(event)) {
      if (event.type === "app_mention") {
        await handleMessage({ client, apiAppId, isDm: false, event, logger: log });
        return;
      }
      if (event.type === "message") {
        // Only direct messages — ignore in-channel `message.channels` to avoid
        // duplicating `app_mention` and to skip threaded chatter the bot wasn't
        // addressed in.
        if (event.channel_type !== "im") return;
        // Drop bot-authored messages and message subtypes (joins, edits, etc.).
        if (event.bot_id || event.subtype) return;
        await handleMessage({ client, apiAppId, isDm: true, event, logger: log });
        return;
      }
    }
    log.info("slack.router.unhandled", { apiAppId, eventType: event.type });
  } catch (err) {
    // Handlers manage their own user-visible errors; this catches anything
    // that escapes (defense in depth, since we run inside after()).
    log.error("slack.router.unhandled_error", {
      apiAppId,
      eventType: event.type,
      error: sanitizeError(err),
    });
  }
};
