/**
 * Creates the application table on DynamoDB Local (or any endpoint) with PK/SK,
 * GSI1, TTL, and cloud-man compatibility tags. Idempotent — safe to re-run.
 *
 * Usage:
 *   pnpm db:init
 *
 * Honors AWS_REGION, DYNAMODB_TABLE_NAME, and DYNAMODB_ENDPOINT from the
 * environment (typically loaded from .env.local via next/config or shell).
 *
 * Cloud-man (https://github.com/opspresso/cloud-man) recognizes tables it
 * manages by the `ManagedBy=CloudManager` tag. We tag every table this script
 * provisions the same way so it surfaces in the cloud-man UI alongside
 * tables created there. Tagging is skipped against DynamoDB Local (it doesn't
 * support TagResource).
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTagsOfResourceCommand,
  ResourceNotFoundException,
  TagResourceCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";

if (existsSync(".env.local")) {
  loadEnv({ path: ".env.local" });
} else if (existsSync(".env")) {
  loadEnv();
}

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const tableName = process.env.DYNAMODB_TABLE_NAME ?? "app-main";
const endpoint = process.env.DYNAMODB_ENDPOINT;
const isLocal = endpoint !== undefined;

const client = new DynamoDBClient({
  region,
  endpoint,
  credentials: isLocal ? { accessKeyId: "local", secretAccessKey: "local" } : undefined,
});

// cloud-man tag contract (see opspresso/cloud-man src/lib/constants.ts +
// src/lib/utils/tags.ts). `ManagedBy=CloudManager` is the discriminator the
// cloud-man UI filters on; the other tags are the same baseline cloud-man's
// own CreateTable applies via `createDefaultTags`. Created-At is intentionally
// generated per-run since cloud-man emits a fresh timestamp on each create —
// the value is informational, not authoritative.
const cloudManTags = (): Array<{ Key: string; Value: string }> => [
  { Key: "ManagedBy", Value: "CloudManager" },
  { Key: "Name", Value: tableName },
  { Key: "Resource-Type", Value: "dynamodb:table" },
  { Key: "Created-By", Value: "cloud-manager" },
  { Key: "Created-At", Value: new Date().toISOString() },
];

const describeTable = async () => {
  try {
    return await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return null;
    throw error;
  }
};

const createTable = async (): Promise<void> => {
  console.log(`[init-dynamodb] Creating table ${tableName}`);
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "GSI1PK", AttributeType: "S" },
        { AttributeName: "GSI1SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      // CreateTable supports inline Tags. DynamoDB Local ignores the field;
      // real AWS applies them atomically.
      Tags: cloudManTags(),
    }),
  );
  console.log(`[init-dynamodb] Submitted. Waiting for ACTIVE…`);
  // Real AWS DynamoDB returns from CreateTable while the table is still in
  // CREATING state — subsequent UpdateTimeToLive calls fail with
  // ResourceNotFoundException until it transitions to ACTIVE. DynamoDB Local
  // is instant, so this only matters against real AWS.
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: tableName });
  console.log(`[init-dynamodb] Active.`);
};

const ensureCloudManTags = async (tableArn: string): Promise<void> => {
  if (isLocal) {
    // DynamoDB Local responds with UnknownOperationException to TagResource.
    // No-op here; tagging only matters against real AWS where cloud-man reads.
    return;
  }
  try {
    const existing = await client.send(new ListTagsOfResourceCommand({ ResourceArn: tableArn }));
    const hasManagedBy = (existing.Tags ?? []).some(
      (t) => t.Key === "ManagedBy" && t.Value === "CloudManager",
    );
    if (hasManagedBy) {
      console.log(`[init-dynamodb] cloud-man tags already present.`);
      return;
    }
    await client.send(
      new TagResourceCommand({
        ResourceArn: tableArn,
        Tags: cloudManTags(),
      }),
    );
    console.log(`[init-dynamodb] Applied cloud-man tags (ManagedBy=CloudManager + defaults).`);
  } catch (error) {
    // Tagging is a nice-to-have for cloud-man visibility; never let it block
    // the script. Surface enough detail to debug if it matters.
    console.warn(
      `[init-dynamodb] Skipped cloud-man tagging: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const enableTtl = async (): Promise<void> => {
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: {
          AttributeName: "ttl",
          Enabled: true,
        },
      }),
    );
    console.log(`[init-dynamodb] TTL enabled on attribute "ttl".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("TimeToLive is already enabled")) {
      console.log(`[init-dynamodb] TTL already enabled.`);
      return;
    }
    if (isLocal && message.includes("UnknownOperationException")) {
      console.warn(`[init-dynamodb] DynamoDB Local doesn't support TTL — production will use it.`);
      return;
    }
    throw error;
  }
};

const main = async (): Promise<void> => {
  console.log(
    `[init-dynamodb] region=${region} endpoint=${endpoint ?? "(default)"} table=${tableName}`,
  );
  const existing = await describeTable();
  if (existing) {
    console.log(`[init-dynamodb] Table ${tableName} already exists.`);
    const arn = existing.Table?.TableArn;
    if (arn) await ensureCloudManTags(arn);
  } else {
    await createTable();
    // Re-describe to pick up the ARN now that the table is ACTIVE. We could
    // have captured it from CreateTable's response, but the post-wait describe
    // also confirms the final state.
    const created = await describeTable();
    const arn = created?.Table?.TableArn;
    if (arn) await ensureCloudManTags(arn);
  }
  await enableTtl();
  console.log(`[init-dynamodb] Done.`);
};

main().catch((error) => {
  console.error(`[init-dynamodb] Failed:`, error);
  process.exitCode = 1;
});
