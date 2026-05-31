/**
 * Pipeline dependency wiring.
 *
 * Skeleton stub: returns permissive/no-op services so `runConversation` flows
 * end to end and type-checks. Real services (KV-backed dedup/throttle,
 * allowlist ACL, tenant resolver, DynamoDB memory) are wired in later steps.
 */
import type { AclPolicy } from "@/core/acl";
import type { DedupService } from "@/core/dedup";
import type { PipelineDeps } from "@/core/pipeline";
import type { TenantResolver } from "@/core/tenant";
import type { ThrottleService } from "@/core/throttle";
import { stubAgentRuntime } from "@/agent/runtime";
import type { MemoryStore } from "@/memory/types";
import { logger } from "@/lib/logger";

const passthroughDedup: DedupService = {
  async isDone() {
    return false;
  },
  async reserve() {
    return true;
  },
  async markDone() {},
};

const passthroughThrottle: ThrottleService = {
  async acquire() {
    return { allowed: true, release: async () => {} };
  },
};

const allowAllAcl: AclPolicy = {
  evaluate() {
    return { allowed: true };
  },
};

const nullTenantResolver: TenantResolver = {
  async resolve() {
    return null;
  },
};

const emptyMemory: MemoryStore = {
  async loadConversation() {
    return [];
  },
  async appendConversation() {},
  async remember() {},
  async forget() {},
  async loadUserMemory() {
    return [];
  },
};

export const buildPipelineDeps = (): PipelineDeps => ({
  tenants: nullTenantResolver,
  dedup: passthroughDedup,
  acl: allowAllAcl,
  throttle: passthroughThrottle,
  memory: emptyMemory,
  agent: stubAgentRuntime,
  logger,
});
