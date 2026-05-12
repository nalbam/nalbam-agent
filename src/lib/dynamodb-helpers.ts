import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { getDocumentClient, getTableName } from "@/lib/dynamodb";

export type Item = Record<string, unknown>;

export interface KeyPair {
  PK: string;
  SK: string;
}

export const getItem = async <T extends Item = Item>(key: KeyPair): Promise<T | null> => {
  const result = await getDocumentClient().send(
    new GetCommand({ TableName: getTableName(), Key: key }),
  );
  return (result.Item as T | undefined) ?? null;
};

export const putItem = async <T extends Item>(item: T & KeyPair): Promise<void> => {
  await getDocumentClient().send(new PutCommand({ TableName: getTableName(), Item: item }));
};

export const deleteItem = async (key: KeyPair): Promise<void> => {
  await getDocumentClient().send(new DeleteCommand({ TableName: getTableName(), Key: key }));
};

export interface QueryOptions {
  indexName?: string;
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
  scanIndexForward?: boolean;
  filter?: {
    expression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  };
  projection?: string[];
}

export const queryByPK = async <T extends Item = Item>(
  pk: string,
  skBeginsWith?: string,
  options: QueryOptions = {},
): Promise<{ items: T[]; lastKey?: Record<string, unknown> }> => {
  const expressionNames: Record<string, string> = { "#pk": "PK" };
  const expressionValues: Record<string, unknown> = { ":pk": pk };
  let keyCondition = "#pk = :pk";

  if (skBeginsWith !== undefined) {
    expressionNames["#sk"] = "SK";
    expressionValues[":sk"] = skBeginsWith;
    keyCondition += " AND begins_with(#sk, :sk)";
  }

  return runQuery<T>(keyCondition, expressionNames, expressionValues, options);
};

export const queryGSI1 = async <T extends Item = Item>(
  gsi1pk: string,
  gsi1skBeginsWith?: string,
  options: Omit<QueryOptions, "indexName"> = {},
): Promise<{ items: T[]; lastKey?: Record<string, unknown> }> => {
  const expressionNames: Record<string, string> = { "#pk": "GSI1PK" };
  const expressionValues: Record<string, unknown> = { ":pk": gsi1pk };
  let keyCondition = "#pk = :pk";

  if (gsi1skBeginsWith !== undefined) {
    expressionNames["#sk"] = "GSI1SK";
    expressionValues[":sk"] = gsi1skBeginsWith;
    keyCondition += " AND begins_with(#sk, :sk)";
  }

  return runQuery<T>(keyCondition, expressionNames, expressionValues, {
    ...options,
    indexName: "GSI1",
  });
};

const runQuery = async <T extends Item>(
  keyCondition: string,
  expressionNames: Record<string, string>,
  expressionValues: Record<string, unknown>,
  options: QueryOptions,
): Promise<{ items: T[]; lastKey?: Record<string, unknown> }> => {
  const merged: QueryCommandInput = {
    TableName: getTableName(),
    KeyConditionExpression: keyCondition,
    ExpressionAttributeNames: { ...expressionNames },
    ExpressionAttributeValues: { ...expressionValues },
  };
  if (options.indexName) merged.IndexName = options.indexName;
  if (options.limit) merged.Limit = options.limit;
  if (options.exclusiveStartKey) merged.ExclusiveStartKey = options.exclusiveStartKey;
  if (options.scanIndexForward !== undefined) merged.ScanIndexForward = options.scanIndexForward;
  if (options.filter) {
    merged.FilterExpression = options.filter.expression;
    merged.ExpressionAttributeNames = {
      ...merged.ExpressionAttributeNames,
      ...options.filter.names,
    };
    merged.ExpressionAttributeValues = {
      ...merged.ExpressionAttributeValues,
      ...options.filter.values,
    };
  }
  const result = await getDocumentClient().send(new QueryCommand(merged));
  return {
    items: (result.Items as T[] | undefined) ?? [],
    lastKey: result.LastEvaluatedKey,
  };
};

export interface ScanOptions {
  filter?: {
    expression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  };
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
}

export const scanAll = async <T extends Item = Item>(
  options: ScanOptions = {},
): Promise<{ items: T[]; lastKey?: Record<string, unknown> }> => {
  const result = await getDocumentClient().send(
    new ScanCommand({
      TableName: getTableName(),
      FilterExpression: options.filter?.expression,
      ExpressionAttributeNames: options.filter?.names,
      ExpressionAttributeValues: options.filter?.values,
      Limit: options.limit,
      ExclusiveStartKey: options.exclusiveStartKey,
    }),
  );
  return {
    items: (result.Items as T[] | undefined) ?? [],
    lastKey: result.LastEvaluatedKey,
  };
};

export const transactWrite = async (
  items: NonNullable<TransactWriteCommandInput["TransactItems"]>,
): Promise<void> => {
  if (items.length === 0) return;
  if (items.length > 100) {
    throw new Error("DynamoDB transactWrite supports up to 100 items per call.");
  }
  await getDocumentClient().send(new TransactWriteCommand({ TransactItems: items }));
};

export const updateItem = async (
  key: KeyPair,
  set: Record<string, unknown>,
  remove: string[] = [],
): Promise<Item | null> => {
  const setEntries = Object.entries(set);
  const expressionNames: Record<string, string> = {};
  const expressionValues: Record<string, unknown> = {};
  const setParts: string[] = [];
  let counter = 0;
  for (const [field, value] of setEntries) {
    counter += 1;
    const nameKey = `#f${counter}`;
    const valueKey = `:v${counter}`;
    expressionNames[nameKey] = field;
    expressionValues[valueKey] = value;
    setParts.push(`${nameKey} = ${valueKey}`);
  }
  const removeParts: string[] = [];
  for (const field of remove) {
    counter += 1;
    const nameKey = `#f${counter}`;
    expressionNames[nameKey] = field;
    removeParts.push(nameKey);
  }
  const updateExpression = [
    setParts.length > 0 ? `SET ${setParts.join(", ")}` : "",
    removeParts.length > 0 ? `REMOVE ${removeParts.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!updateExpression) return null;

  const result = await getDocumentClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: key,
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues:
        Object.keys(expressionValues).length > 0 ? expressionValues : undefined,
      ReturnValues: "ALL_NEW",
    }),
  );
  return (result.Attributes as Item | undefined) ?? null;
};
