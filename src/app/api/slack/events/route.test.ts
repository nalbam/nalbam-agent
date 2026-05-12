import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

type CredsResult = { signingSecret: string; botToken: string } | null;
const dispatchEventMock = vi.fn(async (input: unknown) => {
  void input;
});
const getCredentialsMock = vi.fn<(apiAppId: string) => Promise<CredsResult>>();
const getSlackClientMock = vi.fn(async (token: string) => {
  void token;
  return { chat: { postMessage: vi.fn() } };
});
const afterCallbacks: Array<() => unknown | Promise<unknown>> = [];

// `next/server` is mocked module-wide so we can both (a) capture the
// `after()` registration and (b) avoid pulling Next's full server runtime
// into the test environment. NextResponse is replicated minimally — only
// the shape route.ts depends on.
vi.mock("next/server", () => {
  return {
    NextResponse: class NextResponse extends Response {},
    after: (cb: () => unknown | Promise<unknown>) => {
      afterCallbacks.push(cb);
    },
  };
});

vi.mock("@/lib/slack/credentials", () => ({
  getSlackCredentials: (apiAppId: string) => getCredentialsMock(apiAppId),
}));

vi.mock("@/lib/slack/client", () => ({
  getSlackWebClient: (token: string) => getSlackClientMock(token),
}));

vi.mock("@/lib/slack/router", () => ({
  dispatchEvent: (input: unknown) => dispatchEventMock(input),
}));

// Import AFTER mocks register so the route picks them up.
const { POST } = await import("@/app/api/slack/events/route");

const SECRET = "test-signing-secret";
const APP = "A0XXX";

const sign = (body: string, ts: number, secret = SECRET): string =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

const buildRequest = (
  body: string,
  options: {
    ts?: number;
    signature?: string;
    extraHeaders?: Record<string, string>;
    omitSignatureHeaders?: boolean;
  } = {},
): Request => {
  const ts = options.ts ?? Math.floor(Date.now() / 1000);
  const signature = options.signature ?? sign(body, ts);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.omitSignatureHeaders
      ? {}
      : {
          "x-slack-request-timestamp": String(ts),
          "x-slack-signature": signature,
        }),
    ...options.extraHeaders,
  };
  return new Request("http://localhost/api/slack/events", {
    method: "POST",
    headers,
    body,
  });
};

beforeEach(() => {
  dispatchEventMock.mockClear();
  getCredentialsMock.mockReset();
  getSlackClientMock.mockClear();
  afterCallbacks.length = 0;
});

describe("POST /api/slack/events", () => {
  it("short-circuits Slack retry deliveries with 200 OK and no after() registration", async () => {
    const req = buildRequest("{}", {
      extraHeaders: { "x-slack-retry-num": "1" },
      omitSignatureHeaders: true,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(afterCallbacks).toHaveLength(0);
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });

  it("echoes url_verification challenge directly (no signature check)", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc-xyz" });
    const req = buildRequest(body, { omitSignatureHeaders: true });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc-xyz");
    expect(afterCallbacks).toHaveLength(0);
  });

  it("returns 200 with no work when api_app_id is missing", async () => {
    const body = JSON.stringify({ type: "event_callback" });
    const req = buildRequest(body, { omitSignatureHeaders: true });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("returns 200 (silent drop) when the app is unknown to SSM", async () => {
    getCredentialsMock.mockResolvedValueOnce(null);
    const body = JSON.stringify({ type: "event_callback", api_app_id: APP });
    const req = buildRequest(body, { omitSignatureHeaders: true });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("rejects bad signature with 401", async () => {
    getCredentialsMock.mockResolvedValueOnce({
      signingSecret: SECRET,
      botToken: "xoxb-test",
    });
    const body = JSON.stringify({ type: "event_callback", api_app_id: APP });
    const req = buildRequest(body, { signature: "v0=deadbeef" });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("registers after() and returns 200 immediately on a verified event", async () => {
    getCredentialsMock.mockResolvedValue({
      signingSecret: SECRET,
      botToken: "xoxb-test",
    });
    const body = JSON.stringify({
      type: "event_callback",
      api_app_id: APP,
      event: { type: "app_mention", text: "<@UBOT> hello", channel: "C1", user: "U1" },
    });
    const req = buildRequest(body);
    const res = await POST(req);
    expect(res.status).toBe(200);
    // Dispatcher must NOT have been called synchronously.
    expect(dispatchEventMock).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    // Run the queued after() callback and verify it dispatched.
    await afterCallbacks[0]?.();
    expect(getSlackClientMock).toHaveBeenCalledWith("xoxb-test");
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    const call = dispatchEventMock.mock.calls[0];
    expect(call).toBeDefined();
    const callArg = call![0] as {
      apiAppId: string;
      payload: { event?: { type?: string } };
    };
    expect(callArg.apiAppId).toBe(APP);
    expect(callArg.payload.event?.type).toBe("app_mention");
  });

  it("returns 400 for unparseable JSON body", async () => {
    const req = buildRequest("not-json", { omitSignatureHeaders: true });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(afterCallbacks).toHaveLength(0);
  });
});
