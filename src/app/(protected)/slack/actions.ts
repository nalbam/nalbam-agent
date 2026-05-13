"use server";

/**
 * Server actions for the operator Slack-app management UI.
 *
 * Every action calls `getSession()` first and throws on miss — the
 * `(protected)` layout already redirects unauthenticated visitors, but
 * defense-in-depth here covers direct fetch attacks against the action
 * endpoint Next.js exposes.
 *
 * Reads/writes split between DynamoDB (metadata, ACL, persona) and SSM
 * Parameter Store (signing_secret + bot_token, SecureString). The
 * register action verifies the supplied bot token via `auth.test` before
 * persisting anything — that's also where team_id / team_name / bot_user_id
 * are populated so the runtime can use them for ACL and `:x:` reactions.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isOperatorAllowed } from "@/lib/auth/operator";
import { logger } from "@/lib/logger";
import { getSession } from "@/lib/auth/session";
import {
  deleteSlackApp,
  setSlackAppAllowlist,
  setSlackAppDisplayName,
  setSlackAppPersona,
  unsetSlackAppAllowlist,
  unsetSlackAppDisplayName,
  unsetSlackAppPersona,
  upsertSlackApp,
} from "@/lib/slack/app-metadata";
import { getSlackWebClient } from "@/lib/slack/client";
import {
  deleteSlackCredentials,
  invalidateSlackCredentials,
  putSlackCredentials,
} from "@/lib/slack/credentials";
import { sanitizeError } from "@/lib/slack/formatter";

const requireSession = async () => {
  const session = await getSession();
  if (!session?.user) {
    throw new Error("unauthorized");
  }
  const check = isOperatorAllowed(session.user);
  if (!check.allowed) {
    throw new Error("forbidden: operator role required");
  }
  return session;
};

const csvToList = (raw: string | null | undefined): string[] => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

export interface RegisterSlackAppResult {
  ok: true;
  apiAppId: string;
}

export const registerSlackAppAction = async (
  formData: FormData,
): Promise<RegisterSlackAppResult> => {
  await requireSession();
  const apiAppId = String(formData.get("apiAppId") ?? "").trim();
  const signingSecret = String(formData.get("signingSecret") ?? "").trim();
  const botToken = String(formData.get("botToken") ?? "").trim();
  const displayName = String(formData.get("displayName") ?? "").trim() || undefined;

  if (!/^A[0-9A-Z]+$/.test(apiAppId)) {
    throw new Error("apiAppId must look like A0XXX… (Slack app id)");
  }
  if (!signingSecret || signingSecret.length < 16) {
    throw new Error("signingSecret missing or too short");
  }
  if (!botToken.startsWith("xoxb-") && !botToken.startsWith("xoxp-")) {
    throw new Error("botToken must start with xoxb- or xoxp-");
  }

  // Verify the bot token via auth.test BEFORE writing anything. Slack
  // returns team_id, team, user_id, bot_id, team_domain on success.
  const probeClient = await getSlackWebClient(botToken);
  let authInfo;
  try {
    authInfo = await probeClient.auth.test();
  } catch (err) {
    throw new Error(`auth.test failed: ${sanitizeError(err)}`);
  }
  if (!authInfo.ok) {
    throw new Error(`auth.test returned not-ok: ${authInfo.error ?? "unknown"}`);
  }
  const teamId = authInfo.team_id ?? undefined;
  const teamName = authInfo.team ?? undefined;
  const teamDomain =
    typeof (authInfo as { url?: string }).url === "string"
      ? new URL((authInfo as { url: string }).url).host.split(".")[0]
      : undefined;
  const botUserId = authInfo.user_id ?? undefined;
  const botUserName = authInfo.user ?? undefined;

  await putSlackCredentials(apiAppId, { signingSecret, botToken });
  await upsertSlackApp({
    apiAppId,
    teamId,
    teamName,
    teamDomain,
    botUserId,
    botUserName,
    displayName,
  });
  invalidateSlackCredentials(apiAppId);
  logger.info("slack.app.registered", { apiAppId, teamId, botUserId });

  revalidatePath("/slack");
  revalidatePath(`/slack/${apiAppId}`);
  return { ok: true, apiAppId };
};

export const updateSlackAppAllowlistAction = async (formData: FormData): Promise<void> => {
  await requireSession();
  const apiAppId = String(formData.get("apiAppId") ?? "").trim();
  const attr = String(formData.get("attr") ?? "") as "allowedChannelIds" | "allowedUserIds";
  const action = String(formData.get("action") ?? ""); // "set" | "unset"
  const raw = String(formData.get("values") ?? "");
  if (!apiAppId) throw new Error("apiAppId required");
  if (attr !== "allowedChannelIds" && attr !== "allowedUserIds") {
    throw new Error(`unknown allowlist attr: ${attr}`);
  }
  if (action === "unset") {
    await unsetSlackAppAllowlist(apiAppId, attr);
  } else {
    await setSlackAppAllowlist(apiAppId, attr, csvToList(raw));
  }
  revalidatePath(`/slack/${apiAppId}`);
};

export const updateSlackAppPersonaAction = async (formData: FormData): Promise<void> => {
  await requireSession();
  const apiAppId = String(formData.get("apiAppId") ?? "").trim();
  const action = String(formData.get("action") ?? ""); // "set" | "unset"
  const value = String(formData.get("value") ?? "");
  if (!apiAppId) throw new Error("apiAppId required");
  if (action === "unset") {
    await unsetSlackAppPersona(apiAppId);
  } else {
    await setSlackAppPersona(apiAppId, value);
  }
  revalidatePath(`/slack/${apiAppId}`);
};

export const updateSlackAppDisplayNameAction = async (formData: FormData): Promise<void> => {
  await requireSession();
  const apiAppId = String(formData.get("apiAppId") ?? "").trim();
  const action = String(formData.get("action") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  if (!apiAppId) throw new Error("apiAppId required");
  if (action === "unset" || !value) {
    await unsetSlackAppDisplayName(apiAppId);
  } else {
    await setSlackAppDisplayName(apiAppId, value);
  }
  revalidatePath("/slack");
  revalidatePath(`/slack/${apiAppId}`);
};

export const deleteSlackAppAction = async (formData: FormData): Promise<void> => {
  await requireSession();
  const apiAppId = String(formData.get("apiAppId") ?? "").trim();
  const confirm = String(formData.get("confirm") ?? "").trim();
  if (!apiAppId) throw new Error("apiAppId required");
  if (confirm !== apiAppId) {
    throw new Error("Type the apiAppId to confirm deletion");
  }
  await Promise.allSettled([deleteSlackCredentials(apiAppId), deleteSlackApp(apiAppId)]);
  invalidateSlackCredentials(apiAppId);
  logger.info("slack.app.deleted", { apiAppId });
  revalidatePath("/slack");
  redirect("/slack");
};
