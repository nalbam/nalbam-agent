/** Per-user concurrency limiter (architecture §5.5 gating). */
export interface ThrottleLease {
  allowed: boolean;
  /** Always safe to call; no-op when not allowed. */
  release: () => Promise<void>;
}

export interface ThrottleService {
  acquire(userId: string): Promise<ThrottleLease>;
}
