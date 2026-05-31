/**
 * Better Auth secondaryStorage backend.
 *
 * Delegates to the DynamoDB-backed `StorageProvider.kv` (architecture §5.7) so
 * sessions and rate-limit counters share the single table — no separate KV
 * infrastructure. Better Auth supplies the value already JSON-stringified and
 * the TTL in seconds, matching `KvStore.set(key, value, ttlSeconds?)`.
 */

import type { SecondaryStorage } from "better-auth";

import { getStorageProvider } from "@/storage/provider";

export const secondaryStorage: SecondaryStorage = {
  get: (key) => getStorageProvider().kv.get(key),
  set: async (key, value, ttl) => {
    await getStorageProvider().kv.set(key, value, ttl);
  },
  delete: async (key) => {
    await getStorageProvider().kv.del(key);
  },
};
