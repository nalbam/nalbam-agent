/**
 * Worker for `app_mention` + `message.im` (DM) events.
 *
 * Sequence:
 *   1. Strip the bot's own mention (other `<@U…>` mentions stay so the LLM
 *      can pass them to `fetch_user_profile`).
 *   2. Bail on empty text (bare @bot pings).
 *   3. Dedup: `is_done` first (long-TTL), then `reserve` (short-TTL).
 *   4. Touch app metadata + apply per-app ACL/persona override.
 *   5. Pre-warm display names for every non-bot user mention.
 *   6. Load conversation history, build system prompt + tools, run agent.
 *   7. Stream content into a single Slack message.
 *   8. Save updated history + mark dedup done.
 *
 * This is the route handler's `after()` callback target — it must not
 * throw outward; surface errors via streaming or a follow-up postMessage
 * and return cleanly.
 */
import type { WebClient } from "@slack/web-api";

import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  effectivePersona,
  evaluateChannelAcl,
  evaluateUserAcl,
  renderChannelDenyMessage,
} from "@/lib/slack/acl";
import { runAgent } from "@/lib/slack/agent";
import {
  touchSlackApp,
  type SlackAppRecord,
} from "@/lib/slack/app-metadata";
import { loadThreadHistory, saveThreadHistory } from "@/lib/slack/conversation";
import { isDone, markDone, reserve } from "@/lib/slack/dedup";
import { sanitizeError, splitMessage } from "@/lib/slack/formatter";
import { StreamingMessage } from "@/lib/slack/stream";
import { buildSystemPrompt } from "@/lib/slack/system-prompt";
import { buildToolRegistry } from "@/lib/slack/tools/registry";
import { warmUserNames } from "@/lib/slack/user-name-cache";
import { getTextModelFromEnv } from "@/lib/llm/factory";

const ERROR_PREFIX: Record<"ko" | "en", string> = {
  ko: "요청 처리 중 오류가 발생했습니다",
  en: "An error occurred while processing your request",
};

const FALLBACK_TEXT: Record<"ko" | "en", string> = {
  ko: "(응답을 생성하지 못했습니다)",
  en: "(no response generated)",
};

const USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const stripBotMention = (text: string, botUserId: string | undefined): string => {
  if (!text || !botUserId) return text;
  const pattern = new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]*)?>`, "g");
  return text.replace(pattern, "").trim();
};

export interface SlackMessageEvent {
  type?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  text?: string;
  client_msg_id?: string;
  team?: string;
  bot_id?: string;
  subtype?: string;
  files?: unknown[];
}

export interface HandleMessageInput {
  client: WebClient;
  apiAppId: string;
  isDm: boolean;
  event: SlackMessageEvent;
}

export const handleMessage = async (input: HandleMessageInput): Promise<void> => {
  const { client, apiAppId, isDm, event } = input;
  const env = getServerEnv();
  const lang = env.RESPONSE_LANGUAGE;
  const channel = event.channel ?? "";
  const threadTs = event.thread_ts || event.ts;
  const user = event.user ?? "";

  // We don't know bot_user_id here unless app metadata has it. Touch app
  // metadata first; the record carries botUserId if the operator registered
  // it via the UI. Without it we just don't strip the bot mention — the
  // model still understands `<@BOT> question` as a question.
  let appRow: SlackAppRecord | null = null;
  try {
    appRow = await touchSlackApp(apiAppId, event.team);
  } catch (err) {
    logger.warn("slack.message.touch_app_failed", {
      apiAppId,
      error: sanitizeError(err),
    });
  }

  const botUserId = appRow?.botUserId;
  const rawText = event.text ?? "";
  const text = stripBotMention(rawText, botUserId).trim();

  // Bare @bot ping with no prompt → no work; skip BEFORE reserving a dedup
  // slot so empty pings don't litter the table or block legitimate retries.
  if (!text) return;

  const dedupKey = event.client_msg_id || `${channel}:${event.ts ?? ""}`;

  // Two-stage dedup: `done:` (long TTL) absorbs slow retries past the
  // in-flight window; `reserve:` (short TTL) blocks parallel duplicates.
  try {
    if (await isDone(apiAppId, dedupKey)) {
      logger.info("slack.dedup.skip", {
        apiAppId,
        dedupKey,
        reason: "already_done",
      });
      return;
    }
    const reserved = await reserve(apiAppId, dedupKey, user || "system");
    if (!reserved) {
      logger.info("slack.dedup.skip", {
        apiAppId,
        dedupKey,
        reason: "in_flight",
      });
      return;
    }
  } catch (err) {
    logger.warn("slack.dedup.unavailable", { error: sanitizeError(err) });
    // Proceed without dedup — better to maybe-double-process than to silently
    // drop on a transient DDB outage.
  }

  // ACL: channel allowlist applies only outside DMs. User allowlist applies
  // to both surfaces (silent drop, no user-visible deny).
  const channelAcl = evaluateChannelAcl({
    channel,
    isDm,
    app: appRow,
    envCsv: env.ALLOWED_CHANNEL_IDS,
  });
  if (!channelAcl.allowed) {
    const msg = renderChannelDenyMessage(
      env.ALLOWED_CHANNEL_MESSAGE,
      channelAcl.firstAllowedChannel,
    );
    if (msg) {
      try {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: msg });
      } catch (err) {
        logger.warn("slack.message.deny_post_failed", { error: sanitizeError(err) });
      }
    }
    logger.info("slack.channel.blocked", { apiAppId, channel });
    return;
  }
  const userAcl = evaluateUserAcl({ user, app: appRow, envCsv: env.ALLOWED_USER_IDS });
  if (!userAcl.allowed) {
    // Silent drop — surfacing the bot to outsiders has no upside.
    logger.info("slack.user.blocked", { apiAppId, user, channel });
    return;
  }

  // Pre-warm display names for every non-bot user mention so any tool /
  // rendering path that hits the cache resolves on the first attempt.
  const mentionedIds = new Set<string>();
  let match: RegExpExecArray | null;
  USER_MENTION_RE.lastIndex = 0;
  while ((match = USER_MENTION_RE.exec(rawText)) !== null) {
    const id = match[1];
    if (id && id !== botUserId) mentionedIds.add(id);
  }
  if (mentionedIds.size > 0) {
    try {
      await warmUserNames(client, mentionedIds);
    } catch (err) {
      logger.debug("slack.mention_warm_failed", { error: sanitizeError(err) });
    }
  }

  const history = threadTs ? await loadThreadHistory(apiAppId, threadTs) : [];
  const persona = effectivePersona(appRow, env.PERSONA_MESSAGE);
  const system = buildSystemPrompt({
    systemMessage: env.SYSTEM_MESSAGE,
    personaMessage: persona,
    responseLanguage: lang,
  });

  const streamMsg = new StreamingMessage({
    client,
    channel,
    threadTs: threadTs ?? "",
    placeholder: env.BOT_CURSOR,
    maxLen: env.MAX_LEN_SLACK,
  });

  const tools = buildToolRegistry({
    client,
    channel,
    threadTs,
    user,
    apiAppId,
    event,
  });

  logger.info("slack.agent.start", { apiAppId, user, channel, isDm });

  let agentResult;
  try {
    agentResult = await runAgent({
      model: getTextModelFromEnv(),
      system,
      history,
      userMessage: text,
      tools,
      maxSteps: env.AGENT_MAX_STEPS,
      maxOutputTokens: env.MAX_OUTPUT_TOKENS,
      onTextChunk: (delta) => streamMsg.append(delta),
    });
  } catch (err) {
    const errorText = `${ERROR_PREFIX[lang]}: ${sanitizeError(err)}`;
    logger.warn("slack.agent.failure", {
      apiAppId,
      error: sanitizeError(err),
      errorClass: err instanceof Error ? err.constructor.name : "unknown",
    });
    try {
      if (streamMsg.hasStarted()) {
        await streamMsg.stop(errorText);
      } else {
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: errorText,
        });
      }
    } catch (postErr) {
      logger.warn("slack.error_notify_failed", { error: sanitizeError(postErr) });
    }
    return;
  }

  const finalText = agentResult.text.trim() || FALLBACK_TEXT[lang];

  if (streamMsg.hasStarted()) {
    await streamMsg.stop(finalText);
  } else {
    // No deltas streamed (rare: model produced everything as tool-call payloads
    // without text). Post chunks fresh.
    const chunks = splitMessage(finalText, env.MAX_LEN_SLACK);
    for (const chunk of chunks) {
      try {
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: chunk });
      } catch (err) {
        logger.warn("slack.message.final_post_failed", { error: sanitizeError(err) });
      }
    }
  }

  // Save history. The newest two messages were the user turn + the assistant
  // turn we just produced.
  if (threadTs) {
    const newHistory = [
      ...history,
      { role: "user" as const, content: text },
      { role: "assistant" as const, content: finalText },
    ];
    await saveThreadHistory(apiAppId, threadTs, newHistory, {
      maxChars: env.MAX_HISTORY_CHARS,
    });
  }

  await markDone(apiAppId, dedupKey, user || "system");

  logger.info("slack.agent.done", {
    apiAppId,
    steps: agentResult.steps,
    toolCalls: agentResult.toolCallCount,
    tokensIn: agentResult.tokensIn,
    tokensOut: agentResult.tokensOut,
  });
};
