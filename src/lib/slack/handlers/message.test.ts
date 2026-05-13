import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (must register BEFORE the SUT is imported) ─────────────

// All mocks accept `(...args: unknown[])` so the inline wrappers below can
// forward via spread without TS narrowing complaints.
const runAgentMock = vi.fn<(...args: unknown[]) => unknown>();
const reserveMock = vi.fn<(...args: unknown[]) => unknown>();
const isDoneMock = vi.fn<(...args: unknown[]) => unknown>();
const markDoneMock = vi.fn<(...args: unknown[]) => unknown>();
const getSlackAppMock = vi.fn<(...args: unknown[]) => unknown>();
const touchSlackAppMock = vi.fn<(...args: unknown[]) => unknown>();
const loadThreadHistoryMock = vi.fn<(...args: unknown[]) => unknown>();
const saveThreadHistoryMock = vi.fn<(...args: unknown[]) => unknown>();
const warmUserNamesMock = vi.fn<(...args: unknown[]) => unknown>();
const getUserNameMock = vi.fn(async (_c: unknown, u: string) => u);
const setThreadStatusMock = vi.fn<(...args: unknown[]) => unknown>();
const checkThrottleMock = vi.fn<(...args: unknown[]) => unknown>();
const buildToolRegistryMock = vi.fn(() => ({}));
const getTextModelFromEnvMock = vi.fn(() => ({ name: "test-model" }));
const streamingMessageInstances: Array<{
  append: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  hasStarted: () => boolean;
}> = [];

