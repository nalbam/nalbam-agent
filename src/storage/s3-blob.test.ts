import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTenantBlobKey, createConfiguredS3BlobStore } from "@/storage/s3-blob";
import { __resetServerEnvForTests } from "@/lib/env";

const ORIGINAL = { ...process.env };

describe("buildTenantBlobKey", () => {
  it("scopes keys by prefix, channel, and tenant", () => {
    const key = buildTenantBlobKey("agent", "slack", "T123", "../file name.txt");
    expect(key).toMatch(/^agent\/slack\/T123\/[0-9]+-[0-9a-f-]+-\.\.-file_name\.txt$/);
  });

  it("sanitizes unsafe path segments", () => {
    const key = buildTenantBlobKey("/root/", "api/v1", "tenant:one", "a/b c?.png");
    expect(key).toContain("root/api-v1/tenant_one/");
    expect(key).toMatch(/-a-b_c_\.png$/);
  });
});

describe("createConfiguredS3BlobStore", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.S3_BUCKET_NAME;
    __resetServerEnvForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
  });

  it("fails fast when no S3 bucket is configured", () => {
    expect(() => createConfiguredS3BlobStore()).toThrow(/S3_BUCKET_NAME/);
  });
});
