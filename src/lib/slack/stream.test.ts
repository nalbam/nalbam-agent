import { beforeEach, describe, expect, it, vi } from "vitest";

import { StreamingMessage } from "@/lib/slack/stream";

interface MockClient {
  chat: {
    postMessage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
}

const buildClient = (): MockClient => ({
  chat: {
    postMessage: vi.fn(async () => ({ ok: true, ts: `t${Math.random()}` })),
    update: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
  },
});

const buildStreaming = (
  client: MockClient,
  overrides: Partial<ConstructorParameters<typeof StreamingMessage>[0]> = {},
) =>
  new StreamingMessage({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    channel: "C123",
    threadTs: "1700.000",
    placeholder: ":robot_face:",
    minIntervalMs: 100,
    maxLen: 100,
    nowMs: () => 0,
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StreamingMessage", () => {
  it("opens placeholder lazily — never on empty deltas", async () => {
    const client = buildClient();
    const s = buildStreaming(client);
    await s.append("");
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(s.hasStarted()).toBe(false);
  });

  it("opens placeholder on first real delta", async () => {
    const client = buildClient();
    const s = buildStreaming(client);
    await s.append("hello");
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(s.hasStarted()).toBe(true);
  });

  it("throttles chat.update by minIntervalMs", async () => {
    const client = buildClient();
    let clock = 0;
    const s = buildStreaming(client, { nowMs: () => clock, minIntervalMs: 100 });

    clock = 0;
    await s.append("first ");
    expect(client.chat.update).not.toHaveBeenCalled(); // open + first deltas under throttle
    clock = 50;
    await s.append("more ");
    expect(client.chat.update).not.toHaveBeenCalled();
    clock = 200;
    await s.append("end");
    expect(client.chat.update).toHaveBeenCalledTimes(1);
  });

  it("on stop() splits final text — first into placeholder, rest as new messages", async () => {
    const client = buildClient();
    const s = buildStreaming(client, { maxLen: 30 });
    await s.append("seed ");
    client.chat.update.mockClear();
    client.chat.postMessage.mockClear();
    const final = "A".repeat(25) + "\n\n" + "B".repeat(25) + "\n\n" + "C".repeat(25);
    await s.stop(final);
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    // remaining chunks posted as new thread messages
    expect(client.chat.postMessage.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to postMessage on final update error", async () => {
    const client = buildClient();
    client.chat.update.mockRejectedValueOnce(new Error("boom"));
    const s = buildStreaming(client, { maxLen: 30 });
    await s.append("seed ");
    client.chat.postMessage.mockClear();
    await s.stop("hello");
    // Placeholder gets deleted + first chunk posted fresh.
    expect(client.chat.delete).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalled();
  });

  it("recovers from msg_too_long via chat.postMessage spill", async () => {
    const client = buildClient();
    const tooLong = {
      data: { error: "msg_too_long" },
      message: "msg_too_long",
    };
    client.chat.update.mockRejectedValueOnce(tooLong);
    let clock = 0;
    const s = buildStreaming(client, { nowMs: () => clock, minIntervalMs: 10, maxLen: 50 });
    clock = 0;
    await s.append("seed "); // opens placeholder
    clock = 50;
    await s.append("more content here"); // forces flush → msg_too_long
    expect(client.chat.delete).toHaveBeenCalledTimes(1);
    // After spill the ts is reset; the next delta should open a fresh placeholder
    client.chat.postMessage.mockClear();
    clock = 200;
    await s.append("next");
    expect(client.chat.postMessage).toHaveBeenCalled();
  });

  it("rolls over to a new placeholder when display approaches maxLen", async () => {
    const client = buildClient();
    let clock = 0;
    const s = buildStreaming(client, {
      nowMs: () => clock,
      minIntervalMs: 10,
      maxLen: 80,
    });
    clock = 0;
    await s.append("first paragraph.\n\nsecond paragraph that is quite long.\n\n");
    clock = 50;
    await s.append("third paragraph that finally tips it over the limit.");
    // At least one chat.update (the seal) and a second chat.postMessage (roll).
    expect(client.chat.update.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(client.chat.postMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("never calls Slack after stop()", async () => {
    const client = buildClient();
    const s = buildStreaming(client);
    await s.append("hi");
    await s.stop("hi");
    const updateCalls = client.chat.update.mock.calls.length;
    const postCalls = client.chat.postMessage.mock.calls.length;
    await s.append("ignored");
    await s.stop("also ignored");
    expect(client.chat.update.mock.calls.length).toBe(updateCalls);
    expect(client.chat.postMessage.mock.calls.length).toBe(postCalls);
  });
});
