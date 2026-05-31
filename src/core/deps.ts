import type { PipelineDeps } from "@/core/pipeline";
import { aiSdkAgentRuntime } from "@/agent/runtime";
import { createAclPolicy } from "@/core/acl-policy";
import { createKvDedupService } from "@/core/dedup-service";
import { createStaticTenantResolver } from "@/core/tenant-resolver";
import { createKvThrottleService } from "@/core/throttle-service";
import type { TenantConfig } from "@/core/tenant";
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createMemoryStore } from "@/memory/memory-store";
import { getStorageProvider } from "@/storage/provider";

const memory = createMemoryStore();

export interface BuildPipelineDepsOptions {
  tenants?: TenantConfig[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const parseStaticTenants = (raw: string | undefined): TenantConfig[] => {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("AGENT_TENANTS_JSON must be a JSON array.");
  }
  return parsed.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("AGENT_TENANTS_JSON entries must be objects.");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.channel !== "string" || typeof record.tenantId !== "string") {
      throw new Error("AGENT_TENANTS_JSON entries require channel and tenantId.");
    }
    return {
      channel: record.channel,
      tenantId: record.tenantId,
      allowedChannelIds: isStringArray(record.allowedChannelIds)
        ? record.allowedChannelIds
        : undefined,
      allowedUserIds: isStringArray(record.allowedUserIds) ? record.allowedUserIds : undefined,
      persona: typeof record.persona === "string" ? record.persona : undefined,
      language: record.language === "ko" || record.language === "en" ? record.language : undefined,
    };
  });
};

export const buildPipelineDeps = (opts: BuildPipelineDepsOptions = {}): PipelineDeps => {
  const env = getServerEnv();
  const storage = getStorageProvider();
  const tenants = [...parseStaticTenants(env.AGENT_TENANTS_JSON), ...(opts.tenants ?? [])];
  return {
    tenants: createStaticTenantResolver(tenants),
    dedup: createKvDedupService(storage.kv),
    acl: createAclPolicy(),
    throttle: createKvThrottleService(storage.kv, { maxConcurrent: env.MAX_THROTTLE_COUNT }),
    memory,
    storage,
    agent: aiSdkAgentRuntime,
    logger,
  };
};
