/**
 * DynamoDB KvStore (architecture §5.7) — dedup/throttle/cache + Better Auth
 * secondaryStorage. Single-table item: PK="KV#<key>", SK="KV".
 *
 * - `setNx` uses a conditional PutCommand (`attribute_not_exists(PK)` OR the
 *   existing item is already expired) for race-safe dedup reservation.
 * - `incr`/`decr` use atomic `ADD` on the numeric attribute `n`.
 * - String values live in `v`; counters in `n`. dedup/secondaryStorage use the
 *   string path, throttle uses the counter path — never mixed on one key.
 * - DynamoDB native TTL (`ttl`, seconds) garbage-collects, but deletion may lag
 *   up to ~48h, so reads compare `expiresAt` (ms) for exact expiry (lazy).
 */
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { getDocumentClient, getTableName, sanitizeKeyValue } from "@/lib/dynamodb";
import type { KvStore } from "@/storage/types";

interface KvItem {
  PK: string;
  SK: string;
  v?: string;
  n?: number;
  expiresAt?: number;
  ttl?: number;
}

const SK = "KV";

const isConditionalCheckFailed = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: string }).name === "ConditionalCheckFailedException";

export const createDynamoKv = (now: () => number = () => Date.now()): KvStore => {
  const client = getDocumentClient;
  const table = getTableName;
  const pk = (key: string) => `KV#${sanitizeKeyValue(key)}`;

  return {
    async get(key) {
      const result = await client().send(
        new GetCommand({ TableName: table(), Key: { PK: pk(key), SK } }),
      );
      const item = result.Item as KvItem | undefined;
      if (!item) return null;
      if (item.expiresAt !== undefined && item.expiresAt <= now()) return null;
      if (item.v !== undefined) return item.v;
      if (item.n !== undefined) return String(item.n);
      return null;
    },

    async setNx(key, value, ttlSeconds) {
      const expiresAt = now() + ttlSeconds * 1000;
      const item: KvItem = {
        PK: pk(key),
        SK,
        v: value,
        expiresAt,
        ttl: Math.floor(expiresAt / 1000),
      };
      try {
        await client().send(
          new PutCommand({
            TableName: table(),
            Item: item,
            ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now",
            ExpressionAttributeValues: { ":now": now() },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalCheckFailed(error)) return false;
        throw error;
      }
    },

    async set(key, value, ttlSeconds) {
      const expiresAt = ttlSeconds !== undefined ? now() + ttlSeconds * 1000 : undefined;
      const item: KvItem = {
        PK: pk(key),
        SK,
        v: value,
        expiresAt,
        ttl: expiresAt !== undefined ? Math.floor(expiresAt / 1000) : undefined,
      };
      await client().send(new PutCommand({ TableName: table(), Item: item }));
    },

    async incr(key) {
      const result = await client().send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: pk(key), SK },
          UpdateExpression: "ADD #n :delta",
          ExpressionAttributeNames: { "#n": "n" },
          ExpressionAttributeValues: { ":delta": 1 },
          ReturnValues: "ALL_NEW",
        }),
      );
      return (result.Attributes as KvItem | undefined)?.n ?? 0;
    },

    async decr(key) {
      const result = await client().send(
        new UpdateCommand({
          TableName: table(),
          Key: { PK: pk(key), SK },
          UpdateExpression: "ADD #n :delta",
          ExpressionAttributeNames: { "#n": "n" },
          ExpressionAttributeValues: { ":delta": -1 },
          ReturnValues: "ALL_NEW",
        }),
      );
      return (result.Attributes as KvItem | undefined)?.n ?? 0;
    },

    async expire(key, ttlSeconds) {
      const expiresAt = now() + ttlSeconds * 1000;
      try {
        await client().send(
          new UpdateCommand({
            TableName: table(),
            Key: { PK: pk(key), SK },
            UpdateExpression: "SET expiresAt = :e, #ttl = :t",
            ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":e": expiresAt, ":t": Math.floor(expiresAt / 1000) },
          }),
        );
      } catch (error) {
        if (isConditionalCheckFailed(error)) return;
        throw error;
      }
    },

    async del(key) {
      await client().send(new DeleteCommand({ TableName: table(), Key: { PK: pk(key), SK } }));
    },
  };
};
