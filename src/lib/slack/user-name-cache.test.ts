import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetUserNameCacheForTests,
  findUserIdByName,
  getUserName,
  setUserName,
  warmUserNames,
} from "@/lib/slack/user-name-cache";

type WebClientLike = {
  users: { info: ReturnType<typeof vi.fn> };
};

const buildClient = (overrides: Record<string, unknown> = {}): WebClientLike =>
  ({
    users: {
      info: vi.fn(async ({ user }: { user: string }) => ({
        user: {
          profile: {
            display_name: overrides[user] as string | undefined,
            real_name: undefined,
          },
        },
      })),
    },
  }) as WebClientLike;

beforeEach(() => {
  __resetUserNameCacheForTests();
});

describe("getUserName", () => {
  it("returns the display name and caches it", async () => {
    const client = buildClient({ U1: "alice" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await getUserName(client as any, "U1");
    expect(first).toBe("alice");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await getUserName(client as any, "U1");
    expect(second).toBe("alice");
    expect(client.users.info).toHaveBeenCalledTimes(1);
  });

  it("falls back to the user id on Slack error", async () => {
    const client = {
      users: { info: vi.fn().mockRejectedValueOnce(new Error("user_not_found")) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const name = await getUserName(client as any, "Uxxx");
    expect(name).toBe("Uxxx");
  });

  it("caches fallback so subsequent calls do not re-hit Slack", async () => {
    const client = {
      users: { info: vi.fn().mockRejectedValueOnce(new Error("user_not_found")) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getUserName(client as any, "Uxxx");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getUserName(client as any, "Uxxx");
    expect(client.users.info).toHaveBeenCalledTimes(1);
  });

  it("returns empty string for empty id without hitting Slack", async () => {
    const client = buildClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await getUserName(client as any, "")).toBe("");
    expect(client.users.info).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent lookups for the same id", async () => {
    const client = {
      users: {
        info: vi.fn(async ({ user }: { user: string }) => ({
          user: { profile: { display_name: `name-${user}` } },
        })),
      },
    };
    const [a, b] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getUserName(client as any, "U1"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getUserName(client as any, "U1"),
    ]);
    expect(a).toBe("name-U1");
    expect(b).toBe("name-U1");
    expect(client.users.info).toHaveBeenCalledTimes(1);
  });
});

describe("warmUserNames", () => {
  it("resolves multiple ids in parallel", async () => {
    const client = buildClient({ U1: "alice", U2: "bob", U3: "carol" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await warmUserNames(client as any, ["U1", "U2", "U3"]);
    expect(client.users.info).toHaveBeenCalledTimes(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await getUserName(client as any, "U2")).toBe("bob");
    // The lookup above is a cache hit and should not call Slack.
    expect(client.users.info).toHaveBeenCalledTimes(3);
  });

  it("skips already-cached ids", async () => {
    const client = buildClient({ U1: "alice", U2: "bob" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getUserName(client as any, "U1");
    expect(client.users.info).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await warmUserNames(client as any, ["U1", "U2"]);
    expect(client.users.info).toHaveBeenCalledTimes(2);
  });
});

describe("findUserIdByName / setUserName", () => {
  it("returns the matching user id when display name is cached", async () => {
    const client = buildClient({ U1: "alice" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getUserName(client as any, "U1");
    expect(findUserIdByName("alice")).toBe("U1");
    expect(findUserIdByName("unknown")).toBeUndefined();
  });

  it("setUserName seeds the cache without going to Slack", async () => {
    setUserName("U9", "dave");
    expect(findUserIdByName("dave")).toBe("U9");
  });
});
