/**
 * Per-channel credential provider (architecture §5.6).
 *
 * Secrets live in a secret manager (e.g. SSM), never in code or the doc
 * store. Implementations cache with a negative-cache and invalidate on
 * rotation.
 */
export interface CredentialRef {
  channel: string;
  tenantId: string;
}

export interface CredentialProvider<T = unknown> {
  readonly channel: string;
  get(ref: CredentialRef): Promise<T | null>;
  put(ref: CredentialRef, value: T): Promise<void>;
  invalidate(ref: CredentialRef): void;
}
