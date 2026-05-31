import type { DedupService } from "@/core/dedup";
import type { KvStore } from "@/storage/types";

export interface KvDedupOptions {
  inFlightTtlSeconds?: number;
  doneTtlSeconds?: number;
}

const DEFAULT_IN_FLIGHT_TTL_SECONDS = 5 * 60;
const DEFAULT_DONE_TTL_SECONDS = 24 * 60 * 60;

export const createKvDedupService = (kv: KvStore, opts: KvDedupOptions = {}): DedupService => {
  const inFlightTtlSeconds = opts.inFlightTtlSeconds ?? DEFAULT_IN_FLIGHT_TTL_SECONDS;
  const doneTtlSeconds = opts.doneTtlSeconds ?? DEFAULT_DONE_TTL_SECONDS;
  const inFlightKey = (scope: string) => `dedup:inflight:${scope}`;
  const doneKey = (scope: string) => `dedup:done:${scope}`;

  return {
    async isDone(scope) {
      return (await kv.get(doneKey(scope))) !== null;
    },
    async reserve(scope) {
      if ((await kv.get(doneKey(scope))) !== null) return false;
      return kv.setNx(inFlightKey(scope), "1", inFlightTtlSeconds);
    },
    async markDone(scope) {
      await kv.set(doneKey(scope), "1", doneTtlSeconds);
      await kv.del(inFlightKey(scope));
    },
  };
};
