import { describe, expect, it } from "vitest";

import { createMemoryKv } from "@/storage/memory-kv";

describe("createMemoryKv", () => {
  it("setNx is idempotent — second writer loses", async () => {
    const kv = createMemoryKv();
    expect(await kv.setNx("k", "1", 60)).toBe(true);
    expect(await kv.setNx("k", "2", 60)).toBe(false);
    expect(await kv.get("k")).toBe("1");
  });

  it("honors TTL expiry", async () => {
    let now = 0;
    const kv = createMemoryKv(() => now);
    await kv.setNx("k", "1", 1);
    expect(await kv.get("k")).toBe("1");
    now = 1001;
    expect(await kv.get("k")).toBeNull();
    // expired slot is free again
    expect(await kv.setNx("k", "2", 1)).toBe(true);
  });

  it("incr / decr count from zero", async () => {
    const kv = createMemoryKv();
    expect(await kv.incr("c")).toBe(1);
    expect(await kv.incr("c")).toBe(2);
    expect(await kv.decr("c")).toBe(1);
  });
});
