import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setSlackWebClientFactoryForTests, slackChannel } from "@/channels/slack/adapter";
import { __setSlackCredentialProviderForTests } from "@/channels/slack/credentials";
import type { RawIngress } from "@/channels/types";
import type { InboundMessage } from "@/core/types";

const SECRET = "slack-signing-secret";

const signed = (body: unknown, timestamp = Math.floor(Date.now() / 1000)): RawIngress => {
  const rawBody = JSON.stringify(body);
  const signature = `v0=${createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return {
    headers: {
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    rawBody,
  };
};

describe("slackChannel", () => {
  const calls = {
    postMessage: [] as Record<string, unknown>[],
    update: [] as Record<string, unknown>[],
    history: [] as Record<string, unknown>[],
    replies: [] as Record<string, unknown>[],
    usersInfo: [] as Record<string, unknown>[],
    uploads: [] as Record<string, unknown>[],
  };

  beforeEach(() => {
    __setSlackCredentialProviderForTests({
      async getAppCredentials(apiAppId) {
        return apiAppId === "A123" ? { signingSecret: SECRET, botToken: "xoxb-token" } : null;
      },
    });
    Object.values(calls).forEach((items) => {
      items.length = 0;
    });
    __setSlackWebClientFactoryForTests(() => ({
      chat: {
        async postMessage(args) {
          calls.postMessage.push(args);
          return { ts: `post-${calls.postMessage.length}` };
        },
        async update(args) {
          calls.update.push(args);
          return {};
        },
      },
      conversations: {
        async history(args) {
          calls.history.push(args);
          return { messages: [{ user: "U1", text: "hello", ts: "1.0" }] };
        },
        async replies(args) {
          calls.replies.push(args);
          return { messages: [{ user: "U2", text: "reply", ts: "2.0" }] };
        },
      },
      users: {
        async info(args) {
          calls.usersInfo.push(args);
          return {
            user: {
              id: "U1",
              name: "fallback",
              profile: { display_name: "Ada", image_72: "https://example.com/a.png" },
            },
          };
        },
      },
      async filesUploadV2(args) {
        calls.uploads.push(args);
        return { files: [{ permalink: "https://slack.com/files/F1" }] };
      },
    }));
  });

  afterEach(() => {
    __setSlackCredentialProviderForTests(undefined);
    __setSlackWebClientFactoryForTests(undefined);
    vi.unstubAllGlobals();
  });

  it("responds to signed url_verification challenges", async () => {
    const result = await slackChannel.ingest(
      signed({
        type: "url_verification",
        api_app_id: "A123",
        team_id: "T123",
        challenge: "challenge-token",
      }),
    );
    expect(result).toEqual({ messages: [], ack: { status: 200, body: "challenge-token" } });
  });

  it("rejects invalid signatures", async () => {
    const input = signed({
      type: "url_verification",
      api_app_id: "A123",
      team_id: "T123",
      challenge: "challenge-token",
    });
    input.headers["x-slack-signature"] = "v0=bad";
    const result = await slackChannel.ingest(input);
    expect(result).toEqual({ messages: [], ack: { status: 401, body: "invalid signature" } });
  });

  it("rejects replayed timestamps", async () => {
    const result = await slackChannel.ingest(
      signed(
        {
          type: "url_verification",
          api_app_id: "A123",
          team_id: "T123",
          challenge: "challenge-token",
        },
        Math.floor(Date.now() / 1000) - 600,
      ),
    );
    expect(result).toEqual({ messages: [], ack: { status: 401, body: "invalid signature" } });
  });

  it("normalizes app_mention events into InboundMessage", async () => {
    const result = await slackChannel.ingest(
      signed({
        type: "event_callback",
        api_app_id: "A123",
        team_id: "T123",
        event_id: "Ev123",
        event_time: 1_700_000_000,
        event: {
          type: "app_mention",
          user: "U123",
          text: "<@UBOT> hello <@U999>",
          channel: "C123",
          channel_type: "channel",
          ts: "1700000000.000100",
          thread_ts: "1700000000.000000",
          files: [
            {
              url_private: "https://files.slack.com/files-pri/T123-F123/a.txt",
              mimetype: "text/plain",
              name: "a.txt",
            },
          ],
        },
      }),
    );

    expect(result.ack).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      channel: "slack",
      tenantId: "T123",
      conversationId: "1700000000.000000",
      userId: "U123",
      text: "hello",
      mentions: ["UBOT", "U999"],
      surface: "thread",
      dedupKey: "Ev123",
      receivedAt: 1_700_000_000_000,
      attachments: [
        {
          url: "https://files.slack.com/files-pri/T123-F123/a.txt",
          mime: "text/plain",
          name: "a.txt",
        },
      ],
    });
  });

  it("ignores bot and subtype events", async () => {
    const result = await slackChannel.ingest(
      signed({
        type: "event_callback",
        api_app_id: "A123",
        team_id: "T123",
        event_id: "Ev123",
        event: {
          type: "message",
          user: "U123",
          bot_id: "B123",
          text: "bot",
          channel: "C123",
          ts: "1700000000.000100",
        },
      }),
    );
    expect(result).toEqual({ messages: [] });
  });

  it("posts status and updates the final response in the source thread", async () => {
    const msg = inboundMessage({
      type: "app_mention",
      user: "U123",
      text: "<@UBOT> hello",
      channel: "C123",
      channel_type: "channel",
      ts: "1700000000.000100",
      thread_ts: undefined,
    });

    const responder = slackChannel.responder(msg);
    await responder.status?.("thinking");
    await responder.append({ kind: "delta", text: "ignored when final text is present" });
    await responder.finalize("done");

    expect(calls.postMessage).toEqual([
      {
        channel: "C123",
        text: "thinking",
        thread_ts: "1700000000.000100",
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      },
    ]);
    expect(calls.update).toEqual([
      {
        channel: "C123",
        ts: "post-1",
        text: "done",
        mrkdwn: true,
        unfurl_links: false,
        unfurl_media: false,
      },
    ]);
  });

  it("chunks long Slack responses and uploads inline media", async () => {
    const msg = inboundMessage();
    await slackChannel
      .responder(msg)
      .finalize("a".repeat(35_001), [
        { data: new TextEncoder().encode("file"), mime: "text/plain", name: "a.txt" },
      ]);

    expect(calls.postMessage).toHaveLength(2);
    expect(String(calls.postMessage[0]?.text)).toHaveLength(35_000);
    expect(String(calls.postMessage[1]?.text)).toHaveLength(1);
    expect(calls.uploads[0]).toMatchObject({
      channel_id: "C123",
      thread_ts: "1700000000.000000",
      filename: "a.txt",
      title: "a.txt",
    });
  });

  it("provides Slack capabilities", async () => {
    const msg = inboundMessage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("downloaded", { status: 200 })),
    );

    const caps = slackChannel.capabilities(msg);

    await expect(caps.fetchHistory?.(3)).resolves.toEqual([
      { author: "U2", text: "reply", ts: "2.0" },
    ]);
    await expect(
      caps.downloadAttachment?.({
        url: "https://files.slack.com/files-pri/T123-F123/a.txt",
        mime: "text/plain",
      }),
    ).resolves.toEqual(new TextEncoder().encode("downloaded"));
    await expect(
      caps.uploadMedia?.({
        data: new TextEncoder().encode("file"),
        mime: "text/plain",
        name: "a.txt",
      }),
    ).resolves.toEqual({ url: "https://slack.com/files/F1" });
    await expect(caps.fetchUserProfile?.("U1")).resolves.toEqual({
      userId: "U1",
      displayName: "Ada",
      imageUrl: "https://example.com/a.png",
    });

    expect(calls.replies).toEqual([{ channel: "C123", ts: "1700000000.000000", limit: 3 }]);
    expect(fetch).toHaveBeenCalledWith("https://files.slack.com/files-pri/T123-F123/a.txt", {
      headers: { authorization: "Bearer xoxb-token" },
    });
    expect(calls.usersInfo).toEqual([{ user: "U1" }]);
  });

  it("rejects non-Slack attachment downloads", async () => {
    const caps = slackChannel.capabilities(inboundMessage());
    await expect(
      caps.downloadAttachment?.({ url: "https://example.com/a.txt", mime: "text/plain" }),
    ).rejects.toThrow("Slack-hosted HTTPS file URLs");
  });
});

const inboundMessage = (eventOverride: Record<string, unknown> = {}): InboundMessage => ({
  channel: "slack",
  tenantId: "T123",
  conversationId: "1700000000.000000",
  userId: "U123",
  text: "hello",
  attachments: [],
  mentions: [],
  surface: "thread",
  dedupKey: "Ev123",
  receivedAt: 1_700_000_000_000,
  raw: {
    type: "event_callback",
    api_app_id: "A123",
    team_id: "T123",
    event_id: "Ev123",
    event_time: 1_700_000_000,
    event: {
      type: "app_mention",
      user: "U123",
      text: "<@UBOT> hello",
      channel: "C123",
      channel_type: "channel",
      ts: "1700000000.000100",
      thread_ts: "1700000000.000000",
      ...eventOverride,
    },
  },
});
