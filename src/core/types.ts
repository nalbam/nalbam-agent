/**
 * Channel-agnostic domain model (architecture §4).
 *
 * Channel adapters normalize native payloads into `InboundMessage` and the
 * core emits `OutboundChunk`s; no channel-native type crosses this boundary.
 */

export type Surface = "dm" | "channel" | "thread" | "direct";

export interface MediaRef {
  url?: string;
  data?: Uint8Array;
  mime: string;
  name?: string;
}

export interface Attachment {
  url: string;
  mime: string;
  name?: string;
}

export interface InboundMessage {
  channel: string;
  tenantId: string;
  conversationId: string;
  userId: string;
  text: string;
  attachments: Attachment[];
  mentions: string[];
  surface: Surface;
  /** Channel-provided idempotency key. */
  dedupKey: string;
  receivedAt: number;
  /** Original payload — for debugging only; core logic must not read it. */
  raw: unknown;
}

export interface OutboundChunk {
  /** Markdown-neutral text; the adapter renders to the channel dialect. */
  text: string;
  kind: "delta" | "final";
  media?: MediaRef[];
}

export interface HistoryEntry {
  author: string;
  text: string;
  ts: string;
}
