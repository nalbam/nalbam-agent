import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isDone, markDone, reserve } from "@/lib/slack/dedup";

const sendMock = vi.fn();

vi.mock("@/lib/dynamodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dynamodb")>();
  return {
    ...actual,
    getDocumentClient: () => ({ send: sendMock }),
    getTableName: () => "app-main-test",
  };
});

vi.mock("@/lib/dynamodb-helpers", () => ({
  getItem: vi.fn(),
}));

const { getItem } = await import("@/lib/dynamodb-helpers");

beforeEach(() => {
  sendMock.mockReset();
  vi.mocked(getItem).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("reserve", () => {
  it("returns true on first reservation and writes a TTL'd dedup row", async () => {
    sendMock.mockResolvedValueOnce({});
    const r = await reserve("A0XXX", "msg-1", "U999");
    expect(r).toBe(true);
    const call = sendMock.mock.calls[0]?.[0];
    expect(call).toBeInstanceOf(PutCommand);
    const input = (call as PutCommand).input;
    expect(input.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(input.Item?.entity).toBe("SLACK_DEDUP");
    expect(input.Item?.user).toBe("U999");
    expect(input.Item?.ttl).toBeTypeOf("number");
  });

  it("returns false when ConditionalCheckFailedException is thrown (concurrent reservation)", async () => {
    const err = new ConditionalCheckFailedException({
      $metadata: {},
      message: "exists",
    });
    sendMock.mockRejectedValueOnce(err);
    const r = await reserve("A0XXX", "msg-2");
    expect(r).toBe(false);
  });

  it("propagates non-conditional errors", async () => {
    sendMock.mockRejectedValueOnce(new Error("boom"));
    await expect(reserve("A0XXX", "msg-3")).rejects.toThrow("boom");
  });
});

describe("isDone", () => {
  it("returns true when a done row exists", async () => {
    vi.mocked(getItem).mockResolvedValueOnce({ ttl: 12345 });
    const r = await isDone("A0XXX", "msg-1");
    expect(r).toBe(true);
  });

  it("returns false when no done row exists", async () => {
    vi.mocked(getItem).mockResolvedValueOnce(null);
    const r = await isDone("A0XXX", "msg-1");
    expect(r).toBe(false);
  });

  it("returns false (does not throw) on DDB read failure", async () => {
    vi.mocked(getItem).mockRejectedValueOnce(new Error("ddb-down"));
    const r = await isDone("A0XXX", "msg-1");
    expect(r).toBe(false);
  });
});

describe("markDone", () => {
  it("writes the done row with TTL", async () => {
    sendMock.mockResolvedValueOnce({});
    await markDone("A0XXX", "msg-1", "U999");
    const input = (sendMock.mock.calls[0]?.[0] as PutCommand).input;
    expect(input.Item?.entity).toBe("SLACK_DONE");
    expect(input.Item?.user).toBe("U999");
    expect(input.ConditionExpression).toBeUndefined();
  });

  it("swallows write errors (non-fatal)", async () => {
    sendMock.mockRejectedValueOnce(new Error("ddb-down"));
    await expect(markDone("A0XXX", "msg-1")).resolves.toBeUndefined();
  });
});
