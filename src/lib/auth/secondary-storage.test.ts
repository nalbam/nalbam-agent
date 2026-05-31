import { beforeEach, describe, expect, it, vi } from "vitest";

const { kv } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    kv: {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    },
  };
});

vi.mock("@/storage/provider", () => ({
  getStorageProvider: () => ({ kv }),
}));

import { secondaryStorage } from "./secondary-storage";

describe("secondaryStorage (DynamoDB-backed KV facade)", () => {
  beforeEach(() => {
    kv.store.clear();
    kv.get.mockClear();
    kv.set.mockClear();
    kv.del.mockClear();
  });

  it("round-trips set/get/delete through the kv store", async () => {
    await secondaryStorage.set("k", "v");
    expect(await secondaryStorage.get("k")).toBe("v");
    await secondaryStorage.delete("k");
    expect(await secondaryStorage.get("k")).toBeNull();
  });

  it("passes the ttl (seconds) through to kv.set", async () => {
    await secondaryStorage.set("session", "data", 120);
    expect(kv.set).toHaveBeenCalledWith("session", "data", 120);
  });
});
