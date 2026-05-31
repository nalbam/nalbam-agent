import type { ThrottleLease, ThrottleService } from "@/core/throttle";
import type { KvStore } from "@/storage/types";

export interface KvThrottleOptions {
  maxConcurrent: number;
  ttlSeconds?: number;
}

const DEFAULT_LEASE_TTL_SECONDS = 10 * 60;

export const createKvThrottleService = (kv: KvStore, opts: KvThrottleOptions): ThrottleService => {
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
  const key = (scope: string) => `throttle:active:${scope}`;

  return {
    async acquire(scope): Promise<ThrottleLease> {
      const activeKey = key(scope);
      const current = await kv.incr(activeKey);
      if (current === 1) {
        await kv.expire(activeKey, ttlSeconds);
      }
      if (current > opts.maxConcurrent) {
        const next = await kv.decr(activeKey);
        if (next <= 0) await kv.del(activeKey);
        return { allowed: false, release: async () => {} };
      }

      let released = false;
      return {
        allowed: true,
        release: async () => {
          if (released) return;
          released = true;
          const next = await kv.decr(activeKey);
          if (next <= 0) await kv.del(activeKey);
        },
      };
    },
  };
};
