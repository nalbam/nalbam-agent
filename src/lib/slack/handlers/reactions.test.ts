import { beforeEach, describe, expect, it, vi } from "vitest";

const reserveMock = vi.fn();
const isDoneMock = vi.fn();
const markDoneMock = vi.fn();
const getSlackAppMock = vi.fn();
const touchSlackAppMock = vi.fn();

vi.mock("@/lib/slack/dedup", () => ({
  reserve: (...args: unknown[]) => reserveMock(...args),
  isDone: (...args: unknown[]) => isDoneMock(...args),
  markDone: (...args: unknown[]) => markDoneMock(...args),
}));

vi.mock("@/lib/slack/app-metadata", () => ({
  getSlackApp: (...args: unknown[]) => getSlackAppMock(...args),
  touchSlackApp: (...args: unknown[]) => touchSlackAppMock(...args),
}));

const { handleReaction } = await import("@/lib/slack/handlers/reactions");
const { __resetServerEnvForTests } = await import("@/lib/env");

const stubAppRow = (overrides: Record<string, unknown> = {}) => ({
  apiAppId: "A0XXX",
  botUserId: "UBOT",
  firstSeenAt: 0,
  lastSeenAt: 0,
  ...overrides,
});

const makeClient = (overrides: Record<string, unknown> = {}) => {
  const conv = {
    history: vi.fn(async () => ({
      messages: [{ ts: "1700.001", thread_ts: "1700.000" }],
    })),
    replies: vi.fn(async () => ({
      messages: [{ user: "U_ASKER" }],
    })),
  };
  const chat = {
    delete: vi.fn(async () => ({ ok: true })),
  };
  return { conversations: conv, chat, ...overrides };
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetServerEnvForTests();
  isDoneMock.mockResolvedValue(false);
  reserveMock.mockResolvedValue(true);
  markDoneMock.mockResolvedValue(undefined);
  getSlackAppMock.mockResolvedValue(stubAppRow());
  touchSlackAppMock.mockResolvedValue(stubAppRow());
});

describe("handleReaction :x:", () => {
  it("deletes bot message when reactor is the original asker", async () => {
    const client = makeClient();
    await handleReaction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      event: {
        type: "reaction_added",
        reaction: "x",
        user: "U_ASKER",
        item_user: "UBOT",
        event_ts: "1700.999",
        item: { type: "message", channel: "C1", ts: "1700.001" },
      },
    });
    expect(client.chat.delete).toHaveBeenCalledTimes(1);
    expect(client.chat.delete).toHaveBeenCalledWith({ channel: "C1", ts: "1700.001" });
    expect(markDoneMock).toHaveBeenCalledTimes(1);
  });

  it("skips when item_user is not the bot", async () => {
    const client = makeClient();
    await handleReaction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      event: {
        type: "reaction_added",
        reaction: "x",
        user: "U_ASKER",
        item_user: "U_OTHER_BOT",
        event_ts: "1700.999",
        item: { type: "message", channel: "C1", ts: "1700.001" },
      },
    });
    expect(client.chat.delete).not.toHaveBeenCalled();
  });

  it("skips when bot user id is missing on the app row", async () => {
    getSlackAppMock.mockResolvedValueOnce({ ...stubAppRow(), botUserId: undefined });
    touchSlackAppMock.mockResolvedValueOnce({ ...stubAppRow(), botUserId: undefined });
    const client = makeClient();
    await handleReaction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      event: {
        type: "reaction_added",
        reaction: "x",
        user: "U_ASKER",
        item_user: "UBOT",
        event_ts: "1700.999",
        item: { type: "message", channel: "C1", ts: "1700.001" },
      },
    });
    expect(client.chat.delete).not.toHaveBeenCalled();
  });

  it("rejects unauthorized reactor (not asker, not in ALLOWED_USER_IDS)", async () => {
    const client = makeClient({
      conversations: {
        history: vi.fn(async () => ({ messages: [{ ts: "1700.001", thread_ts: "1700.000" }] })),
        replies: vi.fn(async () => ({ messages: [{ user: "U_ASKER" }] })),
      },
      chat: { delete: vi.fn(async () => ({ ok: true })) },
    });
    await handleReaction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      event: {
        type: "reaction_added",
        reaction: "x",
        user: "U_RANDO",
        item_user: "UBOT",
        event_ts: "1700.999",
        item: { type: "message", channel: "C1", ts: "1700.001" },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client.chat as any).delete).not.toHaveBeenCalled();
  });

  it("allows reactor on ALLOWED_USER_IDS env even if not the asker", async () => {
    const prev = process.env.ALLOWED_USER_IDS;
    process.env.ALLOWED_USER_IDS = "U_ADMIN";
    try {
      const client = makeClient();
      await handleReaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        apiAppId: "A0XXX",
        event: {
          type: "reaction_added",
          reaction: "x",
          user: "U_ADMIN",
          item_user: "UBOT",
          event_ts: "1700.999",
          item: { type: "message", channel: "C1", ts: "1700.001" },
        },
      });
      expect(client.chat.delete).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_USER_IDS;
      else process.env.ALLOWED_USER_IDS = prev;
    }
  });

  it("short-circuits when dedup is_done returns true", async () => {
    isDoneMock.mockResolvedValueOnce(true);
    const client = makeClient();
    await handleReaction({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      event: {
        type: "reaction_added",
        reaction: "x",
        user: "U_ASKER",
        item_user: "UBOT",
        event_ts: "1700.999",
        item: { type: "message", channel: "C1", ts: "1700.001" },
      },
    });
    expect(reserveMock).not.toHaveBeenCalled();
    expect(client.chat.delete).not.toHaveBeenCalled();
  });
});
