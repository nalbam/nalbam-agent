import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPipelineDeps } from "@/core/deps";
import { __resetServerEnvForTests } from "@/lib/env";

const ORIGINAL = { ...process.env };

describe("buildPipelineDeps", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL };
    __resetServerEnvForTests();
  });

  it("loads static tenants from AGENT_TENANTS_JSON", async () => {
    process.env.AGENT_TENANTS_JSON = JSON.stringify([
      {
        channel: "slack",
        tenantId: "T123",
        allowedUserIds: ["U123"],
        allowedChannelIds: ["C123"],
        language: "ko",
      },
    ]);
    __resetServerEnvForTests();

    const deps = buildPipelineDeps();
    await expect(deps.tenants.resolve("slack", "T123")).resolves.toMatchObject({
      channel: "slack",
      tenantId: "T123",
      allowedUserIds: ["U123"],
      allowedChannelIds: ["C123"],
      language: "ko",
    });
  });

  it("lets explicit call-site tenants override static tenants", async () => {
    process.env.AGENT_TENANTS_JSON = JSON.stringify([
      { channel: "api", tenantId: "tenant-a", allowedUserIds: ["u1"] },
    ]);
    __resetServerEnvForTests();

    const deps = buildPipelineDeps({
      tenants: [{ channel: "api", tenantId: "tenant-a", allowedUserIds: ["u2"] }],
    });
    await expect(deps.tenants.resolve("api", "tenant-a")).resolves.toMatchObject({
      allowedUserIds: ["u2"],
    });
  });
});
