/**
 * In-memory KvStore (architecture §5.7) — for tests and local dev.
 *
 * `setNx` is the race-safe dedup primitive; this single-process implementation
 * is atomic by JS single-threading.
 */
import type { KvStore } from "@/storage/types";

interface Entry {
  value: string;
  expiresAt?: number;
}

export const createMemoryKv = (now: () => number = () => Date.now()): KvStore => {
  const map = new Map<string, Entry>();

  const live = (key: string): Entry | undefined => {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async setNx(key, value, ttlSeconds) {
      if (live(key)) return false;
      map.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return true;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, {
        value,
        expiresAt: ttlSeconds !== undefined ? now() + ttlSeconds * 1000 : undefined,
      });
    },
    async incr(key) {
      const entry = live(key);
      const next = (entry ? Number.parseInt(entry.value, 10) || 0 : 0) + 1;
      map.set(key, { value: String(next), expiresAt: entry?.expiresAt });
      return next;
    },
    async decr(key) {
      const entry = live(key);
      const next = (entry ? Number.parseInt(entry.value, 10) || 0 : 0) - 1;
      map.set(key, { value: String(next), expiresAt: entry?.expiresAt });
      return next;
    },
    async expire(key, ttlSeconds) {
      const entry = live(key);
      if (entry) entry.expiresAt = now() + ttlSeconds * 1000;
    },
    async del(key) {
      map.delete(key);
    },
  };
};
