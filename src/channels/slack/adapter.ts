/**
 * Slack channel adapter (architecture §5.1) — skeleton stub.
 *
 * Registers the "slack" webhook channel. The real ingest (HMAC verify +
 * normalize), responder (streaming chat.update), capabilities (history/
 * download/upload/profile), and SSM credentials land in a later step; for
 * now the adapter satisfies the `ChannelAdapter` contract with stubs.
 */
import { defineChannel } from "@/channels/registry";
import type {
  Capabilities,
  ChannelAdapter,
  IngestResult,
  RawIngress,
  Responder,
} from "@/channels/types";
import { NotImplementedError } from "@/core/errors";
import type { InboundMessage } from "@/core/types";
import type { CredentialRef } from "@/credentials/types";

const SLACK_RENDERING_RULES = [
  "Slack renders mrkdwn, not GitHub markdown.",
  "Use *bold* (single asterisks), _italic_, `code`, and <https://url|label> for links.",
  "Do NOT use **bold** or [label](url) — those render as raw text in Slack.",
].join(" ");

const stubResponder: Responder = {
  async append(): Promise<void> {},
  async finalize(): Promise<void> {},
};

export const slackChannel: ChannelAdapter = defineChannel({
  id: "slack",
  mode: "webhook",

  async ingest(_input: RawIngress): Promise<IngestResult> {
    throw new NotImplementedError("slack.ingest");
  },

  credentials(tenantId: string): CredentialRef {
    return { channel: "slack", tenantId };
  },

  responder(_msg: InboundMessage): Responder {
    return stubResponder;
  },

  capabilities(_msg: InboundMessage): Capabilities {
    // No capabilities wired yet → capability-bound tools stay unregistered.
    return {};
  },

  renderingRules(): string {
    return SLACK_RENDERING_RULES;
  },
});
