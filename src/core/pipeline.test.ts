import { describe, expect, it, vi } from "vitest";

import { runConversation, type PipelineDeps } from "@/core/pipeline";
import type { ChannelAdapter } from "@/channels/types";
import type { InboundMessage } from "@/core/types";
import { logger } from "@/lib/logger";
import { createMemoryBlobStore } from "@/storage/memory-blob";
import { createMemoryDocStore } from "@/storage/memory-doc";
import { createMemoryKv } from "@/storage/memory-kv";

const MSG: InboundMessage = {
  channel: "test",
  tenantId: "t1",
  conversationId: "c1",
  userId: "u1",
  text: "hi",
  attachments: [],
  mentions: [],
  surface: "dm",
  dedupKey: "k1",
  receivedAt: 0,
  raw: null,
};

const makeAdapter = (): ChannelAdapter => ({
  id: "test",
  mode: "http",
  ingest: async () => ({ messages: [] }),
  credentials: (tenantId) => ({ channel: "test", tenantId }),
  responder: () => ({ append: async () => {}, finalize: async () => {} }),
  capabilities: () => ({}),
  renderingRules: () => "",
});

const makeDeps = (overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
  tenants: { resolve: async () => null },
  dedup: { isDone: async () => false, reserve: async () => true, markDone: async () => {} },
  acl: { evaluate: () => ({ allowed: true }) },
  throttle: { acquire: async () => ({ allowed: true, release: async () => {} }) },
  memory: {
    loadConversation: async () => [],
    appendConversation: async () => {},
    remember: async () => {},
    forget: async () => {},
    loadUserMemory: async () => [],
  },
  storage: {
    kv: createMemoryKv(),
    doc: createMemoryDocStore(),
    blob: createMemoryBlobStore(),
  },
  agent: {
    run: async () => ({
      text: "ok",
      steps: 1,
      toolCallCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      forcedCompose: false,
    }),
  },
  logger,
  ...overrides,
});

describe("runConversation", () => {
  it("runs dedup → acl → throttle → agent → egress → markDone in order", async () => {
    const order: string[] = [];
    const adapter = makeAdapter();
    adapter.responder = () => ({
      append: async () => {},
      finalize: async () => {
        order.push("egress");
      },
    });
    const deps = makeDeps({
      dedup: {
        isDone: async () => {
          order.push("isDone");
          return false;
        },
        reserve: async () => {
          order.push("reserve");
          return true;
        },
        markDone: async () => {
          order.push("markDone");
        },
      },
      acl: {
        evaluate: () => {
          order.push("acl");
          return { allowed: true };
        },
      },
      throttle: {
        acquire: async () => {
          order.push("throttle");
          return { allowed: true, release: async () => {} };
        },
      },
      agent: {
        run: async () => {
          order.push("agent");
          return {
            text: "ok",
            steps: 1,
            toolCallCount: 0,
            tokensIn: 0,
            tokensOut: 0,
            forcedCompose: false,
          };
        },
      },
    });

    await runConversation(MSG, adapter, deps);
    expect(order).toEqual(["isDone", "reserve", "acl", "throttle", "agent", "egress", "markDone"]);
  });

  it("passes a channel and tenant scoped key to throttle", async () => {
    const acquire = vi.fn(async () => ({ allowed: true, release: async () => {} }));
    const deps = makeDeps({
      throttle: { acquire },
    });
    await runConversation(MSG, makeAdapter(), deps);
    expect(acquire).toHaveBeenCalledWith("test:t1:u1");
  });

  it("stops before the agent when ACL denies", async () => {
    const run = vi.fn();
    const deps = makeDeps({
      acl: { evaluate: () => ({ allowed: false, reason: "blocked" }) },
      agent: { run },
    });
    await runConversation(MSG, makeAdapter(), deps);
    expect(run).not.toHaveBeenCalled();
  });

  it("skips when already done (no reserve)", async () => {
    const reserve = vi.fn(async () => true);
    const deps = makeDeps({
      dedup: { isDone: async () => true, reserve, markDone: async () => {} },
    });
    await runConversation(MSG, makeAdapter(), deps);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("releases the throttle lease even when the agent throws", async () => {
    const release = vi.fn(async () => {});
    const deps = makeDeps({
      throttle: { acquire: async () => ({ allowed: true, release }) },
      agent: {
        run: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(runConversation(MSG, makeAdapter(), deps)).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledOnce();
  });
});
