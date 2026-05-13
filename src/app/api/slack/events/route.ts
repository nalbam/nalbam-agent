/**
 * Slack Events API receiver.
 *
 * Slack requires an HTTP 200 within 3 seconds. We:
 *
 *   1. Short-circuit retry deliveries (`X-Slack-Retry-Num`) with 200 OK.
 *   2. Echo `url_verification` challenges directly (Slack pings the
 *      endpoint when an operator enrolls Event Subscriptions; the payload
 *      carries no `api_app_id`, so there's no signing secret to validate
 *      against — we have to break the chicken-and-egg here).
 *   3. Resolve the app's signing_secret + bot_token from SSM by
 *      `api_app_id`.
 *   4. Verify the Slack signature against the *raw* request bytes.
 *   5. Hand the event off to `after()` so the agent runs on Lambda's
 *      remaining budget AFTER the 200 has been returned — this is the
 *      key mechanism that replaces the original receiver/worker
 *      self-invoke pattern.
 *
 * IMPORTANT: do NOT read JSON via Next's helpers before signing
 * verification — the HMAC is computed over the exact bytes Slack sent,
 * not a JSON.parse/stringify round-trip.
 */
import { randomUUID } from "node:crypto";

import { after, NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { getSlackWebClient } from "@/lib/slack/client";
import { getSlackCredentials } from "@/lib/slack/credentials";
import { sanitizeError } from "@/lib/slack/formatter";
import { dispatchEvent, type SlackEventCallback } from "@/lib/slack/router";
import { verifySlackSignature } from "@/lib/slack/verify";

// Slack POSTs JSON. We must keep dynamic semantics (no caching) and read
// the body as raw bytes BEFORE parsing so signature verification works.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ok = (body = ""): NextResponse =>
  new NextResponse(body, { status: 200, headers: { "content-type": "text/plain" } });

export async function POST(request: Request): Promise<NextResponse> {
  // Slack retry deliveries: ack and skip work. The original event already
  // produced a dedup row; we don't want to re-run the agent on a retry that
  // arrives before our first attempt finishes.
  if (request.headers.get("x-slack-retry-num")) {
    return ok();
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err) {
    logger.warn("slack.route.read_body_failed", { error: sanitizeError(err) });
    return new NextResponse("", { status: 400 });
  }

  let parsed: SlackEventCallback;
  try {
    parsed = JSON.parse(rawBody) as SlackEventCallback;
  } catch {
    logger.info("slack.route.unparseable_body");
    return new NextResponse("", { status: 400 });
  }

  if (parsed.type === "url_verification") {
    return ok(parsed.challenge ?? "");
  }

  const apiAppId = parsed.api_app_id ?? "";
  if (!apiAppId) {
    logger.info("slack.route.no_app_id", { type: parsed.type });
    return ok();
  }

  const creds = await getSlackCredentials(apiAppId);
  if (!creds) {
    logger.info("slack.route.unknown_app", { apiAppId });
    // 200 so Slack stops retrying an unrecoverable misconfig.
    return ok();
  }

  const verifyResult = verifySlackSignature({
    body: rawBody,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    signingSecret: creds.signingSecret,
  });
  if (!verifyResult.ok) {
    logger.warn("slack.route.bad_signature", {
      apiAppId,
      reason: verifyResult.reason,
    });
    return new NextResponse("", { status: 401 });
  }

  // Per-request logger — every downstream log (router, handlers, agent,
  // tools) gets `requestId` for free so CloudWatch can group a single
  // request's events in a multi-tenant deployment.
  const requestId = randomUUID();
  const log = logger.child({ requestId, apiAppId });

  // Hand off to after() so the heavy work runs AFTER the 200 returns.
  // Amplify SSR / Lambda continues executing until either after() resolves
  // or the function's max duration elapses.
  after(async () => {
    try {
      const client = await getSlackWebClient(creds.botToken);
      await dispatchEvent({ client, apiAppId, payload: parsed, logger: log });
    } catch (err) {
      log.error("slack.route.after_failed", { error: sanitizeError(err) });
    }
  });

  return ok();
}
