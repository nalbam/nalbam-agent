import type { CleanedWhere } from "better-auth/adapters";
import { describe, expect, it } from "vitest";

import { evalClause, matchesAll } from "./dynamodb-adapter";

const clause = (overrides: Partial<CleanedWhere>): CleanedWhere =>
  ({
    field: "email",
    operator: "eq",
    value: "user@example.com",
    connector: "AND",
    mode: "sensitive",
    ...overrides,
  }) as CleanedWhere;

describe("evalClause", () => {
  it("eq: case-sensitive equals matches exact string", () => {
    expect(evalClause({ email: "User@Example.com" }, clause({}))).toBe(false);
    expect(evalClause({ email: "user@example.com" }, clause({}))).toBe(true);
  });

  it("eq: insensitive mode lowercases both sides", () => {
    const c = clause({ mode: "insensitive", value: "USER@EXAMPLE.com" });
    expect(evalClause({ email: "user@example.com" }, c)).toBe(true);
  });

  it("ne: inverts equality", () => {
    expect(evalClause({ email: "a@b" }, clause({ operator: "ne", value: "x@y" }))).toBe(true);
    expect(evalClause({ email: "a@b" }, clause({ operator: "ne", value: "a@b" }))).toBe(false);
  });

  it("in / not_in: membership tests", () => {
    const cIn = clause({ operator: "in", value: ["a", "b"] as never });
    expect(evalClause({ email: "a" }, cIn)).toBe(true);
    expect(evalClause({ email: "c" }, cIn)).toBe(false);

    const cNotIn = clause({ operator: "not_in", value: ["a", "b"] as never });
    expect(evalClause({ email: "c" }, cNotIn)).toBe(true);
    expect(evalClause({ email: "a" }, cNotIn)).toBe(false);
  });

  it("contains / starts_with / ends_with: substring ops", () => {
    expect(evalClause({ email: "abcdef" }, clause({ operator: "contains", value: "cde" }))).toBe(
      true,
    );
    expect(evalClause({ email: "abcdef" }, clause({ operator: "starts_with", value: "abc" }))).toBe(
      true,
    );
    expect(evalClause({ email: "abcdef" }, clause({ operator: "ends_with", value: "def" }))).toBe(
      true,
    );
    expect(evalClause({ email: "abcdef" }, clause({ operator: "ends_with", value: "xyz" }))).toBe(
      false,
    );
  });

  it("numeric comparison operators only match numeric values", () => {
    const recordNum = { age: 30 };
    expect(evalClause(recordNum, clause({ field: "age", operator: "gt", value: 18 }))).toBe(true);
    expect(evalClause(recordNum, clause({ field: "age", operator: "gte", value: 30 }))).toBe(true);
    expect(evalClause(recordNum, clause({ field: "age", operator: "lt", value: 18 }))).toBe(false);
    expect(evalClause(recordNum, clause({ field: "age", operator: "lte", value: 30 }))).toBe(true);
  });

  it("numeric comparisons against null/undefined record values are false", () => {
    expect(evalClause({ age: null }, clause({ field: "age", operator: "gt", value: 0 }))).toBe(
      false,
    );
    expect(
      evalClause({ age: undefined }, clause({ field: "age", operator: "lt", value: 10 })),
    ).toBe(false);
  });

  it("contains on non-string record returns false (no coercion)", () => {
    expect(
      evalClause({ age: 30 }, clause({ field: "age", operator: "contains", value: "3" })),
    ).toBe(false);
  });
});

describe("matchesAll", () => {
  const record = { email: "a@b", role: "admin", verified: true };

  it("returns true for empty where", () => {
    expect(matchesAll(record, [])).toBe(true);
  });

  it("AND: all clauses must match", () => {
    const c1 = clause({ field: "email", value: "a@b" });
    const c2 = clause({ field: "role", value: "admin", connector: "AND" });
    expect(matchesAll(record, [c1, c2])).toBe(true);

    const c2bad = clause({ field: "role", value: "user", connector: "AND" });
    expect(matchesAll(record, [c1, c2bad])).toBe(false);
  });

  it("OR: any clause matches", () => {
    const c1 = clause({ field: "email", value: "x@y" });
    const c2 = clause({ field: "role", value: "admin", connector: "OR" });
    expect(matchesAll(record, [c1, c2])).toBe(true);
  });
});
