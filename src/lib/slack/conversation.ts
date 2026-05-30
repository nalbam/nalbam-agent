/**
 * Thread conversation history with TTL.
 *
 * One DynamoDB row per (api_app_id, thread_ts) holds the agent's message log
 * for that thread. The serialized JSON is bounded to `maxChars` (default from
 * env `MAX_HISTORY_CHARS`) by dropping oldest messages — the trimming is what
 * keeps a long-running thread from blowing the token budget on every turn.
 *
 * The TTL attribute makes DynamoDB sweep expired rows automatically; the
 * default is 1h. Operators shouldn't depend on history older than a session.
 *
 * Concurrency: writes use optimistic concurrency control via a `version`
 * column. `loadThreadHistory` returns the version it observed so callers
 * can pass it back to `saveThreadHistory`; the put is `ConditionExpression`-
 * guarded on the version matching. If two concurrent mentions in the same
 * thread both load `version=N` and try to save `version=N+1`, only the
 * first wins — the second logs `slack.conversation.race_lost` so the
 * collision is visible. (Frequency is rare in practice; the alternative —
 * append-only sub-rows — is a heavier schema change.)
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";

import { getDocumentClient, getTableName, keys, ttlFromDate } from "@/lib/dynamodb";
import { getItem } from "@/lib/dynamodb-helpers";
import { logger as defaultLogger, type Logger } from "@/lib/logger";

/** Roles supported in thread history. Matches Vercel AI SDK ModelMessage shape. */
export type ThreadRole = "user" | "assistant" | "system" | "tool";

export interface ThreadMessage {
  role: ThreadRole;
  content: string;
}

export interface LoadedThreadHistory {
  messages: ThreadMessage[];
  /** Row version observed on load. Pass back to `saveThreadHistory` for OCC. */
  version: number;
}

type ThreadRow = {
  apiAppId?: string;
  threadTs?: string;
  messages?: string;
  ttl?: number;
  version?: number;
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
  log: Logger = defaultLogger,
): Promise<LoadedThreadHistory> => {
  if (!apiAppId || !threadTs) return { messages: [], version: 0 };
  let row: ThreadRow | null;
  try {
    row = await getItem<ThreadRow>(keys.slackThread(apiAppId, threadTs));
  } catch (err) {
    log.warn("slack.conversation.load_failed", {
      apiAppId,
      threadTs,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], version: 0 };
  }
  const version = typeof row?.version === "number" ? row.version : 0;
  if (!row?.messages) return { messages: [], version };
  try {
    const parsed: unknown = JSON.parse(row.messages);
    if (!Array.isArray(parsed)) return { messages: [], version };
    return { messages: parsed.filter(isThreadMessage), version };
  } catch (err) {
    log.warn("slack.conversation.parse_failed", {
      apiAppId,
      threadTs,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messages: [], version };
  }
};

export interface SaveThreadOptions {
  ttlSeconds?: number;
  maxChars?: number;
  /**
   * Optimistic-concurrency token — the `version` returned by the prior
   * `loadThreadHistory`. Omit to disable the OCC check (first-time creation
   * is detected when `expectedVersion === 0` and uses
   * `attribute_not_exists(version)` instead).
   */
  expectedVersion?: number;
  logger?: Logger;
}

export interface SaveThreadResult {
  ok: boolean;
  /** True when the row was created/updated; false when the OCC check failed. */
  raced?: boolean;
}

export const saveThreadHistory = async (
  apiAppId: string,
  threadTs: string,
  messages: ThreadMessage[],
  options: SaveThreadOptions = {},
): Promise<SaveThreadResult> => {
  if (!apiAppId || !threadTs) return { ok: false };
  const log = options.logger ?? defaultLogger;
  const maxChars = options.maxChars ?? 4000;
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expectedVersion = options.expectedVersion ?? 0;
  const trimmed = truncateToChars(messages, maxChars);
  const key = keys.slackThread(apiAppId, threadTs);
  const nextVersion = expectedVersion + 1;

  const item = {
    ...key,
    entity: "SLACK_THREAD",
    apiAppId,
    threadTs,
    messages: JSON.stringify(trimmed),
    ttl: ttlFromDate((nowEpoch() + ttlSeconds) * 1000),
    version: nextVersion,
  };

  const cmd = new PutCommand({
    TableName: getTableName(),
    Item: item,
    ConditionExpression: expectedVersion === 0 ? "attribute_not_exists(#v)" : "#v = :expected",
    ExpressionAttributeNames: { "#v": "version" },
    ExpressionAttributeValues: expectedVersion === 0 ? undefined : { ":expected": expectedVersion },
  });

  try {
    await getDocumentClient().send(cmd);
    return { ok: true };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      log.warn("slack.conversation.race_lost", {
        apiAppId,
        threadTs,
        expectedVersion,
      });
      return { ok: false, raced: true };
    }
    log.warn("slack.conversation.save_failed", {
      apiAppId,
      threadTs,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
};

const ARRAY_BRACKETS = 2;
// JSON.stringify joins array items with `,` (no space) — 1 char per separator.
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
