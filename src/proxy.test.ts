import { describe, expect, it } from "vitest";

import { proxy } from "./proxy";

const buildRequest = (cookieNames: string[], pathname = "/dashboard", search = "") =>
  ({
    url: `http://localhost:3000${pathname}${search}`,
    nextUrl: { pathname, search },
    cookies: {
      getAll: () => cookieNames.map((name) => ({ name, value: "x" })),
    },
  }) as never;

describe("proxy", () => {
  it("redirects to /login when no session cookie present and preserves the redirect target", () => {
    const res = proxy(buildRequest([])) as { status: number; headers: Headers };
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/\/login\?/);
    expect(new URL(location).searchParams.get("redirect")).toBe("/dashboard");
  });

  it("propagates query string into the redirect param", () => {
    const res = proxy(buildRequest([], "/dashboard", "?tab=billing")) as {
      status: number;
      headers: Headers;
    };
    const location = res.headers.get("location") ?? "";
    expect(new URL(location).searchParams.get("redirect")).toBe("/dashboard?tab=billing");
  });

  it("passes through with the bare session cookie name", () => {
    const res = proxy(buildRequest(["better-auth.session_token"])) as { status: number };
    // NextResponse.next() returns a 200 with no body in tests.
    expect(res.status).toBe(200);
  });

  it("passes through with __Secure- prefix", () => {
    const res = proxy(buildRequest(["__Secure-better-auth.session_token"])) as { status: number };
    expect(res.status).toBe(200);
  });

  it("passes through with .<n> suffix chunks (large session)", () => {
    const res = proxy(buildRequest(["better-auth.session_token.0"])) as { status: number };
    expect(res.status).toBe(200);
  });

  it("ignores unrelated cookies", () => {
    const res = proxy(buildRequest(["unrelated", "csrf_token"])) as { status: number };
    expect(res.status).toBe(307);
  });
});
