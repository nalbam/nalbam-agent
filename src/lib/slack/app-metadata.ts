/**
 * DynamoDB store for Slack app metadata + per-app ACL/persona overrides.
 *
 * Each known `api_app_id` gets a row at PK=`SLACK_APP#{id}`, SK=`META` with
 * first-seen / last-seen timestamps, Slack workspace identity fields, and
 * OPTIONAL per-app overrides. Rows carry no TTL, so they survive table-wide
 * TTL sweeps that delete dedup/conversation rows.
 *
 * Per-app overrides
 * =================
 * Three optional attributes override the matching deployment-wide env var:
 *
 *   - `allowedChannelIds` (string[])  — overrides ALLOWED_CHANNEL_IDS
 *   - `allowedUserIds`    (string[])  — overrides ALLOWED_USER_IDS
 *   - `personaMessage`    (string)    — overrides PERSONA_MESSAGE
 *
 * Resolution: attribute ABSENT → fall back to env. PRESENT (including empty
 * `[]` or `""`) → use this value, IGNORE env. The empty value is a meaningful
 * "explicitly open" / "explicitly no persona" state — distinct from absence.
 *
 * SYSTEM_MESSAGE intentionally has NO per-app override — it's a security
 * field that should stay consistent across the deployment.
 */
import { getItem, putItem, queryGSI1, scanAll, updateItem } from "@/lib/dynamodb-helpers";
import { gsi1, keys, sanitizeKeyValue } from "@/lib/dynamodb";

