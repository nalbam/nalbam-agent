import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

const reload = async () => {
  vi.resetModules();
  return await import("./secondary-storage");
};

describe("hasSecondaryStorage", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    // Setup file populates some keys with `??=` — explicitly clear them so
    // assertions below reflect the documented branches rather than test-runner
    // defaults.
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("returns false when neither REDIS_URL nor Upstash credentials are set", async () => {
    const { hasSecondaryStorage } = await reload();
    expect(hasSecondaryStorage()).toBe(false);
  });

  it("returns true when only REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { hasSecondaryStorage } = await reload();
    expect(hasSecondaryStorage()).toBe(true);
  });

  it("returns true when both Upstash url and token are set", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
    const { hasSecondaryStorage } = await reload();
    expect(hasSecondaryStorage()).toBe(true);
  });

  it("returns false when Upstash url is set but token is missing", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    const { hasSecondaryStorage } = await reload();
    expect(hasSecondaryStorage()).toBe(false);
  });
});

describe("secondaryStorage facade", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("throws a descriptive error when no backend is configured", async () => {
    const { secondaryStorage } = await reload();
    await expect(secondaryStorage.get("k")).rejects.toThrow(/neither REDIS_URL nor UPSTASH/);
    await expect(secondaryStorage.set("k", "v")).rejects.toThrow(/neither REDIS_URL nor UPSTASH/);
    await expect(secondaryStorage.delete("k")).rejects.toThrow(/neither REDIS_URL nor UPSTASH/);
  });
});
