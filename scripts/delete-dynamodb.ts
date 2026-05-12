/**
 * Deletes the application table.
 *
 * Safety rails:
 *   - Real AWS: refuses unless the table carries the cloud-man
 *     `ManagedBy=CloudManager` tag (the same one `pnpm db:init` applies).
 *     This stops us from nuking a pre-existing table that wasn't created by
 *     this starter / cloud-man.
 *   - Interactive shells: prompts for the table name to be retyped.
 *   - Non-interactive (CI, piped): require `DDB_DELETE_CONFIRM=<table name>`.
 *
 * Usage:
 *   pnpm db:delete
 *   DDB_DELETE_CONFIRM=Demo-dev pnpm db:delete       # non-interactive
 *
 * Honors AWS_REGION, DYNAMODB_TABLE_NAME, and DYNAMODB_ENDPOINT from the
 * environment (loaded from .env.local).
 */

import {
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTagsOfResourceCommand,
  ResourceNotFoundException,
  waitUntilTableNotExists,
} from "@aws-sdk/client-dynamodb";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

if (existsSync(".env.local")) {
  loadEnv({ path: ".env.local" });
} else if (existsSync(".env")) {
  loadEnv();
}

const region = process.env.AWS_REGION ?? "ap-northeast-2";
const tableName = process.env.DYNAMODB_TABLE_NAME ?? "app-main";
const endpoint = process.env.DYNAMODB_ENDPOINT;
const isLocal = endpoint !== undefined;
const confirmEnv = process.env.DDB_DELETE_CONFIRM;

const client = new DynamoDBClient({
  region,
  endpoint,
  credentials: isLocal ? { accessKeyId: "local", secretAccessKey: "local" } : undefined,
});

const describeTable = async () => {
  try {
    return await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return null;
    throw error;
  }
};

const isCloudManManaged = async (tableArn: string): Promise<boolean> => {
  if (isLocal) {
    // DynamoDB Local doesn't expose tags; trust the caller's confirmation.
    return true;
  }
  try {
    const result = await client.send(new ListTagsOfResourceCommand({ ResourceArn: tableArn }));
    return (result.Tags ?? []).some((t) => t.Key === "ManagedBy" && t.Value === "CloudManager");
  } catch (error) {
    console.error(
      `[delete-dynamodb] Failed to read tags: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
};

const promptConfirmation = async (): Promise<boolean> => {
  if (confirmEnv !== undefined) {
    if (confirmEnv !== tableName) {
      console.error(
        `[delete-dynamodb] DDB_DELETE_CONFIRM=${confirmEnv} does not match target table ${tableName}.`,
      );
      return false;
    }
    return true;
  }
  if (!input.isTTY) {
    console.error(
      `[delete-dynamodb] Non-interactive shell. Set DDB_DELETE_CONFIRM=${tableName} to proceed.`,
    );
    return false;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `[delete-dynamodb] Type the table name (${tableName}) to confirm deletion: `,
    );
    return answer.trim() === tableName;
  } finally {
    rl.close();
  }
};

const deleteTable = async (): Promise<void> => {
  console.log(`[delete-dynamodb] Deleting ${tableName}…`);
  await client.send(new DeleteTableCommand({ TableName: tableName }));
  console.log(`[delete-dynamodb] Submitted. Waiting for the table to disappear…`);
  await waitUntilTableNotExists({ client, maxWaitTime: 300 }, { TableName: tableName });
  console.log(`[delete-dynamodb] Gone.`);
};

const main = async (): Promise<void> => {
  console.log(
    `[delete-dynamodb] region=${region} endpoint=${endpoint ?? "(default)"} table=${tableName}`,
  );
  const existing = await describeTable();
  if (!existing) {
    console.log(`[delete-dynamodb] Table ${tableName} does not exist — nothing to do.`);
    return;
  }

  const arn = existing.Table?.TableArn;
  if (!arn) {
    console.error(`[delete-dynamodb] DescribeTable returned no ARN. Aborting.`);
    process.exitCode = 1;
    return;
  }

  if (!(await isCloudManManaged(arn))) {
    console.error(
      `[delete-dynamodb] Refusing to delete ${tableName}: missing 'ManagedBy=CloudManager' tag.\n` +
        `  This safety check stops us from removing tables created outside cloud-man / this starter.\n` +
        `  If you really want to delete it, add the tag via the AWS console or cloud-man UI first.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!(await promptConfirmation())) {
    console.error(`[delete-dynamodb] Confirmation failed. Aborting.`);
    process.exitCode = 1;
    return;
  }

  await deleteTable();
};

main().catch((error) => {
  console.error(`[delete-dynamodb] Failed:`, error);
  process.exitCode = 1;
});
