/**
 * Better Auth secondaryStorage backend.
 *
 * - Production (Amplify): Upstash Redis REST when UPSTASH_REDIS_REST_URL is set.
 * - Local development:    ioredis against the docker-compose Valkey instance.
 *
 * Better Auth supplies the value already JSON-stringified and TTL in seconds.
 * Returns a synchronous SecondaryStorage facade that lazily resolves the
 * underlying client on first use.
 */

import type { SecondaryStorage } from "better-auth";

import { getServerEnv } from "@/lib/env";

interface KvBackend {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttl?: number) => Promise<void>;
  del: (key: string) => Promise<void>;
}

let backendPromise: Promise<KvBackend | null> | undefined;

const buildUpstashBackend = async (url: string, token: string): Promise<KvBackend> => {
  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({ url, token });
  return {
    get: async (key) => (await redis.get<string>(key)) ?? null,
    set: async (key, value, ttl) => {
      if (ttl) await redis.set(key, value, { ex: ttl });
      else await redis.set(key, value);
    },
    del: async (key) => {
      await redis.del(key);
    },
  };
};

const buildIoredisBackend = async (url: string): Promise<KvBackend> => {
  const { default: Redis } = await import("ioredis");
  // lazyConnect avoids opening a socket during module import. On Lambda /
  // Amplify SSR cold starts, an unreachable Valkey would otherwise stall the
  // first response while ioredis exhausts its connect retries before the
  // handler even runs.
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
  return {
    get: (key) => redis.get(key),
    set: async (key, value, ttl) => {
      if (ttl) await redis.set(key, value, "EX", ttl);
      else await redis.set(key, value);
    },
    del: async (key) => {
      await redis.del(key);
    },
  };
};

const resolveBackend = async (): Promise<KvBackend | null> => {
  const env = getServerEnv();
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return buildUpstashBackend(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  }
  if (env.REDIS_URL) {
    return buildIoredisBackend(env.REDIS_URL);
  }
  return null;
};

const getBackend = (): Promise<KvBackend | null> => {
  if (!backendPromise) backendPromise = resolveBackend();
  return backendPromise;
};

const noBackendError = () =>
  new Error(
    "secondaryStorage was used but neither REDIS_URL nor UPSTASH_REDIS_REST_URL is configured.",
  );

export const secondaryStorage: SecondaryStorage = {
  get: async (key) => {
    const backend = await getBackend();
    if (!backend) throw noBackendError();
    return backend.get(key);
  },
  set: async (key, value, ttl) => {
    const backend = await getBackend();
    if (!backend) throw noBackendError();
    await backend.set(key, value, ttl);
  },
  delete: async (key) => {
    const backend = await getBackend();
    if (!backend) throw noBackendError();
    await backend.del(key);
  },
};

export const hasSecondaryStorage = (): boolean => {
  const env = getServerEnv();
  return Boolean((env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) || env.REDIS_URL);
};
