/**
 * Channel-agnostic conversation pipeline (architecture §5.2).
 *
 * Receives one normalized `InboundMessage` and runs:
 *   dedup → tenant → ACL → throttle → context → agent → egress → persist.
 * Cross-cutting concerns live here, not in each channel. Keys are scoped by
 * `{channel}:{tenantId}:…` so channels never collide.
 *
 * Skeleton note: each `deps.*` is injected, so with stub deps this flows end
 * to end without throwing — the type contract is what's verified for now.
 */
import type { InboundMessage } from "@/core/types";
import type { TenantResolver } from "@/core/tenant";
import type { DedupService } from "@/core/dedup";
import type { AclPolicy } from "@/core/acl";
import type { ThrottleService } from "@/core/throttle";
import type { ChannelAdapter } from "@/channels/types";
import type { AgentRuntime } from "@/agent/runtime";
import type { MemoryStore } from "@/memory/types";
import type { Logger } from "@/lib/logger";

export interface PipelineDeps {
  tenants: TenantResolver;
  dedup: DedupService;
  acl: AclPolicy;
  throttle: ThrottleService;
  memory: MemoryStore;
  agent: AgentRuntime;
  logger: Logger;
}

export async function runConversation(
  msg: InboundMessage,
  adapter: ChannelAdapter,
  deps: PipelineDeps,
): Promise<void> {
  const log = deps.logger.child({
    channel: msg.channel,
    tenantId: msg.tenantId,
    conversationId: msg.conversationId,
  });

  const dedupScope = `${msg.channel}:${msg.tenantId}:${msg.dedupKey}`;
  const convScope = `${msg.channel}:${msg.tenantId}:${msg.conversationId}`;

  if (await deps.dedup.isDone(dedupScope)) {
    log.info("dedup.skip", { reason: "already_done" });
    return;
  }
  if (!(await deps.dedup.reserve(dedupScope))) {
    log.info("dedup.skip", { reason: "in_flight" });
    return;
  }

  const tenant = await deps.tenants.resolve(msg.channel, msg.tenantId);

  const acl = deps.acl.evaluate(msg, tenant);
  if (!acl.allowed) {
    log.info("acl.blocked", { reason: acl.reason });
    return;
  }

  const lease = await deps.throttle.acquire(msg.userId);
  if (!lease.allowed) {
    log.info("throttle.limit", {});
    return;
  }

  try {
    const history = await deps.memory.loadConversation(convScope);
    const responder = adapter.responder(msg);
    const caps = adapter.capabilities(msg);

    log.info("agent.start", { surface: msg.surface });
    const result = await deps.agent.run({
      msg,
      tenant,
      history,
      caps,
      rendering: adapter.renderingRules(),
      responder,
      log,
    });

    await responder.finalize(result.text, result.media);

    await deps.memory.appendConversation(convScope, [
      { author: msg.userId, text: msg.text, ts: String(msg.receivedAt) },
      { author: "assistant", text: result.text, ts: String(msg.receivedAt) },
    ]);

    await deps.dedup.markDone(dedupScope);
    log.info("agent.done", {
      steps: result.steps,
      toolCalls: result.toolCallCount,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    });
  } finally {
    await lease.release();
  }
}
