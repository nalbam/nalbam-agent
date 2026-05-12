import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSlackCredentialsForTests,
  getSlackCredentials,
  invalidateSlackCredentials,
} from "@/lib/slack/credentials";

const PREFIX = "/test/apps";
const APP = "A0XXXX";

const signingName = `${PREFIX}/${APP}/signing_secret`;
const tokenName = `${PREFIX}/${APP}/bot_token`;

beforeEach(() => {
  __resetSlackCredentialsForTests();
});

describe("getSlackCredentials", () => {
  it("returns credentials from SSM and caches them within TTL", async () => {
    const getParameters = vi.fn(async () => ({
      [signingName]: "ss",
      [tokenName]: "xoxb-abc",
    }));
    const client = { getParameters };
    let clock = 1_000;
    const nowSeconds = () => clock;

    const first = await getSlackCredentials(APP, {
      client,
      prefix: PREFIX,
      ttlSeconds: 60,
      nowSeconds,
    });
    expect(first).toEqual({ signingSecret: "ss", botToken: "xoxb-abc" });

    clock = 1_030; // within TTL
    const second = await getSlackCredentials(APP, {
      client,
      prefix: PREFIX,
      ttlSeconds: 60,
      nowSeconds,
    });
    expect(second).toEqual({ signingSecret: "ss", botToken: "xoxb-abc" });
    expect(getParameters).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    const getParameters = vi.fn(async () => ({
      [signingName]: "ss",
      [tokenName]: "xoxb-1",
    }));
    const client = { getParameters };
    let clock = 1_000;
    const nowSeconds = () => clock;

    await getSlackCredentials(APP, { client, prefix: PREFIX, ttlSeconds: 60, nowSeconds });
    clock = 1_070; // past TTL
    await getSlackCredentials(APP, { client, prefix: PREFIX, ttlSeconds: 60, nowSeconds });
    expect(getParameters).toHaveBeenCalledTimes(2);
  });

  it("negative-caches a partially configured app", async () => {
    const getParameters = vi.fn(async () => ({ [signingName]: "ss" })); // token missing
    const client = { getParameters };
    let clock = 1_000;
    const nowSeconds = () => clock;

    const a = await getSlackCredentials(APP, {
      client,
      prefix: PREFIX,
      ttlSeconds: 60,
      nowSeconds,
    });
    expect(a).toBeNull();
    clock = 1_030;
    const b = await getSlackCredentials(APP, {
      client,
      prefix: PREFIX,
      ttlSeconds: 60,
      nowSeconds,
    });
    expect(b).toBeNull();
    expect(getParameters).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache transient SSM errors", async () => {
    const getParameters = vi
      .fn()
      .mockRejectedValueOnce(new Error("throttled"))
      .mockResolvedValueOnce({ [signingName]: "ss", [tokenName]: "xoxb-z" });
    const client = { getParameters };
    const nowSeconds = () => 1_000;

    const first = await getSlackCredentials(APP, {
      client,
      prefix: PREFIX,
      ttlSeconds: 60,
      nowSeconds,
    });
    expect(first).toBeNull();

    const second = await getSlackCredentials(APP, {
      client,
      prefix: PREFIX,
      ttlSeconds: 60,
      nowSeconds,
    });
    expect(second).toEqual({ signingSecret: "ss", botToken: "xoxb-z" });
    expect(getParameters).toHaveBeenCalledTimes(2);
  });

  it("invalidateSlackCredentials drops the cached entry", async () => {
    const getParameters = vi
      .fn()
      .mockResolvedValueOnce({ [signingName]: "ss", [tokenName]: "xoxb-old" })
      .mockResolvedValueOnce({ [signingName]: "ss", [tokenName]: "xoxb-new" });
    const client = { getParameters };
    const nowSeconds = () => 1_000;

    const first = await getSlackCredentials(APP, {
      client,
      prefix: PREFIX,
      ttlSeconds: 600,
      nowSeconds,
    });
    expect(first?.botToken).toBe("xoxb-old");
    invalidateSlackCredentials(APP);
    const second = await getSlackCredentials(APP, {
      client,
      prefix: PREFIX,
      ttlSeconds: 600,
      nowSeconds,
    });
    expect(second?.botToken).toBe("xoxb-new");
  });

  it("returns null for empty apiAppId without hitting SSM", async () => {
    const getParameters = vi.fn();
    const client = { getParameters };
    const r = await getSlackCredentials("", {
      client,
      prefix: PREFIX,
      ttlSeconds: 60,
      nowSeconds: () => 1,
    });
    expect(r).toBeNull();
    expect(getParameters).not.toHaveBeenCalled();
  });
});
