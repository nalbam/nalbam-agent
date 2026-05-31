/**
 * Channel adapter contract (architecture §5.1).
 *
 * Each channel implements four responsibilities: verify/parse inbound,
 * normalize to `InboundMessage`, expose access-control inputs, render
 * outbound. The rest of the system never sees a channel-native type.
 */
import type { InboundMessage, OutboundChunk, MediaRef, HistoryEntry } from "@/core/types";
import type { CredentialRef } from "@/credentials/types";

export type ChannelMode = "webhook" | "connection" | "http";

export interface RawIngress {
  headers: Record<string, string | null>;
  /** Exact bytes as received — signature verification runs on these. */
  rawBody: string;
}

export interface IngestResult {
  messages: InboundMessage[];
  /** Immediate response (e.g. url_verification challenge) bypassing the agent. */
  ack?: { status: number; body?: string };
}

export interface ChannelHttpResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface Responder {
  append(chunk: OutboundChunk): Promise<void>;
  finalize(text: string, media?: MediaRef[]): Promise<void>;
  status?(text: string): Promise<void>;
}

export interface Profile {
  userId: string;
  displayName: string;
  imageUrl?: string;
}

export interface AttachmentRef {
  url: string;
  mime?: string;
}

/**
 * Channel-provided capabilities. Capability-bound tools depend only on these;
 * a tool is registered only when the channel provides every capability it needs.
 */
export interface Capabilities {
  fetchHistory?(limit: number): Promise<HistoryEntry[]>;
  downloadAttachment?(ref: AttachmentRef): Promise<Uint8Array>;
  uploadMedia?(media: MediaRef): Promise<{ url: string }>;
  fetchUserProfile?(userId: string): Promise<Profile>;
  describeImage?(data: Uint8Array, mime: string): Promise<string>;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly mode: ChannelMode;
  ingest(input: RawIngress): Promise<IngestResult>;
  credentials(tenantId: string): CredentialRef;
  responder(msg: InboundMessage): Responder;
  capabilities(msg: InboundMessage): Capabilities;
  /** Channel markup rules injected into the system prompt. */
  renderingRules(): string;
  /** Optional synchronous response renderer for `mode: "http"` channels. */
  httpResponse?(msg: InboundMessage): Promise<ChannelHttpResponse>;
}