vi.mock("@/lib/slack/agent", () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

vi.mock("@/lib/slack/dedup", () => ({
  reserve: (...args: unknown[]) => reserveMock(...args),
  isDone: (...args: unknown[]) => isDoneMock(...args),
  markDone: (...args: unknown[]) => markDoneMock(...args),
}));

vi.mock("@/lib/slack/app-metadata", () => ({
  getSlackApp: (...args: unknown[]) => getSlackAppMock(...args),
  touchSlackApp: (...args: unknown[]) => touchSlackAppMock(...args),
}));

vi.mock("@/lib/slack/conversation", () => ({
  loadThreadHistory: (...args: unknown[]) => loadThreadHistoryMock(...args),
  saveThreadHistory: (...args: unknown[]) => saveThreadHistoryMock(...args),
}));

vi.mock("@/lib/slack/user-name-cache", () => ({
  warmUserNames: (client: unknown, ids: unknown) => warmUserNamesMock(client, ids),
  getUserName: (client: unknown, userId: string) => getUserNameMock(client, userId),
}));

vi.mock("@/lib/slack/status", () => ({
  setThreadStatus: (...args: unknown[]) => setThreadStatusMock(...args),
}));

vi.mock("@/lib/slack/throttle", () => ({
  checkAndIncrementThrottle: (...args: unknown[]) => checkThrottleMock(...args),
}));

vi.mock("@/lib/slack/tools/registry", () => ({
  buildToolRegistry: (ctx: unknown) => {
    void ctx;
    return buildToolRegistryMock();
  },
}));

vi.mock("@/lib/llm/factory", () => ({
  getTextModelFromEnv: () => getTextModelFromEnvMock(),
}));

vi.mock("@/lib/slack/stream", () => {
  // Real class so `new StreamingMessage(...)` from the SUT works under
  // strict TS. Each instance pushes itself onto `streamingMessageInstances`
  // for assertions.
  class StreamingMessage {
    private started = false;
    append = vi.fn(async (delta: string) => {
      if (delta) this.started = true;
    });
    stop = vi.fn(async () => {});
    hasStarted = (): boolean => this.started;
    constructor() {
      streamingMessageInstances.push(this as unknown as (typeof streamingMessageInstances)[number]);
    }
  }
  return { StreamingMessage };
});

const { handleMessage } = await import("@/lib/slack/handlers/message");
const { __resetServerEnvForTests } = await import("@/lib/env");

// ── helpers ─────────────────────────────────────────────────────────────

const makeClient = () => ({
  chat: {
    postMessage: vi.fn(async () => ({ ok: true, ts: "1700.000" })),
  },
});

const stubAppRow = (overrides: Record<string, unknown> = {}) => ({
  apiAppId: "A0XXX",
  botUserId: "UBOT",
  firstSeenAt: 0,
  lastSeenAt: 0,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  streamingMessageInstances.length = 0;
  // env is cached on first read; ACL tests mutate process.env and need a
  // fresh re-parse each time.
  __resetServerEnvForTests();
  isDoneMock.mockResolvedValue(false);
  reserveMock.mockResolvedValue(true);
  markDoneMock.mockResolvedValue(undefined);
  loadThreadHistoryMock.mockResolvedValue({ messages: [], version: 0 });
  saveThreadHistoryMock.mockResolvedValue({ ok: true });
  warmUserNamesMock.mockResolvedValue(undefined);
  setThreadStatusMock.mockResolvedValue(undefined);
  touchSlackAppMock.mockResolvedValue(stubAppRow());
  getSlackAppMock.mockResolvedValue(stubAppRow());
  checkThrottleMock.mockResolvedValue({ allowed: true, release: async () => {} });
  runAgentMock.mockResolvedValue({
    text: "hello world",
    steps: 1,
    toolCallCount: 0,
    tokensIn: 10,
    tokensOut: 5,
    forcedCompose: false,
  });
});

// ── tests ───────────────────────────────────────────────────────────────

describe("handleMessage", () => {
  it("happy path: dedup → ACL pass → agent → stream stop → save → markDone", async () => {
    const client = makeClient();
    await handleMessage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      isDm: false,
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "1700.000",
        user: "U1",
        text: "<@UBOT> hello",
        client_msg_id: "cmid-1",
      },
    });

    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(touchSlackAppMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(saveThreadHistoryMock).toHaveBeenCalledTimes(1);
    expect(markDoneMock).toHaveBeenCalledTimes(1);
    // OCC version was threaded through.
    expect(saveThreadHistoryMock.mock.calls[0]?.[3]).toMatchObject({ expectedVersion: 0 });
  });

  it("bails on empty text BEFORE reserving dedup", async () => {
    const client = makeClient();
    await handleMessage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      isDm: false,
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "1700.000",
        user: "U1",
        // Only the bot mention — empty after strip.
        text: "<@UBOT>",
      },
    });
    expect(reserveMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("short-circuits when dedup is_done returns true", async () => {
    isDoneMock.mockResolvedValueOnce(true);
    const client = makeClient();
    await handleMessage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      isDm: false,
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "1700.000",
        user: "U1",
        text: "<@UBOT> hello",
        client_msg_id: "cmid-1",
      },
    });
    expect(reserveMock).not.toHaveBeenCalled();
    expect(touchSlackAppMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("touchSlackApp runs AFTER dedup passes (not before)", async () => {
    const order: string[] = [];
    reserveMock.mockImplementationOnce(async () => {
      order.push("reserve");
      return true;
    });
    touchSlackAppMock.mockImplementationOnce(async () => {
      order.push("touch");
      return stubAppRow();
    });
    const client = makeClient();
    await handleMessage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      isDm: false,
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "1700.000",
        user: "U1",
        text: "<@UBOT> hello",
        client_msg_id: "cmid-1",
      },
    });
    expect(order).toEqual(["reserve", "touch"]);
  });

  it("channel-blocked: posts deny message and does NOT run agent", async () => {
    // Stash original env var so other tests aren't affected.
    const prev = process.env.ALLOWED_CHANNEL_IDS;
    process.env.ALLOWED_CHANNEL_IDS = "C_ALLOWED";
    try {
      const client = makeClient();
      await handleMessage({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        apiAppId: "A0XXX",
        isDm: false,
        event: {
          type: "app_mention",
          channel: "C_NOT_ON_LIST",
          ts: "1700.000",
          user: "U1",
          text: "<@UBOT> hello",
          client_msg_id: "cmid-2",
        },
      });
      expect(runAgentMock).not.toHaveBeenCalled();
      // Deny message posted (template falls back to default Korean).
      expect(client.chat.postMessage).toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_CHANNEL_IDS;
      else process.env.ALLOWED_CHANNEL_IDS = prev;
    }
  });

  it("user-blocked: silent drop — no chat.postMessage, no agent", async () => {
    const prev = process.env.ALLOWED_USER_IDS;
    process.env.ALLOWED_USER_IDS = "UWHITELIST";
    try {
      const client = makeClient();
      await handleMessage({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: client as any,
        apiAppId: "A0XXX",
        isDm: false,
        event: {
          type: "app_mention",
          channel: "C1",
          ts: "1700.000",
          user: "U_BLOCKED",
          text: "<@UBOT> hello",
          client_msg_id: "cmid-3",
        },
      });
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.ALLOWED_USER_IDS;
      else process.env.ALLOWED_USER_IDS = prev;
    }
  });

  it("throttled: posts throttle notice, does NOT run agent, release is no-op", async () => {
    checkThrottleMock.mockResolvedValueOnce({ allowed: false, release: async () => {} });
    const client = makeClient();
    await handleMessage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      isDm: false,
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "1700.000",
        user: "U1",
        text: "<@UBOT> hello",
        client_msg_id: "cmid-4",
      },
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("releases throttle even when agent throws", async () => {
    const release = vi.fn(async () => {});
    checkThrottleMock.mockResolvedValueOnce({ allowed: true, release });
    runAgentMock.mockRejectedValueOnce(new Error("LLM kaboom"));
    const client = makeClient();
    await handleMessage({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      apiAppId: "A0XXX",
      isDm: false,
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "1700.000",
        user: "U1",
        text: "<@UBOT> hello",
        client_msg_id: "cmid-5",
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
