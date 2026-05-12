import { describe, expect, it } from "vitest";

import { truncateToChars, type ThreadMessage } from "@/lib/slack/conversation";

const msg = (role: ThreadMessage["role"], content: string): ThreadMessage => ({
  role,
  content,
});

describe("truncateToChars", () => {
  it("returns empty for empty input", () => {
    expect(truncateToChars([], 100)).toEqual([]);
  });

  it("keeps all when serialized size fits", () => {
    const xs = [msg("user", "hi"), msg("assistant", "hey")];
    expect(truncateToChars(xs, 1000)).toEqual(xs);
  });

  it("drops oldest until it fits", () => {
    const xs = [
      msg("user", "very very very long message 0"),
      msg("assistant", "short"),
      msg("user", "ok"),
    ];
    const kept = truncateToChars(xs, JSON.stringify([xs[1], xs[2]]).length + 0);
    expect(kept).toEqual([xs[1], xs[2]]);
  });

  it("kept[]-serialized length is always <= maxChars", () => {
    const xs: ThreadMessage[] = [];
    for (let i = 0; i < 20; i += 1) {
      xs.push(msg(i % 2 === 0 ? "user" : "assistant", `message ${i} `.repeat(5)));
    }
    for (const budget of [50, 200, 500, 1000, 5000]) {
      const kept = truncateToChars(xs, budget);
      expect(JSON.stringify(kept).length).toBeLessThanOrEqual(budget);
    }
  });

  it("returns empty if even the newest message doesn't fit", () => {
    const xs = [msg("user", "x".repeat(100))];
    expect(truncateToChars(xs, 5)).toEqual([]);
  });

  it("preserves order of kept messages (newest is last)", () => {
    const xs = [msg("user", "one"), msg("user", "two"), msg("user", "three")];
    const kept = truncateToChars(xs, 50);
    expect(kept[kept.length - 1]?.content).toBe("three");
  });
});
