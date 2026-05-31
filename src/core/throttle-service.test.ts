import { describe, expect, it } from "vitest";

import { createKvThrottleService } from "@/core/throttle-service";
import { createMemoryKv } from "@/storage/memory-kv";

describe("createKvThrottleService", () => {
  it("limits concurrent leases per scoped user key", async () => {
    const throttle = createKvThrottleService(createMemoryKv(), { maxConcurrent: 1 });
    const first = await throttle.acquire("slack:t1:u1");
    const second = await throttle.acquire("slack:t1:u1");
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    await first.release();
    expect((await throttle.acquire("slack:t1:u1")).allowed).toBe(true);
  });

  it("does not share limits across tenant scopes", async () => {
    const throttle = createKvThrottleService(createMemoryKv(), { maxConcurrent: 1 });
    expect((await throttle.acquire("slack:t1:u1")).allowed).toBe(true);
    expect((await throttle.acquire("slack:t2:u1")).allowed).toBe(true);
  });
});
