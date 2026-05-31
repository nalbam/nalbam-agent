/**
 * Memory store (architecture §5.5) — three tiers.
 *
 *   - short-term: conversation history (scope = channel:tenant:conversation)
 *   - long-term:  user memory (scope = mem:channel:tenant:user)
 *   - search:     optional embedding-based episodic recall
 */
import type { HistoryEntry } from "@/core/types";

export interface AppendOptions {
  maxChars?: number;
  expectedVersion?: number;
}

export interface MemoryStore {
  loadConversation(scope: string): Promise<HistoryEntry[]>;
  appendConversation(scope: string, turns: HistoryEntry[], opts?: AppendOptions): Promise<void>;

  remember(userScope: string, note: string): Promise<void>;
  forget(userScope: string, query: string): Promise<void>;
  loadUserMemory(userScope: string): Promise<string[]>;

  /** Optional embedding search — reserved; may be undefined until implemented. */
  search?(scope: string, query: string, k: number): Promise<HistoryEntry[]>;
}
