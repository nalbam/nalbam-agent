import type { BlobRef, BlobStore, PutBlobInput } from "@/storage/types";

export const createMemoryBlobStore = (): BlobStore => {
  const map = new Map<string, Uint8Array>();

  return {
    async put(input: PutBlobInput): Promise<BlobRef> {
      const key = `${input.channel}/${input.tenantId}/${input.name}`;
      map.set(key, input.data);
      return { key, mime: input.mime, size: input.data.byteLength };
    },
    async get(key) {
      return map.get(key) ?? null;
    },
    async delete(key) {
      map.delete(key);
    },
    async signedUrl(key) {
      return `memory://${key}`;
    },
  };
};
