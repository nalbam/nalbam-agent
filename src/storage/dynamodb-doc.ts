/**
 * DynamoDB DocStore (architecture §5.7) — tenant metadata, conversation
 * history, user memory. Items live in the single table keyed by the caller's
 * (pk, sk); the `KV#` prefix used by the KvStore keeps the two namespaces apart.
 *
 * `expiresAt` (ms) is stored for exact lazy expiry on read; `ttl` (seconds)
 * lets DynamoDB native TTL garbage-collect. Both are stripped from results so
 * callers see only their own fields plus PK/SK (matching the in-memory store).
 */
import {
  deleteItem,
  getItem,
  putItem,
  queryByPk,
  updateItem,
  type Item,
} from "@/lib/dynamodb-helpers";
import { sanitizeKeyValue } from "@/lib/dynamodb";
import type { DocItem, DocStore } from "@/storage/types";

interface StoredDoc extends Item {
  PK: string;
  SK: string;
  expiresAt?: number;
  ttl?: number;
}

const strip = (item: StoredDoc): DocItem => {
  const { expiresAt: _expiresAt, ttl: _ttl, ...rest } = item;
  return rest as DocItem;
};

const live = (item: StoredDoc | null, now: number): StoredDoc | null => {
  if (!item) return null;
  if (item.expiresAt !== undefined && item.expiresAt <= now) return null;
  return item;
};

export const createDynamoDocStore = (now: () => number = () => Date.now()): DocStore => {
  const key = (pk: string, sk: string) => ({
    PK: sanitizeKeyValue(pk),
    SK: sanitizeKeyValue(sk),
  });

  return {
    async get(pk, sk) {
      const item = await getItem<StoredDoc>(key(pk, sk));
      const fresh = live(item, now());
      return fresh ? (strip(fresh) as never) : null;
    },

    async put(pk, sk, item, opts = {}) {
      const expiresAt = opts.ttlSeconds !== undefined ? now() + opts.ttlSeconds * 1000 : undefined;
      await putItem<StoredDoc>({
        ...item,
        ...key(pk, sk),
        expiresAt,
        ttl: expiresAt !== undefined ? Math.floor(expiresAt / 1000) : undefined,
      });
    },

    async update(pk, sk, set, remove = []) {
      await updateItem(key(pk, sk), set, remove);
    },

    async query(pk, skPrefix = "") {
      const { items } = await queryByPk<StoredDoc>(sanitizeKeyValue(pk), skPrefix);
      const at = now();
      return items
        .filter((item) => live(item, at) !== null)
        .map(strip)
        .sort((a, b) => String(a.SK ?? "").localeCompare(String(b.SK ?? ""))) as never;
    },

    async delete(pk, sk) {
      await deleteItem(key(pk, sk));
    },
  };
};
