/**
 * Slack assistant-thread status indicator.
 *
 * Wraps `assistant.threads.setStatus` which renders a typing-like
 * "Thinking…" line on AI-enabled workspaces. Workspaces without the
 * assistant API installed return `not_authed` / `method_not_supported`
 * — treat any failure as a no-op since the indicator is purely cosmetic.
 *
 * Pass an empty string to clear the status. Slack also auto-clears when
 * the bot posts a message, but explicit clears avoid stale lines after
 * roll-finalize when the streaming message spans multiple ts'es.
 */
import type { WebClient } from "@slack/web-api";

import { logger as defaultLogger, type Logger } from "@/lib/logger";
import { sanitizeError } from "@/lib/slack/formatter";

export const setThreadStatus = async (
  client: WebClient,
  channel: string,
  threadTs: string,
  status: string,
  log: Logger = defaultLogger,
): Promise<void> => {
  if (!channel || !threadTs) return;
  try {
    await client.apiCall("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
    });
  } catch (err) {
    log.debug("slack.thread_status.failed", {
      channel,
      threadTs,
      error: sanitizeError(err),
    });
  }
};
