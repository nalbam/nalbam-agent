import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

import { getServerEnv } from "@/lib/env";
import type { BlobRef, BlobStore, PutBlobInput } from "@/storage/types";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 15 * 60;

const cleanSegment = (value: string): string =>
  value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[^a-zA-Z0-9._=-]/g, "_")
    .slice(0, 256);

export const buildTenantBlobKey = (
  prefix: string,
  channel: string,
  tenantId: string,
  name: string,
): string => {
  const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
  const parts = [
    normalizedPrefix,
    cleanSegment(channel),
    cleanSegment(tenantId),
    `${Date.now()}-${randomUUID()}-${cleanSegment(name) || "blob"}`,
  ].filter(Boolean);
  return parts.join("/");
};

const bytesFromBody = async (body: unknown): Promise<Uint8Array | null> => {
  if (!body) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ReadableStream) {
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  if (
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  ) {
    return (await body.transformToByteArray()) as Uint8Array;
  }
  throw new Error("Unsupported S3 response body type.");
};

export interface S3BlobStoreOptions {
  bucket: string;
  prefix?: string;
  publicBaseUrl?: string;
  client?: S3Client;
}

export const createS3BlobStore = ({
  bucket,
  prefix = "",
  publicBaseUrl,
  client,
}: S3BlobStoreOptions): BlobStore => {
  const s3 = client ?? new S3Client(buildS3ClientConfig());

  return {
    async put(input: PutBlobInput): Promise<BlobRef> {
      const key = buildTenantBlobKey(prefix, input.channel, input.tenantId, input.name);
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: input.data,
          ContentType: input.mime,
          Metadata: {
            channel: input.channel,
            tenant: input.tenantId,
          },
        }),
      );
      return {
        key,
        mime: input.mime,
        size: input.data.byteLength,
        url: publicBaseUrl ? `${publicBaseUrl.replace(/\/+$/g, "")}/${key}` : undefined,
      };
    },
    async get(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return bytesFromBody(result.Body);
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async signedUrl(key, opts = {}) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: opts.expiresInSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS,
      });
    },
  };
};

const buildS3ClientConfig = (): S3ClientConfig => {
  const env = getServerEnv();
  return {
    region: env.AWS_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  };
};

export const createConfiguredS3BlobStore = (): BlobStore => {
  const env = getServerEnv();
  if (!env.S3_BUCKET_NAME) {
    throw new Error("S3_BUCKET_NAME is required to use the S3 blob store.");
  }
  return createS3BlobStore({
    bucket: env.S3_BUCKET_NAME,
    prefix: env.S3_PREFIX,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
  });
};
