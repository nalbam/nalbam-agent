import { describe, expect, it } from "vitest";

import { createMemoryBlobStore } from "@/storage/memory-blob";

describe("createMemoryBlobStore", () => {
  it("stores blobs in channel and tenant scoped keys", async () => {
    const blob = createMemoryBlobStore();
    const data = new Uint8Array([1, 2, 3]);

    const ref = await blob.put({
      channel: "api",
      tenantId: "tenant-a",
      name: "out.bin",
      data,
      mime: "application/octet-stream",
    });

    expect(ref).toEqual({
      key: "api/tenant-a/out.bin",
      mime: "application/octet-stream",
      size: 3,
    });
    expect(await blob.get(ref.key)).toEqual(data);
    expect(await blob.signedUrl(ref.key)).toBe("memory://api/tenant-a/out.bin");

    await blob.delete(ref.key);
    expect(await blob.get(ref.key)).toBeNull();
  });
});
