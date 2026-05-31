/**
 * Storage abstraction (architecture §5.7).
 *
 * `kv` backs dedup/throttle/cache (TTL-aware); `doc` backs tenant metadata,
 * conversation history, and user memory; `blob` backs attachments, generated
 * files, and tool artifacts. Implementations: S3 (blob), DynamoDB (doc + kv);
 * in-memory equivalents back tests.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  /** SET if-not-exists with TTL — the race-safe dedup primitive. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export interface DocItem {
  [key: string]: unknown;
}

export interface DocStore {
  get<T extends DocItem = DocItem>(pk: string, sk: string): Promise<T | null>;
  put<T extends DocItem>(
    pk: string,
    sk: string,
    item: T,
    opts?: { ttlSeconds?: number },
  ): Promise<void>;
  update(pk: string, sk: string, set: DocItem, remove?: string[]): Promise<void>;
  query<T extends DocItem = DocItem>(pk: string, skPrefix?: string): Promise<T[]>;
  delete(pk: string, sk: string): Promise<void>;
}

export interface BlobRef {
  key: string;
  url?: string;
  mime?: string;
  size?: number;
}

export interface PutBlobInput {
  channel: string;
  tenantId: string;
  name: string;
  data: Uint8Array;
  mime?: string;
}

export interface BlobStore {
  put(input: PutBlobInput): Promise<BlobRef>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, opts?: { expiresInSeconds?: number }): Promise<string>;
}

export interface StorageProvider {
  kv: KvStore;
  doc: DocStore;
  blob: BlobStore;
}
