/**
 * Worker for `app_mention` + `message.im` (DM) events.
 *
 * Sequence:
 *   1. Read app metadata (no write).
 *   2. Strip the bot's own mention; bail on empty text BEFORE writing dedup.
 *   3. Dedup: `is_done` first (long-TTL), then `reserve` (short-TTL).
 *   4. Touch app metadata (`lastSeenAt`) — only after dedup so retries don't
 *      bump the heartbeat.
 *   5. ACL (channel + user) checks.
 *   6. Pre-warm display names for every non-bot user mention.
 *   7. Load thread history (with OCC version) → build system prompt + tools
 *      → run agent.
 *   8. Stream content into a single Slack message.
 *   9. Save updated history (OCC-guarded) + mark dedup done.
 *
 * This is the route handler's `after()` callback target — it must not
 * throw outward; surface errors via streaming or a follow-up postMessage
 * and return cleanly.
 */
import type { WebClient } from "@slack/web-api";

import { getServerEnv } from "@/lib/env";
import { logger as defaultLogger, type Logger } from "@/lib/logger";
import {
  effectivePersona,
  evaluateChannelAcl,
  evaluateUserAcl,
  renderChannelDenyMessage,
} from "@/lib/slack/acl";
import { runAgent } from "@/lib/slack/agent";
import {
  getSlackApp,
  touchSlackApp,
  type SlackAppRecord,
} from "@/lib/slack/app-metadata";
import { checkAndIncrementThrottle } from "@/lib/slack/throttle";
import { loadThreadHistory, saveThreadHistory } from "@/lib/slack/conversation";
import { isDone, markDone, reserve } from "@/lib/slack/dedup";
import { sanitizeError, splitMessage } from "@/lib/slack/formatter";
import { setThreadStatus } from "@/lib/slack/status";
import { StreamingMessage } from "@/lib/slack/stream";
import { buildSystemPrompt } from "@/lib/slack/system-prompt";
import { buildToolRegistry } from "@/lib/slack/tools/registry";
import { getUserName, warmUserNames } from "@/lib/slack/user-name-cache";
import { getTextModelFromEnv } from "@/lib/llm/factory";

const ERROR_PREFIX: Record<"ko" | "en", string> = {
  ko: "요청 처리 중 오류가 발생했습니다",
  en: "An error occurred while processing your request",
};

const FALLBACK_TEXT: Record<"ko" | "en", string> = {
  ko: "(응답을 생성하지 못했습니다)",
  en: "(no response generated)",
};

const THROTTLED_TEXT: Record<"ko" | "en", string> = {
  ko: "잠시 후 다시 시도해주세요. 처리 중인 요청이 많습니다.",
  en: "Too many in-flight requests. Please try again shortly.",
};

const THINKING_STATUS: Record<"ko" | "en", string> = {
  ko: "생각 중...",
  en: "Thinking...",
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
  logger?: Logger;
}

