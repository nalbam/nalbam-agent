import { describe, expect, it } from "vitest";

import { defineChannel, getChannel, listChannels } from "@/channels/registry";
import type { ChannelAdapter } from "@/channels/types";

const stub = (id: string): ChannelAdapter => ({
  id,
  mode: "http",
  ingest: async () => ({ messages: [] }),
  credentials: (tenantId) => ({ channel: id, tenantId }),
  responder: () => ({ append: async () => {}, finalize: async () => {} }),
  capabilities: () => ({}),
  renderingRules: () => "",
});

describe("channel registry", () => {
  it("round-trips defineChannel → getChannel", () => {
    const adapter = defineChannel(stub("registry_test"));
    expect(getChannel("registry_test")).toBe(adapter);
    expect(listChannels()).toContain(adapter);
  });

  it("returns undefined for an unknown channel", () => {
    expect(getChannel("does_not_exist")).toBeUndefined();
  });
});
