/**
 * Per-user concurrent-request throttle.
 *
 * Backend selection mirrors `src/lib/auth/secondary-storage.ts`:
 *   1. Upstash Redis REST (when both env vars are set) — preferred for
 *      Amplify deployments since it's HTTP and VPC-free.
 *   2. ioredis (local Valkey) — `REDIS_URL`.
 *   3. None → throttle is disabled (always allowed). Useful for dev /
 *      tests when no KV is attached.
 *
 * Semantics: per-user INCR with a 10-min TTL fallback. The caller MUST
 * call `release()` on the returned object — `try/finally` is the
 * intended pattern. The TTL is a safety net for releases that get
 * dropped (Lambda timeout mid-handler); after the window any leaked
 * counter is garbage-collected.
 *
 * This is best-effort: we never block the agent on a counter-store
 * outage. On any backend error we log and let the request through.
 */
import { getServerEnv } from "@/lib/env";
import { logger as defaultLogger, type Logger } from "@/lib/logger";
import { sanitizeError } from "@/lib/slack/formatter";

interface ThrottleBackend {
  incr: (key: string) => Promise<number>;
  decr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<void>;
}

const TTL_SECONDS = 600;
const KEY_PREFIX = "nalbam-agent:throttle:";

let cachedBackend: ThrottleBackend | null | undefined;

const buildBackend = async (): Promise<ThrottleBackend | null> => {
  const env = getServerEnv();
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = await import("@upstash/redis");
    const redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
    return {
      incr: (k) => redis.incr(k),
      decr: (k) => redis.decr(k),
      expire: async (k, s) => {
        await redis.expire(k, s);
      },
    };
  }
  if (env.REDIS_URL) {
    const ioredisModule = await import("ioredis");
    const IORedisCtor = ioredisModule.default ?? ioredisModule;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new (IORedisCtor as any)(env.REDIS_URL, { lazyConnect: false });
    return {
      incr: (k) => client.incr(k) as Promise<number>,
      decr: (k) => client.decr(k) as Promise<number>,
      expire: async (k, s) => {
        await client.expire(k, s);
      },
    };
  }
  return null;
};

const getBackend = async (logger: Logger): Promise<ThrottleBackend | null> => {
  if (cachedBackend !== undefined) return cachedBackend;
  try {
    cachedBackend = await buildBackend();
  } catch (err) {
    logger.warn("slack.throttle.backend_init_failed", { error: sanitizeError(err) });
    cachedBackend = null;
  }
  return cachedBackend;
};

export interface ThrottleInput {
  user: string;
  max: number;
  logger?: Logger;
}

export interface ThrottleResult {
  allowed: boolean;
  /** Decrement the counter when the agent run finishes (or fails). Safe to call twice. */
  release: () => Promise<void>;
}

const NOOP_RELEASE = async (): Promise<void> => {};

export const checkAndIncrementThrottle = async ({
  user,
  max,
  logger = defaultLogger,
}: ThrottleInput): Promise<ThrottleResult> => {
  if (!user || max <= 0) return { allowed: true, release: NOOP_RELEASE };
  const backend = await getBackend(logger);
  if (!backend) return { allowed: true, release: NOOP_RELEASE };

  const key = `${KEY_PREFIX}${user}`;
  let count: number;
  try {
    count = await backend.incr(key);
    await backend.expire(key, TTL_SECONDS);
  } catch (err) {
    logger.warn("slack.throttle.incr_failed", { error: sanitizeError(err) });
    return { allowed: true, release: NOOP_RELEASE };
  }

  if (count > max) {
    try {
      await backend.decr(key);
    } catch (err) {
      logger.warn("slack.throttle.rollback_failed", { error: sanitizeError(err) });
    }
    return { allowed: false, release: NOOP_RELEASE };
  }

  let released = false;
  return {
    allowed: true,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await backend.decr(key);
      } catch (err) {
        logger.warn("slack.throttle.release_failed", { error: sanitizeError(err) });
      }
    },
  };
};

/** Test-only helper to reset module-level state between tests. */
export const __resetThrottleForTests = (): void => {
  cachedBackend = undefined;
};
