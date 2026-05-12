/**
 * Integration tests for the DynamoDB single-table adapter.
 * Requires DynamoDB Local running at $DYNAMODB_ENDPOINT (or http://localhost:8000)
 * with the application table created (`pnpm db:init`).
 *
 * By default the suite is skipped via `describe.skipIf(!available)` when the
 * endpoint is unreachable, so `pnpm test` is safe to run without docker. Set
 * `DDB_INTEGRATION_REQUIRED=true` (CI) to flip that to a hard failure when
 * the endpoint is missing — the suite then runs unconditionally and the very
 * first test fails loudly on the unreachable DDB call.
 */

import { describe, expect, it } from "vitest";

import { dynamodbAdapter } from "@/lib/auth/dynamodb-adapter";
import { getDynamoClient, getTableName } from "@/lib/dynamodb";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";

const SUITE_TAG = `it${Date.now().toString(36)}`;
const REQUIRED = process.env.DDB_INTEGRATION_REQUIRED === "true";

const isReachable = async (): Promise<boolean> => {
  try {
    await getDynamoClient().send(new DescribeTableCommand({ TableName: getTableName() }));
    return true;
  } catch (error) {
    if (!REQUIRED) {
      console.warn(
        `[dynamodb-adapter.integration] Skipping: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return false;
  }
};

// Top-level await: vitest 4 + Node ESM resolves this before describe/it run,
// so `describe.skipIf(...)` sees a real boolean and skips the whole block
// instead of running each `it` against a closed-over flag that everyone
// re-checks at runtime (the old `if (!available) return` pattern silently
// turned every assertion into a no-op when DDB Local was missing).
const available = REQUIRED ? true : await isReachable();

describe.skipIf(!available)("dynamodb-adapter integration", () => {
  const adapter = dynamodbAdapter({
    appName: "test",
  } as never);

  const userId = `${SUITE_TAG}_user_a`;
  const sessionId = `${SUITE_TAG}_sess_a`;
  const accountId = `${SUITE_TAG}_acct_a`;
  const verificationId = `${SUITE_TAG}_verif_a`;

  it("creates and retrieves a user by email and id", async () => {
    const data = {
      id: userId,
      email: "user-a@example.com",
      emailVerified: false,
      name: "User A",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const created = await adapter.create({ model: "user", data });
    expect((created as { id: string }).id).toBe(userId);

    const byEmail = await adapter.findOne({
      model: "user",
      where: [
        {
          field: "email",
          value: "user-a@example.com",
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
      ],
    });
    expect(byEmail).not.toBeNull();
    expect((byEmail as { id: string }).id).toBe(userId);

    const byId = await adapter.findOne({
      model: "user",
      where: [{ field: "id", value: userId, operator: "eq", connector: "AND", mode: "sensitive" }],
    });
    expect(byId).not.toBeNull();
    expect((byId as { email: string }).email).toBe("user-a@example.com");
  });

  it("updates and deletes a user", async () => {
    const updated = await adapter.update({
      model: "user",
      where: [{ field: "id", value: userId, operator: "eq", connector: "AND", mode: "sensitive" }],
      update: { name: "User A renamed" },
    });
    expect((updated as { name: string }).name).toBe("User A renamed");

    await adapter.delete({
      model: "user",
      where: [{ field: "id", value: userId, operator: "eq", connector: "AND", mode: "sensitive" }],
    });

    const after = await adapter.findOne({
      model: "user",
      where: [{ field: "id", value: userId, operator: "eq", connector: "AND", mode: "sensitive" }],
    });
    expect(after).toBeNull();
  });

  it("creates a session and finds it by token", async () => {
    const expires = new Date(Date.now() + 3600_000);
    await adapter.create({
      model: "session",
      data: {
        id: sessionId,
        userId: "user-x",
        token: `${SUITE_TAG}_token`,
        expiresAt: expires,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const byToken = await adapter.findOne({
      model: "session",
      where: [
        {
          field: "token",
          value: `${SUITE_TAG}_token`,
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
      ],
    });
    expect(byToken).not.toBeNull();
    expect((byToken as { id: string }).id).toBe(sessionId);

    await adapter.delete({
      model: "session",
      where: [
        { field: "id", value: sessionId, operator: "eq", connector: "AND", mode: "sensitive" },
      ],
    });
  });

  it("creates an account and finds it by providerId+accountId", async () => {
    await adapter.create({
      model: "account",
      data: {
        id: accountId,
        userId: "user-x",
        providerId: "credential",
        accountId: `${SUITE_TAG}_acct_remote`,
        password: "hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const found = await adapter.findOne({
      model: "account",
      where: [
        {
          field: "providerId",
          value: "credential",
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
        {
          field: "accountId",
          value: `${SUITE_TAG}_acct_remote`,
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
      ],
    });
    expect(found).not.toBeNull();
    expect((found as { id: string }).id).toBe(accountId);

    await adapter.delete({
      model: "account",
      where: [
        { field: "id", value: accountId, operator: "eq", connector: "AND", mode: "sensitive" },
      ],
    });
  });

  it("creates a verification, finds it by identifier, and deletes it", async () => {
    const identifier = `${SUITE_TAG}_verify@example.com`;
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await adapter.create({
      model: "verification",
      data: {
        id: verificationId,
        identifier,
        value: "token-value-12345",
        expiresAt: expires,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const byIdentifier = await adapter.findOne({
      model: "verification",
      where: [
        {
          field: "identifier",
          value: identifier,
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
      ],
    });
    expect(byIdentifier).not.toBeNull();
    expect((byIdentifier as { id: string }).id).toBe(verificationId);

    await adapter.delete({
      model: "verification",
      where: [
        {
          field: "id",
          value: verificationId,
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
      ],
    });

    const after = await adapter.findOne({
      model: "verification",
      where: [
        {
          field: "id",
          value: verificationId,
          operator: "eq",
          connector: "AND",
          mode: "sensitive",
        },
      ],
    });
    expect(after).toBeNull();
  });
});