export interface SlackAppRecord {
  apiAppId: string;
  teamId?: string;
  teamName?: string;
  teamDomain?: string;
  botUserId?: string;
  botUserName?: string;
  displayName?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  personaMessage?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

type RawRow = {
  PK?: string;
  SK?: string;
  GSI1PK?: string;
  GSI1SK?: string;
  entity?: string;
  apiAppId?: string;
  teamId?: string;
  teamName?: string;
  teamDomain?: string;
  botUserId?: string;
  botUserName?: string;
  displayName?: string;
  allowedChannelIds?: string[];
  allowedUserIds?: string[];
  personaMessage?: string;
  firstSeenAt?: number;
  lastSeenAt?: number;
} & Record<string, unknown>;

const rowToRecord = (row: RawRow | null): SlackAppRecord | null => {
  if (!row || !row.apiAppId) return null;
  return {
    apiAppId: row.apiAppId,
    teamId: row.teamId,
    teamName: row.teamName,
    teamDomain: row.teamDomain,
    botUserId: row.botUserId,
    botUserName: row.botUserName,
    displayName: row.displayName,
    allowedChannelIds: row.allowedChannelIds,
    allowedUserIds: row.allowedUserIds,
    personaMessage: row.personaMessage,
    firstSeenAt: row.firstSeenAt ?? 0,
    lastSeenAt: row.lastSeenAt ?? 0,
  };
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const getSlackApp = async (apiAppId: string): Promise<SlackAppRecord | null> => {
  const row = await getItem<RawRow>(keys.slackApp(apiAppId));
  return rowToRecord(row);
};

/**
 * Mark the app as observed: bump `lastSeenAt`, set `firstSeenAt` if missing,
 * overwrite `teamId` (a workspace reinstall may move the app). Other identity
 * fields are touched separately via `updateSlackAppInfo`.
 *
 * Returns the resulting row (including any pre-existing ACL/persona overrides)
 * so the caller can apply per-app ACL in the same DDB roundtrip.
 */
export const touchSlackApp = async (
  apiAppId: string,
  teamId?: string,
): Promise<SlackAppRecord | null> => {
  sanitizeKeyValue(apiAppId);
  const ts = nowSeconds();
  const setFields: Record<string, unknown> = {
    entity: "SLACK_APP",
    apiAppId,
    lastSeenAt: ts,
  };
  if (teamId) {
    setFields.teamId = teamId;
    setFields.GSI1PK = gsi1.bySlackTeam(teamId).GSI1PK;
    setFields.GSI1SK = gsi1.bySlackTeam(teamId).GSI1SK;
  }
  // updateItem doesn't support `if_not_exists`; emulate by reading first.
  // app metadata is light-hit so the extra GetItem is cheap and gives us
  // first_seen semantics without a custom UpdateExpression.
  const existing = await getItem<RawRow>(keys.slackApp(apiAppId));
  if (!existing) {
    setFields.firstSeenAt = ts;
  }
  await updateItem(keys.slackApp(apiAppId), setFields);
  return getSlackApp(apiAppId);
};

export interface UpsertSlackAppInput {
  apiAppId: string;
  teamId?: string;
  teamName?: string;
  teamDomain?: string;
  botUserId?: string;
  botUserName?: string;
  displayName?: string;
}

/**
 * Full upsert for the operator UI / CLI app-registration flow. Sets identity
 * fields, preserves `firstSeenAt`, sets `lastSeenAt` to now. Per-app overrides
 * (ACL, persona) are managed by separate functions and not touched here.
 */
export const upsertSlackApp = async (
  input: UpsertSlackAppInput,
): Promise<SlackAppRecord | null> => {
  sanitizeKeyValue(input.apiAppId);
  const existing = await getItem<RawRow>(keys.slackApp(input.apiAppId));
  const ts = nowSeconds();
  const item: Record<string, unknown> = {
    ...keys.slackApp(input.apiAppId),
    entity: "SLACK_APP",
    apiAppId: input.apiAppId,
    firstSeenAt: existing?.firstSeenAt ?? ts,
    lastSeenAt: ts,
  };
  if (input.teamId) {
    item.teamId = input.teamId;
    Object.assign(item, gsi1.bySlackTeam(input.teamId));
  } else if (existing?.teamId) {
    item.teamId = existing.teamId;
    Object.assign(item, gsi1.bySlackTeam(existing.teamId));
  }
  if (input.teamName !== undefined) item.teamName = input.teamName;
  else if (existing?.teamName !== undefined) item.teamName = existing.teamName;
  if (input.teamDomain !== undefined) item.teamDomain = input.teamDomain;
  else if (existing?.teamDomain !== undefined) item.teamDomain = existing.teamDomain;
  if (input.botUserId !== undefined) item.botUserId = input.botUserId;
  else if (existing?.botUserId !== undefined) item.botUserId = existing.botUserId;
  if (input.botUserName !== undefined) item.botUserName = input.botUserName;
  else if (existing?.botUserName !== undefined) item.botUserName = existing.botUserName;
  if (input.displayName !== undefined) item.displayName = input.displayName;
  else if (existing?.displayName !== undefined) item.displayName = existing.displayName;
  // Preserve overrides if present.
  if (existing?.allowedChannelIds !== undefined)
    item.allowedChannelIds = existing.allowedChannelIds;
  if (existing?.allowedUserIds !== undefined) item.allowedUserIds = existing.allowedUserIds;
  if (existing?.personaMessage !== undefined) item.personaMessage = existing.personaMessage;
  await putItem({ ...item, ...keys.slackApp(input.apiAppId) });
  return getSlackApp(input.apiAppId);
};

export const setSlackAppAllowlist = async (
  apiAppId: string,
  attr: "allowedChannelIds" | "allowedUserIds",
  values: string[],
): Promise<void> => {
  await updateItem(keys.slackApp(apiAppId), { [attr]: [...values] });
};

export const unsetSlackAppAllowlist = async (
  apiAppId: string,
  attr: "allowedChannelIds" | "allowedUserIds",
): Promise<void> => {
  await updateItem(keys.slackApp(apiAppId), {}, [attr]);
};

export const setSlackAppPersona = async (apiAppId: string, value: string): Promise<void> => {
  await updateItem(keys.slackApp(apiAppId), { personaMessage: value });
};

export const unsetSlackAppPersona = async (apiAppId: string): Promise<void> => {
  await updateItem(keys.slackApp(apiAppId), {}, ["personaMessage"]);
};

export const setSlackAppDisplayName = async (
  apiAppId: string,
  value: string,
): Promise<void> => {
  await updateItem(keys.slackApp(apiAppId), { displayName: value });
};

export const unsetSlackAppDisplayName = async (apiAppId: string): Promise<void> => {
  await updateItem(keys.slackApp(apiAppId), {}, ["displayName"]);
};

export const deleteSlackApp = async (apiAppId: string): Promise<void> => {
  const { deleteItem } = await import("@/lib/dynamodb-helpers");
  await deleteItem(keys.slackApp(apiAppId));
};

export const listSlackApps = async (): Promise<SlackAppRecord[]> => {
  const { items } = await scanAll<RawRow>({
    filter: {
      expression: "begins_with(#pk, :prefix) AND #sk = :sk",
      names: { "#pk": "PK", "#sk": "SK" },
      values: { ":prefix": "SLACK_APP#", ":sk": "META" },
    },
  });
  return items
    .map((row) => rowToRecord(row))
    .filter((r): r is SlackAppRecord => r !== null)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
};

export const findSlackAppByTeamId = async (teamId: string): Promise<SlackAppRecord[]> => {
  const { items } = await queryGSI1<RawRow>(
    gsi1.bySlackTeam(teamId).GSI1PK,
    gsi1.bySlackTeam(teamId).GSI1SK,
  );
  return items
    .map((row) => rowToRecord(row))
    .filter((r): r is SlackAppRecord => r !== null);
};
