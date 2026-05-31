import { getServerEnv } from "@/lib/env";
import { createDynamoDocStore } from "@/storage/dynamodb-doc";
import { createDynamoKv } from "@/storage/dynamodb-kv";
import { createMemoryBlobStore } from "@/storage/memory-blob";
import { createConfiguredS3BlobStore } from "@/storage/s3-blob";
import type { StorageProvider } from "@/storage/types";

let cachedStorage: StorageProvider | undefined;

export const createStorageProvider = (): StorageProvider => {
  const env = getServerEnv();
  return {
    kv: createDynamoKv(),
    doc: createDynamoDocStore(),
    blob: env.S3_BUCKET_NAME ? createConfiguredS3BlobStore() : createMemoryBlobStore(),
  };
};

export const getStorageProvider = (): StorageProvider => {
  cachedStorage ??= createStorageProvider();
  return cachedStorage;
};

export const __resetStorageProviderForTests = (): void => {
  cachedStorage = undefined;
};
