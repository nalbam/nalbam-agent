/**
 * Worker for `reaction_added` events.
 *
 * Currently handles `:x:` to delete a bot-authored reply, with two paths
 * to authorization: the reactor is either (a) the original asker on the
 * thread the bot replied in, or (b) listed in the effective
 * ALLOWED_USER_IDS for this app (per-app override > env CSV).
 *
 * Adding another reaction is a one-line dispatch table entry plus a new
 * `_handle*` function.
 *
 * Both `conversations.history` and `conversations.replies` calls go
 * through `withSlackRetry` so Slack `ratelimited` responses are absorbed
 * with exponential backoff.
 */
import type { WebClient } from "@slack/web-api";

import { getServerEnv } from "@/lib/env";
import { logger as defaultLogger, type Logger } from "@/lib/logger";
import { effectiveAllowlist } from "@/lib/slack/acl";
import { getSlackApp, touchSlackApp, type SlackAppRecord } from "@/lib/slack/app-metadata";
import { isDone, markDone, reserve } from "@/lib/slack/dedup";
import { sanitizeError } from "@/lib/slack/formatter";
import { withSlackRetry } from "@/lib/slack/with-retry";

export interface SlackReactionEvent {
  type?: string;
  reaction?: string;
  user?: string;
  item_user?: string;
  team?: string;
  event_ts?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
}

export interface HandleReactionInput {
  client: WebClient;
  apiAppId: string;
  event: SlackReactionEvent;
  logger?: Logger;
}

type ReactionHandler = (input: {
  client: WebClient;
  apiAppId: string;
  event: SlackReactionEvent;
  app: SlackAppRecord | null;
  logger: Logger;
}) => Promise<void>;

const handleXDelete: ReactionHandler = async ({ client, apiAppId, event, app, logger }) => {
  const env = getServerEnv();
  const channel = event.item?.channel;
  const messageTs = event.item?.ts;
  const reactor = event.user ?? "";
  const itemUser = event.item_user ?? "";

  if (!channel || !messageTs || !reactor) return;

  const botUserId = app?.botUserId ?? "";
  if (!botUserId) {
    logger.info("slack.reaction.no_bot_id", { apiAppId });
    return;
  }
  if (itemUser && itemUser !== botUserId) {
    logger.info("slack.reaction.skip_not_bot_message", {
      apiAppId,
      channel,
      ts: messageTs,
      itemUser,
    });
    return;
  }

  // Original-asker lookup: the bot replies in a thread, so its message is
  // either the thread root or a reply inside it. conversations.history with
  // `latest+inclusive+limit=1` returns the bot message; we read its
  // thread_ts (parent ts) and then conversations.replies(ts=parent_ts)
  // returns the parent first, whose `user` is the asker.
  let originalAsker = "";
  let parentTs = "";
  try {
    const hist = await withSlackRetry(
      () =>
        client.conversations.history({
          channel,
          latest: messageTs,
          inclusive: true,
          limit: 1,
        }),
      "conversations.history",
      { logger },
    );
    const msgs = (hist.messages ?? []) as Array<{ ts?: string; thread_ts?: string }>;
    if (msgs.length > 0) {
      const botMsg = msgs[0]!;
      parentTs = botMsg.thread_ts ?? botMsg.ts ?? "";
    }
  } catch (err) {
    logger.warn("slack.reaction.history_failed", {
      apiAppId,
      error: sanitizeError(err),
    });
  }
  if (parentTs && parentTs !== messageTs) {
    try {
      const replies = await withSlackRetry(
        () =>
          client.conversations.replies({
            channel,
            ts: parentTs,
            limit: 1,
          }),
        "conversations.replies",
        { logger },
      );
      const msgs = (replies.messages ?? []) as Array<{ user?: string }>;
      if (msgs.length > 0) {
        originalAsker = msgs[0]!.user ?? "";
      }
    } catch (err) {
      logger.warn("slack.reaction.replies_failed", {
        apiAppId,
        error: sanitizeError(err),
      });
    }
  }

  const effectiveUsers = effectiveAllowlist({
    appOverride: app?.allowedUserIds,
    envCsv: env.ALLOWED_USER_IDS,
  });
  const allowed = (originalAsker && reactor === originalAsker) || effectiveUsers.includes(reactor);
  if (!allowed) {
    logger.info("slack.reaction.unauthorized", {
      apiAppId,
      reactor,
      channel,
      ts: messageTs,
      originalAsker: originalAsker || "(lookup_failed)",
      parentTs: parentTs || "(none)",
    });
    return;
  }

  try {
    await client.chat.delete({ channel, ts: messageTs });
    logger.info("slack.reaction.deleted", {
      apiAppId,
      reactor,
      channel,
      ts: messageTs,
    });
  } catch (err) {
    logger.warn("slack.reaction.delete_failed", {
      apiAppId,
      error: sanitizeError(err),
    });
  }
};

const REACTION_HANDLERS: Record<string, ReactionHandler> = {
  x: handleXDelete,
};

export const isHandledReaction = (reaction: string | undefined): boolean =>
  typeof reaction === "string" && reaction in REACTION_HANDLERS;

export const handleReaction = async (input: HandleReactionInput): Promise<void> => {
  const { client, apiAppId, event } = input;
  const log = (input.logger ?? defaultLogger).child({
    component: "slack.reaction",
    reaction: event.reaction,
    channel: event.item?.channel,
    user: event.user,
  });
  if (event.item?.type !== "message") return;
  const reaction = event.reaction ?? "";
  const handler = REACTION_HANDLERS[reaction];
  if (!handler) return; // defense-in-depth — router pre-filters too

  const channel = event.item.channel;
  const messageTs = event.item.ts;
  const reactor = event.user ?? "";
  if (!channel || !messageTs || !reactor) return;

  // Per-event dedup. event_ts is unique per firing; fall back to
  // `${ts}:${reactor}` when absent so the key is still stable.
  const dedupKey = `reaction:${event.event_ts ?? messageTs}:${reactor}`;
  try {
    if (await isDone(apiAppId, dedupKey)) {
      log.info("slack.dedup.skip", { dedupKey, reason: "already_done" });
      return;
    }
    const reserved = await reserve(apiAppId, dedupKey, reactor || "system");
    if (!reserved) {
      log.info("slack.dedup.skip", { dedupKey, reason: "in_flight" });
      return;
    }
  } catch (err) {
    log.warn("slack.reaction.dedup_unavailable", {
      apiAppId,
      error: sanitizeError(err),
    });
  }

  // Read app metadata before touch so the handler sees botUserId without
  // a duplicate roundtrip when touch only updates lastSeenAt.
  let app: SlackAppRecord | null = null;
  try {
    app = await getSlackApp(apiAppId);
  } catch (err) {
    log.warn("slack.reaction.app_load_failed", { error: sanitizeError(err) });
  }
  // touchSlackApp only after dedup so retries don't bump lastSeenAt.
  try {
    const touched = await touchSlackApp(apiAppId, event.team);
    if (touched) app = touched;
  } catch (err) {
    log.warn("slack.reaction.touch_app_failed", { error: sanitizeError(err) });
  }

  await handler({ client, apiAppId, event, app, logger: log });
  await markDone(apiAppId, dedupKey, reactor || "system");
};
