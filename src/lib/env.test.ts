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

  it("client env exposes app name", async () => {
    const { clientEnv } = await reload();
    expect(typeof clientEnv.NEXT_PUBLIC_APP_NAME).toBe("string");
    expect(clientEnv.NEXT_PUBLIC_APP_NAME.length).toBeGreaterThan(0);
  });
});
