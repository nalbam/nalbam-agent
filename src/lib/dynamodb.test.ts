import { describe, expect, it } from "vitest";

import { gsi1, keys, sanitizeKeyValue, ttlFromDate, validateId } from "./dynamodb";

describe("validateId", () => {
  it.each([["abc"], ["a1b2c3"], ["with-dash"], ["with_underscore"], ["a".repeat(256)]])(
    "accepts %s",
    (id) => {
      expect(validateId(id)).toBe(id);
    },
  );

  it.each([
    ["empty", ""],
    ["too long", "a".repeat(257)],
    ["with space", "a b"],
    ["with slash", "a/b"],
    ["with hash", "a#b"],
    ["with dot", "a.b"],
    ["with unicode", "abc한글"],
  ])("rejects %s", (_label, id) => {
    expect(() => validateId(id)).toThrow();
  });
});

describe("sanitizeKeyValue", () => {
  it("accepts plain emails", () => {
    expect(sanitizeKeyValue("user@example.com")).toBe("user@example.com");
  });

  it("rejects empty string", () => {
    expect(() => sanitizeKeyValue("")).toThrow();
  });

  it("rejects strings with control characters", () => {
    expect(() => sanitizeKeyValue("ab\ncd")).toThrow();
    expect(() => sanitizeKeyValue("a\tb")).toThrow();
  });

  it("rejects strings exceeding 1024 chars", () => {
    expect(() => sanitizeKeyValue("a".repeat(1025))).toThrow();
  });
});

describe("keys", () => {
  it("builds a user key", () => {
    expect(keys.user("abc")).toEqual({ PK: "USER#abc", SK: "PROFILE" });
  });

  it("builds a project key", () => {
    expect(keys.project("p1")).toEqual({ PK: "PROJECT#p1", SK: "META" });
  });

  it("builds a userProject composite key", () => {
    expect(keys.userProject("u1", "p1")).toEqual({
      PK: "USER#u1",
      SK: "PROJECT#p1",
    });
  });

  it("validates ids on both sides of userProject", () => {
    expect(() => keys.userProject("ok", "bad id")).toThrow();
    expect(() => keys.userProject("bad id", "ok")).toThrow();
  });
});

describe("gsi1.byEmail", () => {
  it("lowercases the email", () => {
    expect(gsi1.byEmail("USER@Example.COM")).toEqual({
      GSI1PK: "EMAIL#user@example.com",
      GSI1SK: "USER",
    });
  });

  it("rejects empty email", () => {
    expect(() => gsi1.byEmail("")).toThrow();
  });
});

describe("ttlFromDate", () => {
  it("converts a Date to epoch seconds", () => {
    const ms = 1_700_000_000_000;
    expect(ttlFromDate(new Date(ms))).toBe(Math.floor(ms / 1000));
  });

  it("accepts ISO strings", () => {
    const iso = "2030-01-01T00:00:00.000Z";
    const expected = Math.floor(new Date(iso).getTime() / 1000);
    expect(ttlFromDate(iso)).toBe(expected);
  });

  it("rejects invalid input", () => {
    expect(() => ttlFromDate("not-a-date")).toThrow();
  });
});
