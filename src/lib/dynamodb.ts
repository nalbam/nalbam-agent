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

export const keys = {
  user: (userId: string) => ({
    PK: `USER#${validateId(userId)}`,
    SK: "PROFILE",
  }),
  project: (projectId: string) => ({
    PK: `PROJECT#${validateId(projectId)}`,
    SK: "META",
  }),
  userProject: (userId: string, projectId: string) => ({
    PK: `USER#${validateId(userId)}`,
    SK: `PROJECT#${validateId(projectId)}`,
  }),
};

export const gsi1 = {
  byEmail: (email: string) => ({
    GSI1PK: `EMAIL#${sanitizeKeyValue(email.toLowerCase())}`,
    GSI1SK: "USER",
  }),
};

export const ttlFromDate = (date: Date | string | number): number => {
  const ms = typeof date === "number" ? date : new Date(date).getTime();
  if (Number.isNaN(ms)) {
    throw new Error("ttlFromDate: invalid date input.");
  }
  return Math.floor(ms / 1000);
};

export type SingleTableItem =
  | ({ entity: "USER" } & ReturnType<typeof keys.user> & {
        id: string;
        name: string;
        email: string;
        createdAt: string;
      })
  | ({ entity: "PROJECT" } & ReturnType<typeof keys.project> & {
        id: string;
        title: string;
        description: string;
        createdAt: string;
      })
  | ({ entity: "USER_PROJECT" } & ReturnType<typeof keys.userProject> & {
        role: "owner" | "member";
        joinedAt: string;
      });
