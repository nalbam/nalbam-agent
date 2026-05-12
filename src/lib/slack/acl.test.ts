import { describe, expect, it } from "vitest";

import type { SlackAppRecord } from "@/lib/slack/app-metadata";
import {
  effectiveAllowlist,
  effectivePersona,
  evaluateChannelAcl,
  evaluateUserAcl,
  parseCsv,
  renderChannelDenyMessage,
} from "@/lib/slack/acl";

const baseApp: SlackAppRecord = {
  apiAppId: "A0XXX",
  firstSeenAt: 0,
  lastSeenAt: 0,
};

describe("parseCsv", () => {
  it("returns [] for empty/undefined", () => {
    expect(parseCsv(undefined)).toEqual([]);
    expect(parseCsv("")).toEqual([]);
  });
  it("trims and drops blanks", () => {
    expect(parseCsv("a, b ,, c")).toEqual(["a", "b", "c"]);
  });
});

describe("effectiveAllowlist", () => {
  it("falls back to env when app override is undefined", () => {
    expect(effectiveAllowlist({ appOverride: undefined, envCsv: "C1,C2" })).toEqual(["C1", "C2"]);
  });
  it("uses empty app override (meaningful 'allow all')", () => {
    expect(effectiveAllowlist({ appOverride: [], envCsv: "C1,C2" })).toEqual([]);
  });
  it("uses non-empty app override over env", () => {
    expect(effectiveAllowlist({ appOverride: ["X"], envCsv: "C1,C2" })).toEqual(["X"]);
  });
});

describe("evaluateChannelAcl", () => {
  it("always allows DMs", () => {
    const r = evaluateChannelAcl({
      channel: "Dxxxx",
      isDm: true,
      app: null,
      envCsv: "C1",
    });
    expect(r).toEqual({ allowed: true });
  });
  it("allows when no allowlist (env empty, app override absent)", () => {
    expect(
      evaluateChannelAcl({ channel: "Cany", isDm: false, app: null, envCsv: undefined }),
    ).toEqual({ allowed: true });
  });
  it("blocks channels not in env allowlist", () => {
    const r = evaluateChannelAcl({
      channel: "C999",
      isDm: false,
      app: null,
      envCsv: "C1,C2",
    });
    expect(r.allowed).toBe(false);
    expect(r.firstAllowedChannel).toBe("C1");
  });
  it("allows channels in env allowlist", () => {
    expect(
      evaluateChannelAcl({ channel: "C2", isDm: false, app: null, envCsv: "C1,C2" }).allowed,
    ).toBe(true);
  });
  it("app override (empty []) opens up when env is restrictive", () => {
    const app: SlackAppRecord = { ...baseApp, allowedChannelIds: [] };
    expect(evaluateChannelAcl({ channel: "C9", isDm: false, app, envCsv: "C1" }).allowed).toBe(
      true,
    );
  });
  it("app override (non-empty) overrides env entirely", () => {
    const app: SlackAppRecord = { ...baseApp, allowedChannelIds: ["CX"] };
    expect(evaluateChannelAcl({ channel: "C1", isDm: false, app, envCsv: "C1" }).allowed).toBe(
      false,
    );
    expect(evaluateChannelAcl({ channel: "CX", isDm: false, app, envCsv: "C1" }).allowed).toBe(
      true,
    );
  });
});

describe("evaluateUserAcl", () => {
  it("allows when no allowlist", () => {
    expect(evaluateUserAcl({ user: "U1", app: null, envCsv: undefined }).allowed).toBe(true);
  });
  it("blocks when user not in env allowlist (DM included)", () => {
    expect(evaluateUserAcl({ user: "U2", app: null, envCsv: "U1" }).allowed).toBe(false);
  });
  it("app override [] opens up even when env restricts", () => {
    const app: SlackAppRecord = { ...baseApp, allowedUserIds: [] };
    expect(evaluateUserAcl({ user: "U9", app, envCsv: "U1" }).allowed).toBe(true);
  });
});

describe("effectivePersona", () => {
  it("uses env when app has no override", () => {
    expect(effectivePersona(null, "kind")).toBe("kind");
    expect(effectivePersona(baseApp, "kind")).toBe("kind");
  });
  it("app empty string explicitly clears persona", () => {
    const app: SlackAppRecord = { ...baseApp, personaMessage: "" };
    expect(effectivePersona(app, "kind")).toBeUndefined();
  });
  it("app non-empty overrides env", () => {
    const app: SlackAppRecord = { ...baseApp, personaMessage: "terse" };
    expect(effectivePersona(app, "kind")).toBe("terse");
  });
});

describe("renderChannelDenyMessage", () => {
  it("substitutes {} with <#CHANNEL>", () => {
    expect(renderChannelDenyMessage("ask in {} please", "C1")).toBe("ask in <#C1> please");
  });
  it("returns template as-is when no channel to reference", () => {
    expect(renderChannelDenyMessage("ask in {} please", undefined)).toBe("ask in {} please");
  });
  it("empty template returns empty", () => {
    expect(renderChannelDenyMessage("", "C1")).toBe("");
  });
});
