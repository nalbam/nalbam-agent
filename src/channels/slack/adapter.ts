/**
 * Slack channel adapter (architecture §5.1).
 *
 * Handles Events API webhook verification, normalization, outbound rendering,
 * and capability wiring.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { WebClient } from "@slack/web-api";
import { z } from "zod";

import { defineChannel } from "@/channels/registry";
import type {
  Capabilities,
  ChannelAdapter,
  IngestResult,
  RawIngress,
  Responder,
} from "@/channels/types";
import { getSlackCredentialProvider } from "@/channels/slack/credentials";
import type { HistoryEntry, InboundMessage, MediaRef, OutboundChunk } from "@/core/types";
import type { CredentialRef } from "@/credentials/types";

const SLACK_RENDERING_RULES = [
  "Slack renders mrkdwn, not GitHub markdown.",
  "Use *bold* (single asterisks), _italic_, `code`, and <https://url|label> for links.",
  "Do NOT use **bold** or [label](url) — those render as raw text in Slack.",
].join(" ");

interface SlackWebClient {
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    update(args: Record<string, unknown>): Promise<unknown>;
  };
  conversations: {
    history(args: Record<string, unknown>): Promise<{ messages?: unknown[] }>;
    replies(args: Record<string, unknown>): Promise<{ messages?: unknown[] }>;
  };
  users: {
    info(args: Record<string, unknown>): Promise<{ user?: unknown }>;
  };
  filesUploadV2(args: Record<string, unknown>): Promise<{ files?: unknown[] }>;
}

type SlackWebClientFactory = (botToken: string) => SlackWebClient;

let webClientFactory: SlackWebClientFactory = (botToken) =>
  new WebClient(botToken) as unknown as SlackWebClient;

export const __setSlackWebClientFactoryForTests = (
  factory: SlackWebClientFactory | undefined,
): void => {
  webClientFactory =
    factory ?? ((botToken) => new WebClient(botToken) as unknown as SlackWebClient);
};

const slackFileSchema = z.object({
  url_private: z.string().url().optional(),
  mimetype: z.string().optional(),
  name: z.string().optional(),
});

const slackEventSchema = z.object({
  type: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  channel: z.string().optional(),
  channel_type: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  files: z.array(slackFileSchema).optional(),
});

const slackPayloadSchema = z.object({
  type: z.string(),
  api_app_id: z.string().min(1),
  team_id: z.string().min(1).optional(),
  event_id: z.string().optional(),
  event_time: z.number().optional(),
  challenge: z.string().optional(),
  event: slackEventSchema.optional(),
});

const SLACK_MAX_TEXT = 35_000;

const extractHeader = (headers: RawIngress["headers"], name: string): string | null =>
  headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null;

const verifySlackSignature = async (
  input: RawIngress,
  apiAppId: string,
  now: () => number = () => Date.now(),
): Promise<boolean> => {
  const timestamp = extractHeader(input.headers, "x-slack-request-timestamp");
  const signature = extractHeader(input.headers, "x-slack-signature");
  if (!timestamp || !signature) return false;

  const seconds = Number.parseInt(timestamp, 10);
  if (Number.isNaN(seconds)) return false;
  if (Math.abs(Math.floor(now() / 1000) - seconds) > 60 * 5) return false;

  const credentials = await getSlackCredentialProvider().getAppCredentials(apiAppId);
  if (!credentials) return false;

  const base = `v0:${timestamp}:${input.rawBody}`;
  const expected = `v0=${createHmac("sha256", credentials.signingSecret).update(base).digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
};

const extractMentions = (text: string): string[] => {
  const mentions = new Set<string>();
  for (const match of text.matchAll(/<@([A-Z0-9]+)>/g)) {
    const userId = match[1];
    if (userId) mentions.add(userId);
  }
  return [...mentions];
};

const normalizeText = (text: string): string => text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();

const surfaceFor = (event: z.infer<typeof slackEventSchema>) => {
  if (event.channel_type === "im") return "dm" as const;
  if (event.thread_ts && event.thread_ts !== event.ts) return "thread" as const;
  return "channel" as const;
};

const normalizeEvent = (
  payload: z.infer<typeof slackPayloadSchema>,
): InboundMessage | undefined => {
  const event = payload.event;
  if (!event) return undefined;
  if (event.type !== "app_mention" && event.type !== "message") return undefined;
  if (!event.user || event.bot_id || event.subtype) return undefined;
  if (!event.channel || !event.ts) return undefined;

  const text = event.text ?? "";
  const attachments =
    event.files
      ?.filter((file) => file.url_private && file.mimetype)
      .map((file) => ({
        url: file.url_private as string,
        mime: file.mimetype as string,
        name: file.name,
      })) ?? [];

  return {
    channel: "slack",
    tenantId: payload.team_id ?? payload.api_app_id,
    conversationId: event.thread_ts ?? event.channel,
    userId: event.user,
    text: normalizeText(text),
    attachments,
    mentions: extractMentions(text),
    surface: surfaceFor(event),
    dedupKey: payload.event_id ?? `${event.channel}:${event.ts}`,
    receivedAt: (payload.event_time ?? Math.floor(Date.now() / 1000)) * 1000,
    raw: payload,
  };
};

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const rawPayload = (msg: InboundMessage): z.infer<typeof slackPayloadSchema> | undefined => {
  const parsed = slackPayloadSchema.safeParse(msg.raw);
  return parsed.success ? parsed.data : undefined;
};

const slackContext = (msg: InboundMessage) => {
  const payload = rawPayload(msg);
  const event = payload?.event;
  return {
    apiAppId: payload?.api_app_id ?? msg.tenantId,
    channelId: event?.channel ?? msg.conversationId,
    threadTs: event?.thread_ts ?? (msg.surface === "dm" ? undefined : event?.ts),
  };
};

const getSlackClient = async (apiAppId: string): Promise<SlackWebClient> => {
  const credentials = await getSlackCredentialProvider().getAppCredentials(apiAppId);
  if (!credentials?.botToken) {
    throw new Error(`Slack bot token is not configured for app ${apiAppId}.`);
  }
  return webClientFactory(credentials.botToken);
};

const splitSlackText = (text: string): string[] => {
  if (!text) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += SLACK_MAX_TEXT) {
    chunks.push(text.slice(index, index + SLACK_MAX_TEXT));
  }
  return chunks;
};

const displayNameFor = (user: Record<string, unknown>, fallback: string): string => {
  const profile = asObject(user.profile);
  return (
    (typeof profile.display_name === "string" && profile.display_name) ||
    (typeof profile.real_name === "string" && profile.real_name) ||
    (typeof user.name === "string" && user.name) ||
    fallback
  );
};

class SlackResponder implements Responder {
  private readonly apiAppId: string;
  private readonly channelId: string;
  private readonly threadTs?: string;
  private buffer = "";
  private statusTs?: string;

  constructor(msg: InboundMessage) {
    const context = slackContext(msg);
    this.apiAppId = context.apiAppId;
    this.channelId = context.channelId;
    this.threadTs = context.threadTs;
  }

  async append(chunk: OutboundChunk): Promise<void> {
    if (chunk.text) this.buffer += chunk.text;
  }

  async status(text: string): Promise<void> {
    const client = await getSlackClient(this.apiAppId);
    const response = await client.chat.postMessage({
      channel: this.channelId,
      text,
      thread_ts: this.threadTs,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
    this.statusTs = response.ts;
  }

  async finalize(text: string, media: MediaRef[] = []): Promise<void> {
    const client = await getSlackClient(this.apiAppId);
    const chunks = splitSlackText(text || this.buffer);

    const [first, ...rest] = chunks;
    if (this.statusTs) {
      await client.chat.update({
        channel: this.channelId,
        ts: this.statusTs,
        text: first,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      });
    } else {
      await client.chat.postMessage({
        channel: this.channelId,
        text: first,
        thread_ts: this.threadTs,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      });
    }

    for (const chunk of rest) {
      await client.chat.postMessage({
        channel: this.channelId,
        text: chunk,
        thread_ts: this.threadTs,
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      });
    }

    for (const item of media) {
      await uploadSlackMedia(client, this.channelId, this.threadTs, item);
    }
  }
}

const uploadSlackMedia = async (
  client: SlackWebClient,
  channelId: string,
  threadTs: string | undefined,
  media: MediaRef,
): Promise<{ url: string }> => {
  if (!media.data) {
    if (!media.url) throw new Error("slack.uploadMedia requires inline data or a URL.");
    await client.chat.postMessage({
      channel: channelId,
      text: media.url,
      thread_ts: threadTs,
      unfurl_links: true,
      unfurl_media: true,
    });
    return { url: media.url };
  }

  const response = await client.filesUploadV2({
    channel_id: channelId,
    thread_ts: threadTs,
    filename: media.name ?? "media",
    title: media.name ?? "media",
    file: Buffer.from(media.data),
  });
  const file = asObject(response.files?.[0]);
  const url =
    (typeof file.permalink === "string" && file.permalink) ||
    (typeof file.url_private === "string" && file.url_private) ||
    "";
  return { url };
};

const assertSlackFileUrl = (url: string): void => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".slack.com")) {
    throw new Error("slack.downloadAttachment only accepts Slack-hosted HTTPS file URLs.");
  }
};

const toHistoryEntry = (message: unknown): HistoryEntry | undefined => {
  const item = asObject(message);
  const ts = typeof item.ts === "string" ? item.ts : undefined;
  if (!ts) return undefined;
  return {
    author:
      (typeof item.user === "string" && item.user) ||
      (typeof item.bot_id === "string" && item.bot_id) ||
      "unknown",
    text: typeof item.text === "string" ? item.text : "",
    ts,
  };
};

export const slackChannel: ChannelAdapter = defineChannel({
  id: "slack",
  mode: "webhook",

  async ingest(input: RawIngress): Promise<IngestResult> {
    let json: unknown;
    try {
      json = JSON.parse(input.rawBody) as unknown;
    } catch {
      return { messages: [], ack: { status: 400, body: "invalid json" } };
    }

    const parsed = slackPayloadSchema.safeParse(json);
    if (!parsed.success) {
      return { messages: [], ack: { status: 400, body: "invalid slack payload" } };
    }

    if (!(await verifySlackSignature(input, parsed.data.api_app_id))) {
      return { messages: [], ack: { status: 401, body: "invalid signature" } };
    }

    if (parsed.data.type === "url_verification") {
      return { messages: [], ack: { status: 200, body: parsed.data.challenge ?? "" } };
    }

    if (parsed.data.type !== "event_callback") {
      return { messages: [] };
    }

    const message = normalizeEvent(parsed.data);
    return { messages: message ? [message] : [] };
  },

  credentials(tenantId: string): CredentialRef {
    return { channel: "slack", tenantId };
  },

  responder(msg: InboundMessage): Responder {
    return new SlackResponder(msg);
  },

  capabilities(msg: InboundMessage): Capabilities {
    const context = slackContext(msg);
    return {
      fetchHistory: async (limit) => {
        const client = await getSlackClient(context.apiAppId);
        const response = context.threadTs
          ? await client.conversations.replies({
              channel: context.channelId,
              ts: context.threadTs,
              limit,
            })
          : await client.conversations.history({
              channel: context.channelId,
              limit,
            });
        return (response.messages ?? []).map(toHistoryEntry).filter((entry) => entry !== undefined);
      },
      downloadAttachment: async (ref) => {
        assertSlackFileUrl(ref.url);
        const credentials = await getSlackCredentialProvider().getAppCredentials(context.apiAppId);
        if (!credentials?.botToken) {
          throw new Error(`Slack bot token is not configured for app ${context.apiAppId}.`);
        }
        const response = await fetch(ref.url, {
          headers: { authorization: `Bearer ${credentials.botToken}` },
        });
        if (!response.ok) {
          throw new Error(`Slack attachment download failed with status ${response.status}.`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      uploadMedia: async (media) => {
        const client = await getSlackClient(context.apiAppId);
        return uploadSlackMedia(client, context.channelId, context.threadTs, media);
      },
      fetchUserProfile: async (userId) => {
        const client = await getSlackClient(context.apiAppId);
        const response = await client.users.info({ user: userId });
        const user = asObject(response.user);
        const profile = asObject(user.profile);
        return {
          userId,
          displayName: displayNameFor(user, userId),
          imageUrl: typeof profile.image_72 === "string" ? profile.image_72 : undefined,
        };
      },
    };
  },

  renderingRules(): string {
    return SLACK_RENDERING_RULES;
  },
});
