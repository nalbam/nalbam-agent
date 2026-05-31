/** Per-user concurrency limiter (architecture §5.5 gating). */
export interface ThrottleLease {
  allowed: boolean;
  /** Always safe to call; no-op when not allowed. */
  release: () => Promise<void>;
}

export interface ThrottleService {
  /** Scope must include channel + tenant + user to avoid cross-tenant contention. */
  acquire(scope: string): Promise<ThrottleLease>;
}
