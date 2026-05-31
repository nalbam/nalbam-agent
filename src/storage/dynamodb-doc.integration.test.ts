/**
 * Integration tests for the DynamoDB DocStore.
 * Requires DynamoDB Local at $DYNAMODB_ENDPOINT (or http://localhost:8000) with
 * the application table created (`pnpm db:init`). Skipped when unreachable
 * unless DDB_INTEGRATION_REQUIRED=true (CI). See dynamodb-adapter.integration.
 */

import { describe, expect, it } from "vitest";

import { getDynamoClient, getTableName } from "@/lib/dynamodb";
import { createDynamoDocStore } from "@/storage/dynamodb-doc";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";

const SUITE_TAG = `doc${Date.now().toString(36)}`;
const REQUIRED = process.env.DDB_INTEGRATION_REQUIRED === "true";

const isReachable = async (): Promise<boolean> => {
  try {
    await getDynamoClient().send(new DescribeTableCommand({ TableName: getTableName() }));
    return true;
  } catch (error) {
    if (!REQUIRED) {
      console.warn(
        `[dynamodb-doc.integration] Skipping: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return false;
  }
};

const available = REQUIRED ? true : await isReachable();

describe.skipIf(!available)("dynamodb-doc integration", () => {
  it("put/get round-trips with PK/SK, strips ttl metadata", async () => {
    const doc = createDynamoDocStore();
    const pk = `${SUITE_TAG}:tenant`;

    await doc.put(pk, "meta", { name: "Acme", count: 3 });
    const got = await doc.get(pk, "meta");

    expect(got).toMatchObject({ name: "Acme", count: 3, PK: pk, SK: "meta" });
    expect(got).not.toHaveProperty("expiresAt");
    expect(got).not.toHaveProperty("ttl");

    await doc.delete(pk, "meta");
  });

  it("update applies SET and REMOVE", async () => {
    const doc = createDynamoDocStore();
    const pk = `${SUITE_TAG}:upd`;

    await doc.put(pk, "row", { a: 1, b: 2 });
    await doc.update(pk, "row", { c: 3 }, ["a"]);
    const got = await doc.get(pk, "row");

    expect(got).toMatchObject({ b: 2, c: 3 });
    expect(got).not.toHaveProperty("a");

    await doc.delete(pk, "row");
  });

  it("query returns items by sk prefix, sorted", async () => {
    const doc = createDynamoDocStore();
    const pk = `${SUITE_TAG}:list`;

    await doc.put(pk, "item#2", { n: 2 });
    await doc.put(pk, "item#1", { n: 1 });
    await doc.put(pk, "other#1", { n: 9 });

    const items = await doc.query(pk, "item#");
    expect(items.map((i) => i.SK)).toEqual(["item#1", "item#2"]);

    await doc.delete(pk, "item#1");
    await doc.delete(pk, "item#2");
    await doc.delete(pk, "other#1");
  });

  it("honors lazy TTL expiry on get and query", async () => {
    let clock = 3_000_000;
    const doc = createDynamoDocStore(() => clock);
    const pk = `${SUITE_TAG}:ttl`;

    await doc.put(pk, "row", { v: 1 }, { ttlSeconds: 1 });
    expect(await doc.get(pk, "row")).toMatchObject({ v: 1 });

    clock += 2000;
    expect(await doc.get(pk, "row")).toBeNull();
    expect(await doc.query(pk, "row")).toEqual([]);

    await doc.delete(pk, "row");
  });
});
