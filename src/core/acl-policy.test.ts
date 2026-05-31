import { describe, expect, it } from "vitest";

import { createAclPolicy } from "@/core/acl-policy";
import type { InboundMessage } from "@/core/types";

const msg = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "slack",
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
  ...overrides,
});

describe("createAclPolicy", () => {
  it("denies when the tenant is not configured", () => {
    expect(createAclPolicy().evaluate(msg(), null)).toEqual({
      allowed: false,
      reason: "tenant_not_configured",
    });
  });

  it("allows explicit empty tenant allowlists", () => {
    const tenant = {
      channel: "slack",
      tenantId: "t1",
      allowedUserIds: [],
      allowedChannelIds: [],
    };
    expect(createAclPolicy().evaluate(msg({ surface: "channel" }), tenant)).toEqual({
      allowed: true,
    });
  });

  it("applies user allowlists on every surface", () => {
    const policy = createAclPolicy();
    const tenant = { channel: "slack", tenantId: "t1", allowedUserIds: ["u2"] };
    expect(policy.evaluate(msg(), tenant)).toEqual({
      allowed: false,
      reason: "user_not_allowed",
    });
  });

  it("applies channel allowlists only outside direct surfaces", () => {
    const policy = createAclPolicy();
    const tenant = {
      channel: "slack",
      tenantId: "t1",
      allowedUserIds: ["u1"],
      allowedChannelIds: ["c2"],
    };
    expect(policy.evaluate(msg({ surface: "dm", conversationId: "c1" }), tenant)).toEqual({
      allowed: true,
    });
    expect(policy.evaluate(msg({ surface: "channel", conversationId: "c1" }), tenant)).toEqual({
      allowed: false,
      reason: "channel_not_allowed",
    });
  });
});
