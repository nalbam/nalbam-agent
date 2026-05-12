/**
 * Better Auth DynamoDB single-table adapter.
 *
 * Single-table layout (see docs/dynamodb-schema.md):
 *   PK = "<MODEL>#<id>", SK = "META"
 *   GSI1: secondary lookup keyed per entity (email/token/identifier/provider+account)
 *   Optional `ttl` (epoch seconds) for sessions and verifications
 *
 * Where clause routing:
 *   1. PK lookup (id eq + no other clauses) → GetItem
 *   2. Known GSI1 lookup (email/token/etc.) → Query GSI1, then in-memory filter
 *   3. Otherwise → Scan + in-memory filter (rare for Better Auth's call patterns)
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { createAdapterFactory, type CleanedWhere } from "better-auth/adapters";

import { getDocumentClient, getTableName, ttlFromDate } from "@/lib/dynamodb";
import { logger } from "@/lib/logger";

type Item = Record<string, unknown>;

interface PrimaryKey {
  PK: string;
  SK: string;
}

interface GSI1Key {
  GSI1PK: string;
  GSI1SK: string;
}

const ENTITY_PREFIX: Record<string, string> = {
  user: "USER",
  session: "SESSION",
  account: "ACCOUNT",
  verification: "VERIFICATION",
};

const SK_META = "META";

const entityPrefix = (model: string): string =>
  ENTITY_PREFIX[model] ?? model.toUpperCase().replaceAll("-", "_");

const buildPrimaryKey = (model: string, id: string | number): PrimaryKey => ({
  PK: `${entityPrefix(model)}#${id}`,
  SK: SK_META,
});

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const buildGSI1Key = (model: string, data: Item): GSI1Key | null => {
  switch (model) {
    case "user": {
      const email = stringValue(data["email"]);
      if (!email) return null;
      return { GSI1PK: `USER:EMAIL#${email.toLowerCase()}`, GSI1SK: "USER" };
    }
    case "session": {
      const token = stringValue(data["token"]);
      if (!token) return null;
      return { GSI1PK: `SESSION:TOKEN#${token}`, GSI1SK: "SESSION" };
    }
    case "account": {
      const providerId = stringValue(data["providerId"]);
      const accountId = stringValue(data["accountId"]);
      if (!providerId || !accountId) return null;
      return {
        GSI1PK: `ACCOUNT:PROVIDER#${providerId}#${accountId}`,
        GSI1SK: "ACCOUNT",
      };
    }
    case "verification": {
      const identifier = stringValue(data["identifier"]);
      if (!identifier) return null;
      return { GSI1PK: `VERIFICATION:IDENT#${identifier}`, GSI1SK: "VERIFICATION" };
    }
    default:
      return null;
  }
};

const buildTtl = (model: string, data: Item): number | undefined => {
  if (model !== "session" && model !== "verification") return undefined;
  const expiresAt = data["expiresAt"];
  if (expiresAt instanceof Date) return ttlFromDate(expiresAt);
  if (typeof expiresAt === "string" || typeof expiresAt === "number") {
    return ttlFromDate(expiresAt);
  }
  return undefined;
};

const stripInternalKeys = (item: Item): Item => {
  const { PK, SK, GSI1PK, GSI1SK, ttl, entity, ...rest } = item;
  void PK;
  void SK;
  void GSI1PK;
  void GSI1SK;
  void ttl;
  void entity;
  return rest;
};

// Exported for unit tests only. Treat as an internal helper.
export const evalClause = (record: Item, clause: CleanedWhere): boolean => {
  const { field, value, operator, mode } = clause;
  const recordValue = record[field];
  const insensitive =
    mode === "insensitive" &&
    (typeof value === "string" ||
      (Array.isArray(value) && value.every((v) => typeof v === "string")));
  const lower = (v: unknown): unknown =>
    insensitive && typeof v === "string" ? v.toLowerCase() : v;

  switch (operator) {
    case "in":
      if (!Array.isArray(value)) throw new Error("`in` operator requires array value");
      if (insensitive) {
        const lc = (value as string[]).map((v) => v.toLowerCase());
        return typeof recordValue === "string" && lc.includes(recordValue.toLowerCase());
      }
      return (value as Array<string | number>).includes(recordValue as string | number);
    case "not_in":
      if (!Array.isArray(value)) throw new Error("`not_in` operator requires array value");
      if (insensitive) {
        const lc = (value as string[]).map((v) => v.toLowerCase());
        return !(typeof recordValue === "string" && lc.includes(recordValue.toLowerCase()));
      }
      return !(value as Array<string | number>).includes(recordValue as string | number);
    case "contains":
      if (typeof recordValue !== "string" || typeof value !== "string") return false;
      return insensitive
        ? recordValue.toLowerCase().includes(value.toLowerCase())
        : recordValue.includes(value);
    case "starts_with":
      if (typeof recordValue !== "string" || typeof value !== "string") return false;
      return insensitive
        ? recordValue.toLowerCase().startsWith(value.toLowerCase())
        : recordValue.startsWith(value);
    case "ends_with":
      if (typeof recordValue !== "string" || typeof value !== "string") return false;
      return insensitive
        ? recordValue.toLowerCase().endsWith(value.toLowerCase())
        : recordValue.endsWith(value);
    case "ne":
      return lower(recordValue) !== lower(value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof recordValue !== "number" || typeof value !== "number") return false;
      if (operator === "gt") return recordValue > value;
      if (operator === "gte") return recordValue >= value;
      if (operator === "lt") return recordValue < value;
      return recordValue <= value;
    }
    case "eq":
    default:
      return lower(recordValue) === lower(value);
  }
};

// Exported for unit tests only. Treat as an internal helper.
export const matchesAll = (record: Item, where: CleanedWhere[]): boolean => {
  if (where.length === 0) return true;
  const first = where[0];
  if (!first) return true;
  let result = evalClause(record, first);
  for (let i = 1; i < where.length; i++) {
    const clause = where[i];
    if (!clause) continue;
    const current = evalClause(record, clause);
    result = clause.connector === "OR" ? result || current : result && current;
  }
  return result;
};

interface GSI1Lookup {
  gsi1pk: string;
  gsi1sk?: string;
}

const tryGSI1Lookup = (model: string, where: CleanedWhere[]): GSI1Lookup | null => {
  const eq = (field: string): string | null => {
    const clause = where.find(
      (w) => w.field === field && w.operator === "eq" && typeof w.value === "string",
    );
    return clause ? (clause.value as string) : null;
  };
  switch (model) {
    case "user": {
      const email = eq("email");
      if (email) return { gsi1pk: `USER:EMAIL#${email.toLowerCase()}`, gsi1sk: "USER" };
      return null;
    }
    case "session": {
      const token = eq("token");
      if (token) return { gsi1pk: `SESSION:TOKEN#${token}`, gsi1sk: "SESSION" };
      return null;
    }
    case "account": {
      const providerId = eq("providerId");
      const accountId = eq("accountId");
      if (providerId && accountId) {
        return {
          gsi1pk: `ACCOUNT:PROVIDER#${providerId}#${accountId}`,
          gsi1sk: "ACCOUNT",
        };
      }
      return null;
    }
    case "verification": {
      const identifier = eq("identifier");
      if (identifier) {
        return { gsi1pk: `VERIFICATION:IDENT#${identifier}`, gsi1sk: "VERIFICATION" };
      }
      return null;
    }
    default:
      return null;
  }
};

const tryPrimaryKeyLookup = (model: string, where: CleanedWhere[]): string | null => {
  if (where.length !== 1) return null;
  const clause = where[0];
  if (!clause) return null;
  if (clause.field !== "id") return null;
  if (clause.operator !== "eq") return null;
  if (typeof clause.value !== "string" && typeof clause.value !== "number") return null;
  return String(clause.value);
};

const queryGSI1 = async (lookup: GSI1Lookup, limit?: number): Promise<Item[]> => {
  const expressionNames: Record<string, string> = { "#pk": "GSI1PK" };
  const expressionValues: Record<string, unknown> = { ":pk": lookup.gsi1pk };
  let keyCondition = "#pk = :pk";
  if (lookup.gsi1sk !== undefined) {
    expressionNames["#sk"] = "GSI1SK";
    expressionValues[":sk"] = lookup.gsi1sk;
    keyCondition += " AND #sk = :sk";
  }
  const result = await getDocumentClient().send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      Limit: limit,
    }),
  );
  return (result.Items as Item[] | undefined) ?? [];
};

const scanByEntity = async (model: string): Promise<Item[]> => {
  const prefix = entityPrefix(model);
  const items: Item[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await getDocumentClient().send(
      new ScanCommand({
        TableName: getTableName(),
        FilterExpression: "begins_with(#pk, :prefix) AND #sk = :meta",
        ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK" },
        ExpressionAttributeValues: { ":prefix": `${prefix}#`, ":meta": SK_META },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    if (result.Items) items.push(...(result.Items as Item[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
};

const fetchByWhere = async (model: string, where: CleanedWhere[]): Promise<Item[]> => {
  const id = tryPrimaryKeyLookup(model, where);
  if (id !== null) {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: buildPrimaryKey(model, id),
      }),
    );
    return result.Item ? [result.Item as Item] : [];
  }
  const gsi1 = tryGSI1Lookup(model, where);
  if (gsi1) {
    const items = await queryGSI1(gsi1);
    return items.filter((r) => matchesAll(r, where));
  }
  // No indexed access path matched — full entity Scan is expensive in
  // production. Surface it so operators can add an index or change the call.
  logger.warn("dynamodb-adapter.scan-fallback", {
    model,
    fields: where.map((w) => w.field),
  });
  const items = await scanByEntity(model);
  return items.filter((r) => matchesAll(r, where));
};

const sortRecords = (
  records: Item[],
  sortBy: { field: string; direction: "asc" | "desc" } | undefined,
): Item[] => {
  if (!sortBy) return records;
  const dir = sortBy.direction === "asc" ? 1 : -1;
  return [...records].sort((a, b) => {
    const av = a[sortBy.field];
    const bv = b[sortBy.field];
    if (av == null && bv == null) return 0;
    if (av == null) return -1 * dir;
    if (bv == null) return 1 * dir;
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
    if (av instanceof Date && bv instanceof Date) return (av.getTime() - bv.getTime()) * dir;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
};

const projectFields = (record: Item, select: string[] | undefined): Item => {
  if (!select || select.length === 0) return record;
  const allowed = new Set(select);
  return Object.fromEntries(Object.entries(record).filter(([key]) => allowed.has(key)));
};

const assertId = (data: Item): string => {
  const id = data["id"];
  if (typeof id !== "string" && typeof id !== "number") {
    throw new Error("DynamoDB adapter: expected `id` field on data after Better Auth transform.");
  }
  return String(id);
};

export const dynamodbAdapter = createAdapterFactory({
  config: {
    adapterId: "dynamodb-single-table",
    adapterName: "DynamoDB Single Table",
    supportsArrays: true,
    supportsBooleans: true,
    supportsDates: false,
    supportsJSON: true,
    supportsNumericIds: false,
    supportsUUIDs: false,
    transaction: false,
  },
  adapter: () => {
    const client = () => getDocumentClient();
    const tableName = () => getTableName();

    return {
      create: async ({ model, data }) => {
        const id = assertId(data);
        const primary = buildPrimaryKey(model, id);
        const gsi1 = buildGSI1Key(model, data);
        const ttl = buildTtl(model, data);
        const item: Item = {
          ...primary,
          ...(gsi1 ?? {}),
          ...(ttl !== undefined ? { ttl } : {}),
          entity: entityPrefix(model),
          ...data,
        };
        await client().send(new PutCommand({ TableName: tableName(), Item: item }));
        return data;
      },

      findOne: async ({ model, where, select }) => {
        const records = await fetchByWhere(model, where);
        if (records.length === 0) return null;
        const first = records[0];
        if (!first) return null;
        const projected = projectFields(stripInternalKeys(first), select);
        return projected as never;
      },

      findMany: async ({ model, where, sortBy, limit, offset, select }) => {
        const records = await fetchByWhere(model, where ?? []);
        const sorted = sortRecords(records, sortBy);
        const sliced = offset !== undefined ? sorted.slice(offset) : sorted;
        const limited = limit !== undefined ? sliced.slice(0, limit) : sliced;
        return limited.map((r) => projectFields(stripInternalKeys(r), select)) as never;
      },

      count: async ({ model, where }) => {
        if (!where || where.length === 0) {
          const all = await scanByEntity(model);
          return all.length;
        }
        const records = await fetchByWhere(model, where);
        return records.length;
      },

      update: async ({ model, where, update }) => {
        const records = await fetchByWhere(model, where);
        if (records.length === 0) return null;
        const target = records[0];
        if (!target) return null;
        const merged = { ...stripInternalKeys(target), ...update };
        const id = assertId(merged);
        const primary = buildPrimaryKey(model, id);
        const gsi1 = buildGSI1Key(model, merged);
        const ttl = buildTtl(model, merged);
        const nextItem: Item = {
          ...primary,
          ...(gsi1 ?? {}),
          ...(ttl !== undefined ? { ttl } : {}),
          entity: entityPrefix(model),
          ...merged,
        };
        // GSI1 키는 update가 불가하므로 put으로 대체 (single PK/SK 위에)
        await client().send(new PutCommand({ TableName: tableName(), Item: nextItem }));
        return merged as never;
      },

      updateMany: async ({ model, where, update }) => {
        const records = await fetchByWhere(model, where);
        await Promise.all(
          records.map((record) => {
            const merged = { ...stripInternalKeys(record), ...update };
            const id = assertId(merged);
            const primary = buildPrimaryKey(model, id);
            const gsi1 = buildGSI1Key(model, merged);
            const ttl = buildTtl(model, merged);
            const nextItem: Item = {
              ...primary,
              ...(gsi1 ?? {}),
              ...(ttl !== undefined ? { ttl } : {}),
              entity: entityPrefix(model),
              ...merged,
            };
            return client().send(new PutCommand({ TableName: tableName(), Item: nextItem }));
          }),
        );
        return records.length;
      },

      delete: async ({ model, where }) => {
        const records = await fetchByWhere(model, where);
        await Promise.all(
          records.map((record) => {
            const id = assertId(record);
            return client().send(
              new DeleteCommand({
                TableName: tableName(),
                Key: buildPrimaryKey(model, id),
              }),
            );
          }),
        );
      },

      deleteMany: async ({ model, where }) => {
        const records = await fetchByWhere(model, where);
        await Promise.all(
          records.map((record) => {
            const id = assertId(record);
            return client().send(
              new DeleteCommand({
                TableName: tableName(),
                Key: buildPrimaryKey(model, id),
              }),
            );
          }),
        );
        return records.length;
      },
    };
  },
});
