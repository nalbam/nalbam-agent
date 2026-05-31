import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildToolset, defineTool } from "@/agent/tools/registry";
import type { ToolContext } from "@/agent/tools/types";
import type { Capabilities } from "@/channels/types";
import type { InboundMessage } from "@/core/types";
import { logger } from "@/lib/logger";

const MSG: InboundMessage = {
  channel: "test",
  tenantId: "t1",
  conversationId: "c1",
  userId: "u1",
  text: "",
  attachments: [],
  mentions: [],
  surface: "dm",
  dedupKey: "k1",
  receivedAt: 0,
  raw: null,
};

const ctx = (caps: Capabilities): ToolContext => ({ msg: MSG, caps, tenant: null, log: logger });

const noopTool = () =>
  tool({ description: "x", inputSchema: z.object({}), execute: async () => "ok" });

defineTool({ name: "free_tool", build: noopTool });
defineTool({ name: "needs_upload", requires: ["uploadMedia"], build: noopTool });

describe("buildToolset", () => {
  it("always includes channel-agnostic tools", () => {
    const set = buildToolset(ctx({}));
    expect(set.free_tool).toBeDefined();
  });

  it("excludes a capability-bound tool when the capability is missing", () => {
    const set = buildToolset(ctx({}));
    expect(set.needs_upload).toBeUndefined();
  });

  it("includes a capability-bound tool when the capability is provided", () => {
    const set = buildToolset(ctx({ uploadMedia: async () => ({ url: "" }) }));
    expect(set.needs_upload).toBeDefined();
  });
});
