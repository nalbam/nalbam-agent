import type { HistoryEntry } from "@/core/types";
import type { AppendOptions, MemoryStore } from "@/memory/types";

interface ConversationState {
  version: number;
  turns: HistoryEntry[];
}

export const createMemoryStore = (): MemoryStore => {
  const conversations = new Map<string, ConversationState>();
  const userMemory = new Map<string, string[]>();

  const trimTurns = (turns: HistoryEntry[], maxChars: number | undefined): HistoryEntry[] => {
    if (maxChars === undefined) return turns;

    const kept: HistoryEntry[] = [];
    let used = 0;
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (!turn) continue;
      const size = turn.text.length;
      if (used + size > maxChars && kept.length > 0) break;
      kept.unshift(turn);
      used += size;
      if (used >= maxChars) break;
    }
    return kept;
  };

  return {
    async loadConversation(scope) {
      return [...(conversations.get(scope)?.turns ?? [])];
    },
    async appendConversation(scope, turns, opts: AppendOptions = {}) {
      const current = conversations.get(scope) ?? { version: 0, turns: [] };
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
        throw new Error("Conversation version conflict.");
      }
      conversations.set(scope, {
        version: current.version + 1,
        turns: trimTurns([...current.turns, ...turns], opts.maxChars),
      });
    },
    async remember(userScope, note) {
      const trimmed = note.trim();
      if (!trimmed) return;
      const current = userMemory.get(userScope) ?? [];
      if (!current.includes(trimmed)) {
        userMemory.set(userScope, [...current, trimmed]);
      }
    },
    async forget(userScope, query) {
      const needle = query.trim().toLowerCase();
      if (!needle) return;
      const current = userMemory.get(userScope) ?? [];
      userMemory.set(
        userScope,
        current.filter((note) => !note.toLowerCase().includes(needle)),
      );
    },
    async loadUserMemory(userScope) {
      return [...(userMemory.get(userScope) ?? [])];
    },
  };
};
