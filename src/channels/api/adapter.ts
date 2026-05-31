/**
 * Token-authenticated HTTP API channel.
 *
 * This is the second bundled channel used to validate that a new transport can
 * join through the channel registry without changing `src/core`.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { defineChannel } from "@/channels/registry";
import type {
  Capabilities,
  ChannelAdapter,
  ChannelHttpResponse,
  IngestResult,
  RawIngress,
  Responder,
} from "@/channels/types";
import type { InboundMessage, OutboundChunk } from "@/core/types";
import type { CredentialRef } from "@/credentials/types";
import { getServerEnv } from "@/lib/env";
import { getStorageProvider } from "@/storage/provider";

const API_RENDERING_RULES = [
  "Return plain text unless the caller asks for another format.",
  "Avoid channel-specific markup such as Slack mrkdwn or Telegram HTML.",
].join(" ");

const attachmentSchema = z.object({
  url: z.string().url(),
  mime: z.string().min(1),
  name: z.string().optional(),
});

const bodySchema = z.object({
  conversationId: z.string().min(1).max(256).default("default"),
  userId: z.string().min(1).max(256),
  text: z.string().min(1),
  dedupKey: z.string().min(1).max(512).optional(),
  attachments: z.array(attachmentSchema).default([]),
});

interface ApiToken {
  tenantId: string;
  tokenHash: string;
}

class ApiResponder implements Responder {
  readonly chunks: OutboundChunk[] = [];
  text = "";

  async append(chunk: OutboundChunk): Promise<void> {
    this.chunks.push(chunk);
    if (chunk.text) this.text += chunk.text;
  }

  async finalize(text: string): Promise<void> {
    this.text = text;
    this.chunks.push({ kind: "final", text });
  }
}

const responders = new Map<string, ApiResponder>();

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const parseTokens = (): ApiToken[] => {
  const configured = getServerEnv().API_CHANNEL_TOKENS;
  if (!configured) return [];

  return configured
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator <= 0) {
        throw new Error("Invalid API_CHANNEL_TOKENS entry. Expected tenant_id:sha256_hex_token.");
      }
      return {
        tenantId: part.slice(0, separator),
        tokenHash: part.slice(separator + 1).toLowerCase(),
      };
    });
};

const constantTimeEqualHex = (leftHex: string, rightHex: string): boolean => {
  if (!/^[a-f0-9]{64}$/i.test(leftHex) || !/^[a-f0-9]{64}$/i.test(rightHex)) return false;
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
};

const extractBearerToken = (headers: RawIngress["headers"]): string | null => {
  const value = headers.authorization ?? headers.Authorization ?? null;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || null;
};

const authenticate = (input: RawIngress): ApiToken | null => {
  const token = extractBearerToken(input.headers);
  if (!token) return null;
  const incomingHash = sha256Hex(token);
  return (
    parseTokens().find((candidate) => constantTimeEqualHex(incomingHash, candidate.tokenHash)) ??
    null
  );
};

const bodyDedupKey = (rawBody: string): string => sha256Hex(rawBody);

export const apiChannel: ChannelAdapter = defineChannel({
  id: "api",
  mode: "http",

  async ingest(input: RawIngress): Promise<IngestResult> {
    const auth = authenticate(input);
    if (!auth) {
      return { messages: [], ack: { status: 401, body: "unauthorized" } };
    }

    let json: unknown;
    try {
      json = JSON.parse(input.rawBody) as unknown;
    } catch {
      return { messages: [], ack: { status: 400, body: "invalid json" } };
    }

    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return { messages: [], ack: { status: 400, body: "invalid request body" } };
    }

    const body = parsed.data;
    const responderId = randomUUID();
    responders.set(responderId, new ApiResponder());

    return {
      messages: [
        {
          channel: "api",
          tenantId: auth.tenantId,
          conversationId: body.conversationId,
          userId: body.userId,
          text: body.text,
          attachments: body.attachments,
          mentions: [],
          surface: "direct",
          dedupKey: body.dedupKey ?? bodyDedupKey(input.rawBody),
          receivedAt: Date.now(),
          raw: { responderId },
        },
      ],
    };
  },

  credentials(tenantId: string): CredentialRef {
    return { channel: "api", tenantId };
  },

  responder(msg: InboundMessage): Responder {
    const responderId =
      typeof msg.raw === "object" && msg.raw && "responderId" in msg.raw
        ? String(msg.raw.responderId)
        : "";
    return responders.get(responderId) ?? new ApiResponder();
  },

  async httpResponse(msg: InboundMessage): Promise<ChannelHttpResponse> {
    const responderId =
      typeof msg.raw === "object" && msg.raw && "responderId" in msg.raw
        ? String(msg.raw.responderId)
        : "";
    const responder = responders.get(responderId);
    if (responderId) responders.delete(responderId);
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text: responder?.text ?? "" }),
    };
  },

  capabilities(msg: InboundMessage): Capabilities {
    return {
      uploadMedia: async (media) => {
        if (!media.data) {
          throw new Error("api.uploadMedia requires inline media data.");
        }
        const ref = await getStorageProvider().blob.put({
          channel: msg.channel,
          tenantId: msg.tenantId,
          name: media.name ?? "media",
          data: media.data,
          mime: media.mime,
        });
        return { url: ref.url ?? (await getStorageProvider().blob.signedUrl(ref.key)) };
      },
    };
  },

  renderingRules(): string {
    return API_RENDERING_RULES;
  },
});
