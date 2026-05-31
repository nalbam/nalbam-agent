/**
 * Tenant model (architecture §5.6).
 *
 * A tenant is (channel, workspace/bot/key). Present allowlist attributes —
 * including empty `[]` — override the deployment default; absent attributes
 * fall back. Empty `persona` ("") means "explicitly no persona".
 */
export interface TenantConfig {
  tenantId: string;
  channel: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  persona?: string;
  language?: "ko" | "en";
}

export interface TenantResolver {
  resolve(channel: string, tenantId: string): Promise<TenantConfig | null>;
}
