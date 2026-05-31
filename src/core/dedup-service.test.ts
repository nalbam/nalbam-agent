import { describe, expect, it } from "vitest";

import { createKvDedupService } from "@/core/dedup-service";
import { createMemoryKv } from "@/storage/memory-kv";

describe("createKvDedupService", () => {
  it("reserves in-flight work and rejects parallel duplicates", async () => {
    const dedup = createKvDedupService(createMemoryKv());
    expect(await dedup.reserve("slack:t1:k1")).toBe(true);
    expect(await dedup.reserve("slack:t1:k1")).toBe(false);
  });

  it("marks done and clears the in-flight reservation", async () => {
    const kv = createMemoryKv();
    const dedup = createKvDedupService(kv);
    expect(await dedup.isDone("slack:t1:k1")).toBe(false);
    expect(await dedup.reserve("slack:t1:k1")).toBe(true);
    await dedup.markDone("slack:t1:k1");
    expect(await dedup.isDone("slack:t1:k1")).toBe(true);
    expect(await kv.get("dedup:inflight:slack:t1:k1")).toBeNull();
  });
});
