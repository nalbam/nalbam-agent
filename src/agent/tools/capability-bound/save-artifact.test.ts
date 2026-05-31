import { describe, expect, it } from "vitest";

import "@/agent/tools/capability-bound/save-artifact";
import { buildToolset } from "@/agent/tools/registry";
import type { ToolContext } from "@/agent/tools/types";
import type { InboundMessage } from "@/core/types";
import { logger } from "@/lib/logger";

const msg: InboundMessage = {
  channel: "api",
  tenantId: "tenant-a",
  conversationId: "c1",
  userId: "u1",
  text: "save",
  attachments: [],
  mentions: [],
  surface: "direct",
  dedupKey: "k1",
  receivedAt: 0,
  raw: null,
};

describe("save_text_artifact tool", () => {
  it("is hidden without uploadMedia capability", () => {
    const tools = buildToolset({ msg, caps: {}, tenant: null, log: logger });
    expect(tools.save_text_artifact).toBeUndefined();
  });

  it("saves text through uploadMedia capability", async () => {
    const seen: { name?: string; mime: string; text: string }[] = [];
    const ctx: ToolContext = {
      msg,
      caps: {
        uploadMedia: async (media) => {
          seen.push({
            name: media.name,
            mime: media.mime,
            text: new TextDecoder().decode(media.data),
          });
          return { url: "memory://api/tenant-a/report.md" };
        },
      },
      tenant: null,
      log: logger,
    };

    const tool = buildToolset(ctx).save_text_artifact;
    const result = await tool?.execute?.(
      { name: "report.md", content: "# Report", mime: "text/markdown" },
      { toolCallId: "call-1", messages: [], abortSignal: undefined },
    );

    expect(result).toEqual({ url: "memory://api/tenant-a/report.md" });
    expect(seen).toEqual([{ name: "report.md", mime: "text/markdown", text: "# Report" }]);
  });
});
