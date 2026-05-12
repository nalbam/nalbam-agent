/**
 * Thread conversation history with TTL.
 *
 * One DynamoDB row per (api_app_id, thread_ts) holds the agent's message log
 * for that thread. The serialized JSON is bounded to `maxChars` (default from
 * env `MAX_HISTORY_CHARS`) by dropping oldest messages — the trimming is what
 * keeps a long-running thread from blowing the token budget on every turn.
 *
 * The TTL attribute makes DynamoDB sweep expired rows automatically; the
 * default 1h matches the original lambda-gurumi-bot behavior. Operators
 * shouldn't depend on history older than a session.
 */
import { getItem, putItem } from "@/lib/dynamodb-helpers";
import { keys, ttlFromDate } from "@/lib/dynamodb";
import { logger } from "@/lib/logger";

/** Roles supported in thread history. Matches Vercel AI SDK ModelMessage shape. */
export type ThreadRole = "user" | "assistant" | "system" | "tool";

export interface ThreadMessage {
  role: ThreadRole;
  content: string;
}

type ThreadRow = {
  apiAppId?: string;
  threadTs?: string;
  messages?: string;
  ttl?: number;
} & Record<string, unknown>;

const DEFAULT_TTL_SECONDS = 3600;

const nowEpoch = (): number => Math.floor(Date.now() / 1000);

const isThreadMessage = (v: unknown): v is ThreadMessage =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ThreadMessage).role === "string" &&
  typeof (v as ThreadMessage).content === "string";

export const loadThreadHistory = async (
  apiAppId: string,
  threadTs: string,
): Promise<ThreadMessage[]> => {
  if (!apiAppId || !threadTs) return [];
  let row: ThreadRow | null;
  try {
    row = await getItem<ThreadRow>(keys.slackThread(apiAppId, threadTs));
  } catch (err) {
    logger.warn("slack.conversation.load_failed", {
      apiAppId,
      threadTs,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  if (!row?.messages) return [];
  try {
    const parsed: unknown = JSON.parse(row.messages);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isThreadMessage);
  } catch (err) {
    logger.warn("slack.conversation.parse_failed", {
      apiAppId,
      threadTs,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
};

export interface SaveThreadOptions {
  ttlSeconds?: number;
  maxChars?: number;
}

export const saveThreadHistory = async (
  apiAppId: string,
  threadTs: string,
  messages: ThreadMessage[],
  options: SaveThreadOptions = {},
): Promise<void> => {
  if (!apiAppId || !threadTs) return;
  const maxChars = options.maxChars ?? 4000;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const trimmed = truncateToChars(messages, maxChars);
  const key = keys.slackThread(apiAppId, threadTs);
  try {
    await putItem({
      ...key,
      entity: "SLACK_THREAD",
      apiAppId,
      threadTs,
      messages: JSON.stringify(trimmed),
      ttl: ttlFromDate((nowEpoch() + ttlSeconds) * 1000),
    });
  } catch (err) {
    logger.warn("slack.conversation.save_failed", {
      apiAppId,
      threadTs,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

const ARRAY_BRACKETS = 2;
// JSON.stringify uses `,` (no space) by default — 1 char. Python's json.dumps
// uses `, ` so the original lambda-gurumi-bot port used 2.
const ITEM_SEPARATOR = 1;

/**
 * Drop oldest messages until JSON.stringify(kept).length <= maxChars.
 *
 * Walks newest→oldest, keeping the largest suffix of messages that fits.
 * Result length matches `JSON.stringify(kept)` exactly, modulo the default
 * separator. Empty list serializes to "[]" (2 chars), which is always
 * within budget for any non-trivial maxChars.
 */
export const truncateToChars = (messages: ThreadMessage[], maxChars: number): ThreadMessage[] => {
  if (messages.length === 0) return [];
  const sizes = messages.map((m) => JSON.stringify(m).length);
  let total = ARRAY_BRACKETS;
  let start = messages.length; // exclusive; empty kept serializes to "[]"
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const sep = start < messages.length ? ITEM_SEPARATOR : 0;
    const cost = (sizes[i] ?? 0) + sep;
    if (total + cost > maxChars) break;
    total += cost;
    start = i;
  }
  return messages.slice(start);
};