export const handleMessage = async (input: HandleMessageInput): Promise<void> => {
  const { client, apiAppId, isDm, event } = input;
  const env = getServerEnv();
  const lang = env.RESPONSE_LANGUAGE;
  const channel = event.channel ?? "";
  const threadTs = event.thread_ts || event.ts;
  const user = event.user ?? "";
  const log = (input.logger ?? defaultLogger).child({
    component: "slack.message",
    channel: channel || undefined,
    user: user || undefined,
    threadTs: threadTs || undefined,
  });

  // Read-only metadata load up-front so we know botUserId before mention-strip.
  // The write (lastSeenAt) is deferred until dedup passes, so retries don't
  // bump the heartbeat.
  let appRow: SlackAppRecord | null = null;
  try {
    appRow = await getSlackApp(apiAppId);
  } catch (err) {
    log.warn("slack.message.app_load_failed", { error: sanitizeError(err) });
  }

  const botUserId = appRow?.botUserId;
  const rawText = event.text ?? "";
  const text = stripBotMention(rawText, botUserId).trim();

  // Bare @bot ping with no prompt → no work; skip BEFORE reserving a dedup
  // slot so empty pings don't litter the table or block legitimate retries.
  if (!text) return;

  const dedupKey = event.client_msg_id || `${channel}:${event.ts ?? ""}`;
  const dedupLog = log.child({ dedupKey });

  // Two-stage dedup: `done:` (long TTL) absorbs slow retries past the
  // in-flight window; `reserve:` (short TTL) blocks parallel duplicates.
  try {
    if (await isDone(apiAppId, dedupKey)) {
      dedupLog.info("slack.dedup.skip", { reason: "already_done" });
      return;
    }
    const reserved = await reserve(apiAppId, dedupKey, user || "system");
    if (!reserved) {
      dedupLog.info("slack.dedup.skip", { reason: "in_flight" });
      return;
    }
  } catch (err) {
    log.warn("slack.dedup.unavailable", { error: sanitizeError(err) });
    // Proceed without dedup — better to maybe-double-process than to silently
    // drop on a transient DDB outage.
  }

  // Touch app metadata AFTER dedup so retries/duplicates don't move lastSeenAt.
  // The read above already gave us identity fields; merge in case touch returns
  // a fresher row (e.g. team_id was just observed).
  try {
    const touched = await touchSlackApp(apiAppId, event.team);
    if (touched) appRow = touched;
  } catch (err) {
    log.warn("slack.message.touch_app_failed", { error: sanitizeError(err) });
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
        log.warn("slack.message.deny_post_failed", { error: sanitizeError(err) });
      }
    }
    log.info("slack.channel.blocked", { apiAppId });
    return;
  }
  const userAcl = evaluateUserAcl({ user, app: appRow, envCsv: env.ALLOWED_USER_IDS });
  if (!userAcl.allowed) {
    // Silent drop — surfacing the bot to outsiders has no upside.
    log.info("slack.user.blocked", { apiAppId });
    return;
  }

  // Throttle: per-user concurrent active requests. Best-effort — counter
  // backend may be unavailable in dev. `checkAndIncrementThrottle` returns
  // `{ allowed, release }`; the release fires regardless of agent outcome.
  const throttle = await checkAndIncrementThrottle({
    user,
    max: env.MAX_THROTTLE_COUNT,
    logger: log,
  });
  if (!throttle.allowed) {
    try {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: THROTTLED_TEXT[lang],
      });
    } catch (err) {
      log.warn("slack.message.throttle_post_failed", { error: sanitizeError(err) });
    }
    log.info("slack.throttle.limit", { apiAppId });
    return;
  }

  try {
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
        log.debug("slack.mention_warm_failed", { error: sanitizeError(err) });
      }
    }

    const loaded = threadTs
      ? await loadThreadHistory(apiAppId, threadTs, log)
      : { messages: [], version: 0 };
    const history = loaded.messages;
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

    // Show Slack's native typing-style indicator while the agent is "working"
    // with nothing to reply yet. The lazy placeholder posts on the first text
    // chunk — until then this is the only signal the user has. Best-effort:
    // workspaces without the assistant API just see this no-op.
    if (threadTs) {
      await setThreadStatus(client, channel, threadTs, `${THINKING_STATUS[lang]} ${env.BOT_CURSOR}`, log);
    }

    const userDisplay = user
      ? await getUserName(client, user).catch(() => user)
      : "";
    log.info("slack.agent.start", { apiAppId, isDm, user: userDisplay || user });

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
        logger: log,
      });
    } catch (err) {
      const errorText = `${ERROR_PREFIX[lang]}: ${sanitizeError(err)}`;
      log.warn("slack.agent.failure", {
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
        log.warn("slack.error_notify_failed", { error: sanitizeError(postErr) });
      }
      if (threadTs) {
        await setThreadStatus(client, channel, threadTs, "", log);
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
          log.warn("slack.message.final_post_failed", { error: sanitizeError(err) });
        }
      }
    }

    // Clear the typing-style indicator. Slack usually auto-clears when the bot
    // posts but an explicit clear avoids stale lines after roll-finalize.
    if (threadTs) {
      await setThreadStatus(client, channel, threadTs, "", log);
    }

    // Save history. The newest two messages were the user turn + the assistant
    // turn we just produced. OCC-guarded on the version observed at load time —
    // a concurrent mention that won the race makes our save a no-op.
    if (threadTs) {
      const newHistory = [
        ...history,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: finalText },
      ];
      await saveThreadHistory(apiAppId, threadTs, newHistory, {
        maxChars: env.MAX_HISTORY_CHARS,
        expectedVersion: loaded.version,
        logger: log,
      });
    }

    await markDone(apiAppId, dedupKey, user || "system");

    log.info("slack.agent.done", {
      apiAppId,
      steps: agentResult.steps,
      toolCalls: agentResult.toolCallCount,
      tokensIn: agentResult.tokensIn,
      tokensOut: agentResult.tokensOut,
      forcedCompose: agentResult.forcedCompose,
    });
  } finally {
    await throttle.release().catch(() => undefined);
  }
};
