/**
 * Channel / user allowlist resolution.
 *
 * Two sources for each allowlist:
 *   - Global env var (CSV string): `ALLOWED_CHANNEL_IDS`, `ALLOWED_USER_IDS`.
 *   - Per-app override in DynamoDB (`SlackAppRecord.allowedChannelIds`,
 *     `allowedUserIds`).
 *
 * Resolution: the per-app attribute, if defined, ALWAYS wins. An attribute
 * present-but-empty (`[]`) is a meaningful PRESENT state — it means
 * "explicitly allow all for this app", overriding even a non-empty global.
 * An attribute that's undefined falls back to the env CSV.
 */
import type { SlackAppRecord } from "@/lib/slack/app-metadata";

export const parseCsv = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

interface AllowlistInputs {
  appOverride: string[] | undefined;
  envCsv: string | undefined;
}

/** Returns the effective allowlist for either channel or user. */
export const effectiveAllowlist = ({ appOverride, envCsv }: AllowlistInputs): string[] => {
  if (appOverride !== undefined) return [...appOverride];
  return parseCsv(envCsv);
};

export interface ChannelAclInputs {
  channel: string | undefined;
  isDm: boolean;
  app: SlackAppRecord | null;
  envCsv: string | undefined;
}

export interface ChannelAclResult {
  allowed: boolean;
  /** When blocked, the first effective channel ID to reference in the deny message ({} placeholder). */
  firstAllowedChannel?: string;
}

/**
 * Channel allowlist applies to public/private channels only — DMs bypass it.
 * DM channel IDs (`D...`) are not normally enrolled in the allowlist, so
 * enforcing there would lock out every direct-message path the moment an
 * operator set `ALLOWED_CHANNEL_IDS`. Slack's own workspace install
 * permission already gates who can open the DM.
 */
export const evaluateChannelAcl = ({
  channel,
  isDm,
  app,
  envCsv,
}: ChannelAclInputs): ChannelAclResult => {
  if (isDm) return { allowed: true };
  const list = effectiveAllowlist({ appOverride: app?.allowedChannelIds, envCsv });
  if (list.length === 0) return { allowed: true };
  if (channel && list.includes(channel)) return { allowed: true };
  return { allowed: false, firstAllowedChannel: list[0] };
};

export interface UserAclInputs {
  user: string | undefined;
  app: SlackAppRecord | null;
  envCsv: string | undefined;
}

/**
 * User allowlist applies to channels AND DMs. Restricting who can talk to
 * the bot is meaningful in both surfaces. Empty list = everyone allowed.
 */
export const evaluateUserAcl = ({ user, app, envCsv }: UserAclInputs): { allowed: boolean } => {
  const list = effectiveAllowlist({ appOverride: app?.allowedUserIds, envCsv });
  if (list.length === 0) return { allowed: true };
  if (user && list.includes(user)) return { allowed: true };
  return { allowed: false };
};

/**
 * Resolve the effective per-app persona. Empty string ("") on the override
 * means "explicitly no persona" — overrides the env value, returning undefined.
 */
export const effectivePersona = (
  app: SlackAppRecord | null,
  envPersona: string | undefined,
): string | undefined => {
  if (app && app.personaMessage !== undefined) {
    return app.personaMessage === "" ? undefined : app.personaMessage;
  }
  return envPersona;
};

/**
 * Substitute `{}` in the deny message with `<#CHANNEL_ID>` Slack mention.
 * When no channel to reference, return the message as-is (or empty).
 */
export const renderChannelDenyMessage = (
  template: string,
  firstChannelId: string | undefined,
): string => {
  if (!template) return "";
  if (!firstChannelId || !template.includes("{}")) return template;
  return template.replace("{}", `<#${firstChannelId}>`);
};
