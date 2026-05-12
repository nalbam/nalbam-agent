/**
 * Slack user-id → display-name cache.
 *
 * Resolving `<@U...>` mentions inline would mean one `users.info` round-trip
 * per mention per request — easy to blow the LLM tool timeout when 50 unique
 * users appear in a thread. This cache:
 *
 *   - returns a cached name in O(1)
 *   - falls back to the user id on miss + Slack API error
 *   - `warm()` pre-resolves many ids in parallel before the rendering loop
 *
 * The cache is module-level so it survives across requests on the same warm
 * Lambda container.
 */
import type { WebClient } from "@slack/web-api";

import { logger } from "@/lib/logger";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

const MAX_PARALLEL_WARM = 8;

interface UsersInfoResponseShape {
  user?: {
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

const resolveName = (userId: string, info: UsersInfoResponseShape): string => {
  const profile = info.user?.profile;
  return (
    profile?.display_name ||
    profile?.real_name ||
    info.user?.real_name ||
    userId
  );
};

export const getUserName = async (client: WebClient, userId: string): Promise<string> => {
  if (!userId) return "";
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  const pending = inflight.get(userId);
  if (pending) return pending;
  const promise = (async (): Promise<string> => {
    try {
      const res = (await client.users.info({ user: userId })) as UsersInfoResponseShape;
      const name = resolveName(userId, res);
      cache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug("slack.user_name_cache.miss", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Cache the fallback so we don't keep retrying for users Slack can't
      // resolve (deleted account, scope missing).
      cache.set(userId, userId);
      return userId;
    } finally {
      inflight.delete(userId);
    }
  })();
  inflight.set(userId, promise);
  return promise;
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/**
 * Pre-resolve a batch of user ids in parallel. Misses run concurrently
 * (in groups of up to `MAX_PARALLEL_WARM`), already-cached entries are
 * skipped.
 */
export const warmUserNames = async (
  client: WebClient,
  userIds: Iterable<string>,
): Promise<void> => {
  const misses = new Set<string>();
  for (const id of userIds) {
    if (id && !cache.has(id)) misses.add(id);
  }
  if (misses.size === 0) return;
  for (const batch of chunk(Array.from(misses), MAX_PARALLEL_WARM)) {
    await Promise.all(batch.map((id) => getUserName(client, id)));
  }
};

export const findUserIdByName = (name: string): string | undefined => {
  if (!name) return undefined;
  for (const [id, cached] of cache) {
    if (cached === name) return id;
  }
  return undefined;
};

export const setUserName = (userId: string, name: string): void => {
  if (!userId || !name) return;
  if (!cache.has(userId)) cache.set(userId, name);
};

export const __resetUserNameCacheForTests = (): void => {
  cache.clear();
  inflight.clear();
};
