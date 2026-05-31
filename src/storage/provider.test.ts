import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPipelineDeps } from "@/core/deps";
import { __resetServerEnvForTests } from "@/lib/env";
import { __resetStorageProviderForTests, createStorageProvider } from "@/storage/provider";

const ORIGINAL = { ...process.env };

describe("createStorageProvider", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
    __resetStorageProviderForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
    __resetStorageProviderForTests();
  });

  it("uses in-memory blob storage when no S3 bucket is configured", async () => {
    delete process.env.S3_BUCKET_NAME;
    __resetServerEnvForTests();

    const storage = createStorageProvider();
    const ref = await storage.blob.put({
      channel: "api",
      tenantId: "tenant-a",
      name: "x.txt",
      data: new Uint8Array([1]),
    });
    expect(await storage.blob.signedUrl(ref.key)).toBe("memory://api/tenant-a/x.txt");
  });

  it("exposes storage through pipeline deps", () => {
    const deps = buildPipelineDeps();
    expect(deps.storage.kv).toBeDefined();
    expect(deps.storage.doc).toBeDefined();
    expect(deps.storage.blob).toBeDefined();
  });
});
