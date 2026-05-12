import { describe, expect, it } from "vitest";

import { safeInternalPath } from "./safe-redirect";

describe("safeInternalPath", () => {
  const FALLBACK = "/dashboard";

  it("returns the fallback for null / undefined / empty string", () => {
    expect(safeInternalPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath("", FALLBACK)).toBe(FALLBACK);
  });

  it("accepts simple internal paths", () => {
    expect(safeInternalPath("/", FALLBACK)).toBe("/");
    expect(safeInternalPath("/dashboard", FALLBACK)).toBe("/dashboard");
    expect(safeInternalPath("/settings?tab=billing", FALLBACK)).toBe("/settings?tab=billing");
    expect(safeInternalPath("/path/with/segments", FALLBACK)).toBe("/path/with/segments");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeInternalPath("//evil.example.com", FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath("//evil.example.com/path", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects absolute URLs", () => {
    expect(safeInternalPath("https://evil.example.com", FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath("http://evil.example.com/path", FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath("javascript:alert(1)", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects backslash variants that some browsers normalize to //", () => {
    expect(safeInternalPath("/\\evil.example.com", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects relative paths (no leading slash)", () => {
    expect(safeInternalPath("dashboard", FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath("./relative", FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath("../up", FALLBACK)).toBe(FALLBACK);
  });
});
