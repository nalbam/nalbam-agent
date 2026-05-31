/**
 * Unified channel ingress (architecture §5.1, webhook/http modes).
 *
 * Resolves the channel adapter, lets it verify + normalize the native
 * payload, returns any immediate ack, then runs the agent on the deferred
 * `after()` budget so the HTTP response returns promptly. Connection-mode
 * channels are driven by `src/worker/`, not this route.
 */
import { after } from "next/server";

import "@/channels";
import "@/agent/providers";
import "@/agent/tools";
import { getChannel } from "@/channels/registry";
import { buildPipelineDeps } from "@/core/deps";
import { runConversation } from "@/core/pipeline";
import { requestLogger } from "@/observability/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ channel: string }> },
): Promise<Response> {
  const { channel } = await params;
  const adapter = getChannel(channel);
  if (!adapter) return new Response("unknown channel", { status: 404 });
  if (adapter.mode === "connection") {
    return new Response("not a webhook channel", { status: 400 });
  }

  const rawBody = await request.text();
  const headers: Record<string, string | null> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const result = await adapter.ingest({ headers, rawBody });
  if (result.ack) {
    return new Response(result.ack.body ?? "", { status: result.ack.status });
  }

  const deps = buildPipelineDeps();
  const log = requestLogger({ channel });
  after(async () => {
    for (const msg of result.messages) {
      try {
        await runConversation(msg, adapter, deps);
      } catch (err) {
        log.error("channel.after_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  return new Response("", { status: 200 });
}
