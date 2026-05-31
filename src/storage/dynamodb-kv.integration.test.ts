/**
 * Integration tests for the DynamoDB KvStore.
 * Requires DynamoDB Local at $DYNAMODB_ENDPOINT (or http://localhost:8000) with
 * the application table created (`pnpm db:init`). Skipped when unreachable
 * unless DDB_INTEGRATION_REQUIRED=true (CI). See dynamodb-adapter.integration.
 */

import { describe, expect, it } from "vitest";

import { getDynamoClient, getTableName } from "@/lib/dynamodb";
import { createDynamoKv } from "@/storage/dynamodb-kv";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";

const SUITE_TAG = `kv${Date.now().toString(36)}`;
const REQUIRED = process.env.DDB_INTEGRATION_REQUIRED === "true";

const isReachable = async (): Promise<boolean> => {
  try {
    await getDynamoClient().send(new DescribeTableCommand({ TableName: getTableName() }));
    return true;
  } catch (error) {
    if (!REQUIRED) {
      console.warn(
        `[dynamodb-kv.integration] Skipping: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return false;
  }
};

const available = REQUIRED ? true : await isReachable();

describe.skipIf(!available)("dynamodb-kv integration", () => {
  it("setNx reserves once, refuses while live, re-reserves after expiry", async () => {
    let clock = 1_000_000;
    const kv = createDynamoKv(() => clock);
    const key = `${SUITE_TAG}:setnx`;

    expect(await kv.setNx(key, "1", 1)).toBe(true);
    expect(await kv.setNx(key, "1", 1)).toBe(false);

    clock += 2000; // past the 1s TTL → the existing item is now stale
    expect(await kv.setNx(key, "1", 1)).toBe(true);

    await kv.del(key);
  });

  it("get/set round-trips and honors lazy TTL expiry", async () => {
    let clock = 2_000_000;
    const kv = createDynamoKv(() => clock);
    const persistent = `${SUITE_TAG}:persist`;
    const ephemeral = `${SUITE_TAG}:ephemeral`;

    await kv.set(persistent, "forever");
    expect(await kv.get(persistent)).toBe("forever");

    await kv.set(ephemeral, "soon", 1);
    expect(await kv.get(ephemeral)).toBe("soon");
    clock += 2000;
    expect(await kv.get(ephemeral)).toBeNull();

    await kv.del(persistent);
  });

  it("incr/decr are atomic counters", async () => {
    const kv = createDynamoKv();
    const key = `${SUITE_TAG}:counter`;
    await kv.del(key);

    expect(await kv.incr(key)).toBe(1);
    expect(await kv.incr(key)).toBe(2);
    expect(await kv.decr(key)).toBe(1);

    await kv.del(key);
  });

  it("expire on a missing key is a no-op", async () => {
    const kv = createDynamoKv();
    const key = `${SUITE_TAG}:missing`;
    await kv.del(key);

    await expect(kv.expire(key, 10)).resolves.toBeUndefined();
    expect(await kv.get(key)).toBeNull();
  });
});
