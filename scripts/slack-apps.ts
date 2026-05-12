#!/usr/bin/env tsx
/**
 * Operator CLI for Slack app registration & management.
 *
 *   pnpm slack-apps list
 *   pnpm slack-apps get <api_app_id>
 *   pnpm slack-apps register <api_app_id>            (prompts for secrets)
 *   pnpm slack-apps delete <api_app_id>              (requires confirmation)
 *   pnpm slack-apps acl set <api_app_id> --channels=C1,C2 --users=U1
 *   pnpm slack-apps acl unset <api_app_id> --channels --users
 *   pnpm slack-apps persona set <api_app_id> "<message>"
 *   pnpm slack-apps persona set <api_app_id> --from-file persona.txt
 *   pnpm slack-apps persona unset <api_app_id>
 *   pnpm slack-apps name set <api_app_id> "<display name>"
 *
 * The CLI is a thin wrapper over the same store / credential helpers the
 * /slack web UI calls. Use this for ops bootstrapping (first app) or
 * environments without an interactive browser session.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readFileSync } from "node:fs";

import {
  deleteSlackApp,
  getSlackApp,
  listSlackApps,
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

const die = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const printHelp = () => {
  console.log(`Usage:
  slack-apps list
  slack-apps get <api_app_id>
  slack-apps register <api_app_id>
  slack-apps delete <api_app_id>
  slack-apps acl set <api_app_id> [--channels=C1,C2] [--users=U1,U2]
  slack-apps acl unset <api_app_id> [--channels] [--users]
  slack-apps persona set <api_app_id> ["<message>" | --from-file=path]
  slack-apps persona unset <api_app_id>
  slack-apps name set <api_app_id> "<display name>"
  slack-apps name unset <api_app_id>`);
};

const parseFlags = (argv: string[]): Record<string, string | true> => {
  const out: Record<string, string | true> = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
};

const positional = (argv: string[]): string[] => argv.filter((a) => !a.startsWith("--"));

const csv = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const promptHidden = async (prompt: string): Promise<string> => {
  const rl = createInterface({ input: stdin, output: stdout });
  // Best-effort: hide echoes by toggling raw mode while the user types.
  // Falls back to plain readline on environments without setRawMode.
  const raw = (stdin as NodeJS.ReadStream).isTTY && stdin.setRawMode;
  const answer = await new Promise<string>((resolve) => {
    stdout.write(prompt);
    let buf = "";
    const onData = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      for (const ch of data) {
        if (ch === "\n" || ch === "\r") {
          stdout.write("\n");
          stdin.off("data", onData);
          if (raw) (stdin as NodeJS.ReadStream).setRawMode(false);
          resolve(buf);
          return;
        }
        if (ch === "") process.exit(130); // Ctrl-C
        if (ch === "") {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    if (raw) {
      (stdin as NodeJS.ReadStream).setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    } else {
      rl.question("").then((line) => {
        rl.close();
        resolve(line);
      });
    }
  });
  if (!raw) rl.close();
  return answer;
};

const formatTime = (epoch: number): string => {
  if (!epoch) return "(never)";
  return new Date(epoch * 1000).toISOString();
};

const cmdList = async (): Promise<void> => {
  const apps = await listSlackApps();
  if (apps.length === 0) {
    console.log("(no apps registered)");
    return;
  }
  for (const a of apps) {
    const label = a.displayName ?? a.teamName ?? a.apiAppId;
    console.log(`${a.apiAppId}  ${label}  team=${a.teamId ?? "?"}  bot=${a.botUserName ?? "?"}  lastSeen=${formatTime(a.lastSeenAt)}`);
  }
};

const cmdGet = async (apiAppId: string): Promise<void> => {
  const app = await getSlackApp(apiAppId);
  if (!app) die(`unknown app: ${apiAppId}`);
  console.log(JSON.stringify(app, null, 2));
};

const cmdRegister = async (apiAppId: string): Promise<void> => {
  if (!/^A[0-9A-Z]+$/.test(apiAppId)) die(`invalid api_app_id: ${apiAppId}`);
  const signing = (await promptHidden("Signing secret: ")).trim();
  const token = (await promptHidden("Bot token (xoxb-…): ")).trim();
  if (!signing || !token) die("signing_secret and bot_token are both required");
  if (!token.startsWith("xoxb-") && !token.startsWith("xoxp-")) {
    die("bot token must start with xoxb- or xoxp-");
  }
  const probe = await getSlackWebClient(token);
  const authInfo = await probe.auth.test();
  if (!authInfo.ok) die(`auth.test failed: ${authInfo.error ?? "unknown"}`);
  const teamId = authInfo.team_id ?? undefined;
  const teamName = authInfo.team ?? undefined;
  const teamDomain =
    typeof (authInfo as { url?: string }).url === "string"
      ? new URL((authInfo as { url: string }).url).host.split(".")[0]
      : undefined;
  await putSlackCredentials(apiAppId, { signingSecret: signing, botToken: token });
  await upsertSlackApp({
    apiAppId,
    teamId,
    teamName,
    teamDomain,
    botUserId: authInfo.user_id ?? undefined,
    botUserName: authInfo.user ?? undefined,
  });
  invalidateSlackCredentials(apiAppId);
  console.log(`registered ${apiAppId} (team=${teamName ?? "?"} bot=${authInfo.user ?? "?"})`);
};

const cmdDelete = async (apiAppId: string): Promise<void> => {
  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = await rl.question(`Type ${apiAppId} to confirm deletion: `);
  rl.close();
  if (confirm.trim() !== apiAppId) die("aborted (id mismatch)");
  await Promise.allSettled([deleteSlackCredentials(apiAppId), deleteSlackApp(apiAppId)]);
  invalidateSlackCredentials(apiAppId);
  console.log(`deleted ${apiAppId}`);
};

const cmdAcl = async (
  action: "set" | "unset",
  apiAppId: string,
  flags: Record<string, string | true>,
): Promise<void> => {
  const channels = flags.channels;
  const users = flags.users;
  if (action === "set") {
    if (channels !== undefined && typeof channels === "string") {
      await setSlackAppAllowlist(apiAppId, "allowedChannelIds", csv(channels));
      console.log(`set channel allowlist on ${apiAppId}`);
    }
    if (users !== undefined && typeof users === "string") {
      await setSlackAppAllowlist(apiAppId, "allowedUserIds", csv(users));
      console.log(`set user allowlist on ${apiAppId}`);
    }
  } else {
    if (channels) {
      await unsetSlackAppAllowlist(apiAppId, "allowedChannelIds");
      console.log(`unset channel override on ${apiAppId}`);
    }
    if (users) {
      await unsetSlackAppAllowlist(apiAppId, "allowedUserIds");
      console.log(`unset user override on ${apiAppId}`);
    }
  }
};

const cmdPersona = async (
  action: "set" | "unset",
  apiAppId: string,
  rest: string[],
  flags: Record<string, string | true>,
): Promise<void> => {
  if (action === "unset") {
    await unsetSlackAppPersona(apiAppId);
    console.log(`unset persona override on ${apiAppId}`);
    return;
  }
  let value: string;
  if (typeof flags["from-file"] === "string") {
    value = readFileSync(flags["from-file"], "utf8");
  } else if (rest[0] !== undefined) {
    value = rest[0];
  } else {
    die("persona set requires a quoted value or --from-file=path");
  }
  await setSlackAppPersona(apiAppId, value!);
  console.log(`set persona override on ${apiAppId} (${value!.length} chars)`);
};

const cmdName = async (
  action: "set" | "unset",
  apiAppId: string,
  rest: string[],
): Promise<void> => {
  if (action === "unset") {
    await unsetSlackAppDisplayName(apiAppId);
    console.log(`unset display name on ${apiAppId}`);
    return;
  }
  const value = rest[0];
  if (!value) die("name set requires a quoted value");
  await setSlackAppDisplayName(apiAppId, value!);
  console.log(`set display name on ${apiAppId}: ${value!}`);
};

const main = async (): Promise<void> => {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  const flags = parseFlags(rest);
  const pos = positional(rest);

  switch (cmd) {
    case "list":
      await cmdList();
      return;
    case "get": {
      const [appId] = pos;
      if (!appId) die("get requires <api_app_id>");
      await cmdGet(appId!);
      return;
    }
    case "register": {
      const [appId] = pos;
      if (!appId) die("register requires <api_app_id>");
      await cmdRegister(appId!);
      return;
    }
    case "delete": {
      const [appId] = pos;
      if (!appId) die("delete requires <api_app_id>");
      await cmdDelete(appId!);
      return;
    }
    case "acl": {
      const [action, appId] = pos;
      if (action !== "set" && action !== "unset") {
        die("acl <set|unset> <api_app_id> [...]");
      }
      if (!appId) die("acl requires <api_app_id>");
      await cmdAcl(action as "set" | "unset", appId!, flags);
      return;
    }
    case "persona": {
      const [action, appId, ...remaining] = pos;
      if (action !== "set" && action !== "unset") {
        die("persona <set|unset> <api_app_id> [...]");
      }
      if (!appId) die("persona requires <api_app_id>");
      await cmdPersona(action as "set" | "unset", appId!, remaining, flags);
      return;
    }
    case "name": {
      const [action, appId, ...remaining] = pos;
      if (action !== "set" && action !== "unset") {
        die("name <set|unset> <api_app_id> [...]");
      }
      if (!appId) die("name requires <api_app_id>");
      await cmdName(action as "set" | "unset", appId!, remaining);
      return;
    }
    default:
      printHelp();
      die(`unknown command: ${cmd}`);
  }
};

main().catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
