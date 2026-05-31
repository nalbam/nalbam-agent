import type { AclPolicy, AclResult } from "@/core/acl";
import type { TenantConfig } from "@/core/tenant";
import type { InboundMessage } from "@/core/types";

export interface AllowlistDefaults {
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
}

const hasList = (value: string[] | undefined): value is string[] => value !== undefined;

const isAllowedByList = (value: string, list: string[] | undefined): boolean => {
  if (!hasList(list)) return false;
  if (list.length === 0) return true;
  return list.includes(value);
};

const listFor = (
  tenant: TenantConfig,
  field: "allowedChannelIds" | "allowedUserIds",
  defaults: AllowlistDefaults,
): string[] | undefined => {
  const tenantList = tenant[field];
  return tenantList !== undefined ? tenantList : defaults[field];
};

export const createAclPolicy = (defaults: AllowlistDefaults = {}): AclPolicy => ({
  evaluate(msg: InboundMessage, tenant: TenantConfig | null): AclResult {
    if (!tenant) {
      return { allowed: false, reason: "tenant_not_configured" };
    }

    const allowedUserIds = listFor(tenant, "allowedUserIds", defaults);
    if (!isAllowedByList(msg.userId, allowedUserIds)) {
      return { allowed: false, reason: "user_not_allowed" };
    }

    if (msg.surface !== "dm" && msg.surface !== "direct") {
      const allowedChannelIds = listFor(tenant, "allowedChannelIds", defaults);
      if (!isAllowedByList(msg.conversationId, allowedChannelIds)) {
        return { allowed: false, reason: "channel_not_allowed" };
      }
    }

    return { allowed: true };
  },
});
