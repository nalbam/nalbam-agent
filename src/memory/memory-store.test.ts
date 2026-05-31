import { describe, expect, it } from "vitest";

import { createMemoryStore } from "@/memory/memory-store";

describe("createMemoryStore", () => {
  it("keeps conversation history isolated by scope", async () => {
    const memory = createMemoryStore();
    await memory.appendConversation("slack:t1:c1", [{ author: "u1", text: "a", ts: "1" }]);
    await memory.appendConversation("slack:t2:c1", [{ author: "u1", text: "b", ts: "1" }]);
    expect(await memory.loadConversation("slack:t1:c1")).toEqual([
      { author: "u1", text: "a", ts: "1" },
    ]);
  });

  it("trims oldest turns when maxChars is set", async () => {
    const memory = createMemoryStore();
    await memory.appendConversation(
      "s",
      [
        { author: "u", text: "111", ts: "1" },
        { author: "a", text: "222", ts: "2" },
        { author: "u", text: "333", ts: "3" },
      ],
      { maxChars: 6 },
    );
    expect(await memory.loadConversation("s")).toEqual([
      { author: "a", text: "222", ts: "2" },
      { author: "u", text: "333", ts: "3" },
    ]);
  });

  it("stores user memory independently by scope", async () => {
    const memory = createMemoryStore();
    await memory.remember("mem:slack:t1:u1", "likes short answers");
    await memory.remember("mem:slack:t2:u1", "uses English");
    await memory.forget("mem:slack:t1:u1", "short");
    expect(await memory.loadUserMemory("mem:slack:t1:u1")).toEqual([]);
    expect(await memory.loadUserMemory("mem:slack:t2:u1")).toEqual(["uses English"]);
  });
});
