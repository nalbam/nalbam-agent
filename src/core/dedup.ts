/**
 * Idempotency service (architecture §5.2 / §4 idempotency).
 *
 * Two-stage: `reserve` blocks parallel duplicates (short TTL), `markDone`
 * absorbs slow retries after success (long TTL). Scope is
 * `{channel}:{tenantId}:{dedupKey}`.
 */
export interface DedupService {
  isDone(scope: string): Promise<boolean>;
  /** Returns true if this caller acquired the reservation. */
  reserve(scope: string): Promise<boolean>;
  markDone(scope: string): Promise<void>;
}
