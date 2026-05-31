import { describe, expect, it } from "vitest";

import { createMemoryDocStore } from "@/storage/memory-doc";

describe("createMemoryDocStore", () => {
  it("stores, updates, queries, and deletes document items", async () => {
    const doc = createMemoryDocStore();
    await doc.put("TENANT#api#t1", "META", { name: "tenant" });
    await doc.put("TENANT#api#t1", "MEM#001", { text: "a" });
    await doc.update("TENANT#api#t1", "MEM#001", { text: "b", removeMe: true }, ["removeMe"]);

    await expect(doc.get("TENANT#api#t1", "META")).resolves.toMatchObject({
      PK: "TENANT#api#t1",
      SK: "META",
      name: "tenant",
    });
    await expect(doc.query("TENANT#api#t1", "MEM#")).resolves.toEqual([
      { PK: "TENANT#api#t1", SK: "MEM#001", text: "b" },
    ]);

    await doc.delete("TENANT#api#t1", "META");
    await expect(doc.get("TENANT#api#t1", "META")).resolves.toBeNull();
  });

  it("honors ttl expiry", async () => {
    let now = 0;
    const doc = createMemoryDocStore(() => now);
    await doc.put("PK", "SK", { value: 1 }, { ttlSeconds: 1 });
    await expect(doc.get("PK", "SK")).resolves.toMatchObject({ value: 1 });
    now = 1001;
    await expect(doc.get("PK", "SK")).resolves.toBeNull();
  });
});
