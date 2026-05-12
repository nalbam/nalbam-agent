/**
 * Two-stage idempotency for Slack event processing.
 *
 *   reserve(eventKey)          ← writes SLACK_DEDUP row, TTL 300s (in-flight)
 *   mark_done(eventKey)        ← writes SLACK_DONE  row, TTL 3600s
 *   is_done(eventKey)          ← cheap read of the SLACK_DONE row
 *
 * The split exists because Lambda async retries can fire while a worker is
 * still running. The `dedup:` row (short TTL) blocks parallel duplicates, and
 * the `done:` row (long TTL) absorbs retries that arrive after the in-flight
 * row has expired. A worker that crashes never writes `done:`, so after the
 * in-flight TTL the next retry is allowed to re-run the agent — which is
 * exactly the recovery we want.
 *
 * `reserve` uses ConditionExpression=attribute_not_exists(PK) for atomicity.
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, type PutCommandInput } from "@aws-sdk/lib-dynamodb";

import { getDocumentClient, getTableName, keys, ttlFromDate } from "@/lib/dynamodb";
import { getItem } from "@/lib/dynamodb-helpers";
import { logger } from "@/lib/logger";

/** In-flight reservation TTL. Must outlive the longest agent run. */
export const DEFAULT_RESERVE_TTL_SECONDS = 300;
/** Completion marker TTL — absorbs slow Slack retries after success. */
export const DEFAULT_DONE_TTL_SECONDS = 3600;

type DedupRow = { ttl?: number } & Record<string, unknown>;

const nowEpoch = (): number => Math.floor(Date.now() / 1000);

/**
 * Atomically reserve `eventKey` for the running worker.
 *
 * Returns `true` if this caller acquired the reservation, `false` if a
 * concurrent worker already holds it.
 */
export const reserve = async (
  apiAppId: string,
  eventKey: string,
  user = "system",
  ttlSeconds: number = DEFAULT_RESERVE_TTL_SECONDS,
): Promise<boolean> => {
  const key = keys.slackDedup(apiAppId, eventKey);
  const item = {
    ...key,
    entity: "SLACK_DEDUP",
    apiAppId,
    eventKey,
    user,
    ttl: ttlFromDate((nowEpoch() + ttlSeconds) * 1000),
  };
  const input: PutCommandInput = {
    TableName: getTableName(),
    Item: item,
    ConditionExpression: "attribute_not_exists(PK)",
  };
  try {
    await getDocumentClient().send(new PutCommand(input));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    // Surface non-conditional errors so the route can log and fail open
    // (better to maybe-double-process than to silently swallow a DDB outage).
    throw err;
  }
};

export const isDone = async (apiAppId: string, eventKey: string): Promise<boolean> => {
  try {
    const row = await getItem<DedupRow>(keys.slackDone(apiAppId, eventKey));
    return row !== null;
  } catch (err) {
    logger.warn("slack.dedup.is_done_failed", {
      apiAppId,
      eventKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
};

export const markDone = async (
  apiAppId: string,
  eventKey: string,
  user = "system",
  ttlSeconds: number = DEFAULT_DONE_TTL_SECONDS,
): Promise<void> => {
  const key = keys.slackDone(apiAppId, eventKey);
  const item = {
    ...key,
    entity: "SLACK_DONE",
    apiAppId,
    eventKey,
    user,
    ttl: ttlFromDate((nowEpoch() + ttlSeconds) * 1000),
  };
  try {
    await getDocumentClient().send(new PutCommand({ TableName: getTableName(), Item: item }));
  } catch (err) {
    // Non-fatal: at worst a future retry re-runs the agent. We log so
    // operators can spot a chronic outage; we do not raise into the
    // response path.
    logger.warn("slack.dedup.mark_done_failed", {
      apiAppId,
      eventKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
