import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL = { ...process.env };

const reload = async () => {
  // env.ts caches on first call. Clear vitest's module registry.
  const mod = await import("./env");
  return mod;
};

describe("getServerEnv", () => {
  beforeEach(() => {
    // Reset to setup defaults
    process.env = { ...ORIGINAL };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("loads defaults on a clean test env", async () => {
    const { getServerEnv } = await reload();
    const env = getServerEnv();
    expect(env.AWS_REGION).toBe("ap-northeast-2");
    expect(env.DYNAMODB_TABLE_NAME).toBe("app-main-test");
    expect(env.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it("accepts configured OpenAI-compatible LLM providers", async () => {
    process.env.LLM_PROVIDER = "xai";
    process.env.XAI_API_KEY = "xai-key";
    process.env.XAI_BASE_URL = "https://example.com/xai";
    const { getServerEnv, __resetServerEnvForTests } = await reload();
    __resetServerEnvForTests();
    const env = getServerEnv();
    expect(env.LLM_PROVIDER).toBe("xai");
    expect(env.XAI_BASE_URL).toBe("https://example.com/xai");
  });

  it("parses S3 blob storage settings", async () => {
    process.env.S3_BUCKET_NAME = "agent-bucket";
    process.env.S3_PREFIX = "tenant-blobs";
    process.env.S3_ENDPOINT = "http://localhost:9000";
    process.env.S3_FORCE_PATH_STYLE = "true";
    const { getServerEnv, __resetServerEnvForTests } = await reload();
    __resetServerEnvForTests();
    const env = getServerEnv();
    expect(env.S3_BUCKET_NAME).toBe("agent-bucket");
    expect(env.S3_PREFIX).toBe("tenant-blobs");
    expect(env.S3_ENDPOINT).toBe("http://localhost:9000");
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("client env exposes app name", async () => {
    const { clientEnv } = await reload();
    expect(typeof clientEnv.NEXT_PUBLIC_APP_NAME).toBe("string");
    expect(clientEnv.NEXT_PUBLIC_APP_NAME.length).toBeGreaterThan(0);
  });
});
