import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { getServerEnv } from "@/lib/env";

let cachedClient: DynamoDBClient | undefined;
let cachedDocumentClient: DynamoDBDocumentClient | undefined;

const buildClient = (): DynamoDBClient => {
  const env = getServerEnv();
  return new DynamoDBClient({
    region: env.AWS_REGION,
    endpoint: env.DYNAMODB_ENDPOINT,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
};

export const getDynamoClient = (): DynamoDBClient => {
  if (cachedClient) return cachedClient;
  cachedClient = buildClient();
  return cachedClient;
};

export const getDocumentClient = (): DynamoDBDocumentClient => {
  if (cachedDocumentClient) return cachedDocumentClient;
  cachedDocumentClient = DynamoDBDocumentClient.from(getDynamoClient(), {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });
  return cachedDocumentClient;
};

export const getTableName = (): string => getServerEnv().DYNAMODB_TABLE_NAME;

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const hasControlChar = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

export const validateId = (id: string): string => {
  if (id.length === 0) {
    throw new Error("Invalid id: must be non-empty.");
  }
  if (id.length > 256) {
    throw new Error("Invalid id length. Maximum length is 256 characters.");
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(
      "Invalid id format. Only letters, numbers, underscores, and hyphens are allowed.",
    );
  }
  return id;
};

export const sanitizeKeyValue = (value: string): string => {
  if (value.length === 0) {
    throw new Error("Key value must be non-empty.");
  }
  if (value.length > 1024) {
    throw new Error("Key value exceeds 1024 characters.");
  }
  if (hasControlChar(value)) {
    throw new Error("Key value must not contain control characters.");
  }
  return value;
};

// Slack identifiers (api_app_id, channel/user IDs, client_msg_id) are not
// guaranteed to match the strict alphanumeric `validateId` pattern (e.g.
// thread_ts contains a dot, client_msg_id may contain hyphens but Slack also
// emits UUIDs). `sanitizeKeyValue` is the right gate: it blocks control chars
// and 1024-char overruns without forbidding `.` or `:`.
export const keys = {
  slackApp: (apiAppId: string) => ({
    PK: `SLACK_APP#${sanitizeKeyValue(apiAppId)}`,
    SK: "META",
  }),
  slackDedup: (apiAppId: string, eventKey: string) => ({
    PK: `SLACK_DEDUP#${sanitizeKeyValue(apiAppId)}#${sanitizeKeyValue(eventKey)}`,
    SK: "META",
  }),
  slackDone: (apiAppId: string, eventKey: string) => ({
    PK: `SLACK_DONE#${sanitizeKeyValue(apiAppId)}#${sanitizeKeyValue(eventKey)}`,
    SK: "META",
  }),
  slackThread: (apiAppId: string, threadTs: string) => ({
    PK: `SLACK_THREAD#${sanitizeKeyValue(apiAppId)}#${sanitizeKeyValue(threadTs)}`,
    SK: "META",
  }),
};

export const gsi1 = {
  bySlackTeam: (teamId: string) => ({
    GSI1PK: `SLACK_APP:TEAM#${sanitizeKeyValue(teamId)}`,
    GSI1SK: "SLACK_APP",
  }),
};

export const ttlFromDate = (date: Date | string | number): number => {
  const ms = typeof date === "number" ? date : new Date(date).getTime();
  if (Number.isNaN(ms)) {
    throw new Error("ttlFromDate: invalid date input.");
  }
  return Math.floor(ms / 1000);
};
