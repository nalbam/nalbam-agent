import type { TenantConfig, TenantResolver } from "@/core/tenant";

export const createStaticTenantResolver = (tenants: TenantConfig[] = []): TenantResolver => {
  const byKey = new Map(tenants.map((tenant) => [`${tenant.channel}:${tenant.tenantId}`, tenant]));
  return {
    async resolve(channel, tenantId) {
      return byKey.get(`${channel}:${tenantId}`) ?? null;
    },
  };
};
