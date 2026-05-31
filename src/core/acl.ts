/**
 * Access-control policy (architecture §5 gating).
 *
 * Channel allowlist applies to non-DM surfaces; user allowlist applies
 * everywhere. Per-tenant override wins over the deployment default;
 * empty list = explicit allow-all. Deny-by-default when a list is set.
 */
import type { InboundMessage } from "@/core/types";
import type { TenantConfig } from "@/core/tenant";

export interface AclResult {
  allowed: boolean;
  reason?: string;
}

export interface AclPolicy {
  evaluate(msg: InboundMessage, tenant: TenantConfig | null): AclResult;
}
