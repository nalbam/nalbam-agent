# Slack Bot

Multi-tenant Slack AI agent migrated from [`lambda-gurumi-bot`](https://github.com/nalbam/lambda-gurumi-bot) (Python + Serverless Framework) onto this Next.js 16 + Better Auth + DynamoDB codebase. The bot lives at `POST /api/slack/events` and runs agent work via `next/server`'s `after()` callback so the HTTP ack returns to Slack within its 3-second budget while the agent keeps streaming into the thread.

## Architecture at a glance

```
┌────────────┐     POST                  ┌─────────────────────────────┐
│ Slack app  │ ──────────────────────▶   │ POST /api/slack/events       │
└────────────┘                            │  • read raw body             │
                                          │  • short-circuit retries     │
                                          │  • url_verification echo     │
                                          │  • SSM creds lookup          │
                                          │  • HMAC verify               │
                                          │  • after(() => dispatch)     │
                                          │  • return 200                │
                                          └────────────┬────────────────┘
                                                       │ after() executes
                                                       ▼
                                          ┌─────────────────────────────┐
                                          │ src/lib/slack/router         │
                                          │  → handlers/message          │
                                          │  → handlers/reactions        │
                                          └────────────┬────────────────┘
                                                       │
                                                       ▼
                              ┌────────────────────────────────────────┐
                              │ agent (ai-sdk streamText)               │
                              │  • streams content → StreamingMessage  │
                              │    → chat.postMessage / chat.update    │
                              │  • tool calls execute via registry     │
                              │  • saves thread history + markDone     │
                              └────────────────────────────────────────┘
```

Key pieces:

- `src/app/api/slack/events/route.ts` — HTTP entrypoint.
- `src/lib/slack/verify.ts` — Slack HMAC + 5-min replay guard.
- `src/lib/slack/credentials.ts` — SSM SecureString reader/writer with TTL + negative cache.
- `src/lib/slack/app-metadata.ts` — DynamoDB `SLACK_APP#…/META` rows (per-tenant ACL, persona, identity).
- `src/lib/slack/dedup.ts` — Two-stage idempotency (`SLACK_DEDUP#…` short-TTL reservation + `SLACK_DONE#…` long-TTL marker).
- `src/lib/slack/conversation.ts` — Thread history with greedy newest-first truncation.
- `src/lib/slack/stream.ts` — Lazy placeholder + throttled `chat.update` + overflow rollover + `msg_too_long` recovery.
- `src/lib/slack/handlers/message.ts` — `app_mention` / DM agent path.
- `src/lib/slack/handlers/reactions.ts` — `reaction_added` `:x:` deletes a bot reply (authorized via original asker or `ALLOWED_USER_IDS`).
- `src/lib/slack/tools/*` — Vercel AI SDK tools (`get_current_time`, `fetch_webpage`, `search_web`, `search_images`, `read_attached_images`, `read_attached_document`, `fetch_user_profile`, `fetch_thread_history`, `generate_image`, `attach_image_from_url`, `edit_image` (stub)).
- `src/app/(protected)/slack/*` — Operator web UI for register / edit / delete (Better Auth-protected).
- `scripts/slack-apps.ts` — CLI mirror of the same operations (`pnpm slack-apps …`).

## Multi-tenancy

A single deployment serves arbitrarily many Slack apps. Each app is identified by its `api_app_id` (from the payload Slack POSTs). For each app we store:

- **SSM Parameter Store, SecureString**: `${SLACK_SSM_PREFIX}/{api_app_id}/signing_secret` and `.../bot_token`. These never live in DynamoDB or env vars.
- **DynamoDB**: a single row at `PK=SLACK_APP#{api_app_id}, SK=META` holds `team_id`, `team_name`, `bot_user_id`, `bot_user_name`, optional `displayName`, optional ACL overrides (`allowedChannelIds`, `allowedUserIds`), and an optional `personaMessage`. The `GSI1PK=SLACK_APP:TEAM#{team_id}` index lets the web UI search by team.

ACL resolution: the per-app attribute, when present, ALWAYS wins — including the meaningful empty values (`[]` = "this app explicitly allows all", `""` = "this app has no persona"). Absent attributes fall back to the matching env CSV.

## Provisioning a Slack app

You need an app definition in Slack (Event Subscriptions, scopes, install) and a configured row in our system.

### 1. Slack-side configuration (one-time per workspace)

In <https://api.slack.com/apps>:

1. Create an app → *From scratch*.
2. **OAuth & Permissions** → Bot Token Scopes:
   `app_mentions:read`, `channels:history`, `chat:write`, `files:read`, `files:write`, `groups:history`, `im:history`, `im:read`, `im:write`, `reactions:read`, `users:read`, `users:read.email` (optional).
3. **Event Subscriptions** → set Request URL to `https://<your-domain>/api/slack/events`. The endpoint will echo the `url_verification` challenge so Slack validates.
4. Subscribe to bot events: `app_mention`, `message.im`, `reaction_added`.
5. **Install** the app to your workspace.
6. Copy *Bot User OAuth Token* (`xoxb-…`) and *Signing Secret* from *Basic Information*.

### 2. Register the app in our system

Either via the web UI or CLI.

#### Web UI (Better Auth-protected)

1. Visit `https://<your-domain>/slack/new`, signed in with any Better Auth user.
2. Paste the **App ID** (`A0XXX…`), **Signing secret**, and **Bot token**. Optionally pre-fill a **Display name**.
3. The server action calls `auth.test` to verify the token, writes the SecureString parameters to SSM, and persists the metadata row.

#### CLI

```sh
pnpm slack-apps register A0XXX…
# Prompts hide the signing secret and bot token as you type.
```

To verify:

```sh
pnpm slack-apps list
pnpm slack-apps get A0XXX…
```

### 3. Per-app ACL / persona

```sh
# Restrict to specific channels for this one app (overrides ALLOWED_CHANNEL_IDS env):
pnpm slack-apps acl set A0XXX… --channels=C12345,C67890

# Make this app accept any channel even when env is restrictive:
pnpm slack-apps acl set A0XXX… --channels=

# Drop the override (fall back to env):
pnpm slack-apps acl unset A0XXX… --channels

# Set a persona for this app only:
pnpm slack-apps persona set A0XXX… "자연스러운 한국어로 핵심부터 답한다"
pnpm slack-apps persona set A0XXX… --from-file=persona.txt

# Operator-friendly display name shown in `slack-apps list` and the web UI:
pnpm slack-apps name set A0XXX… "Production – Acme"
```

The web UI has equivalent forms under `/slack/[appId]`.

## Verifying `after()` works on your Amplify deployment

Amplify SSR runs on Lambda, and Next.js 16's `next/server` `after()` lets you keep working after the HTTP response has been returned. The whole agent design rides on this — if Amplify's runtime freezes the Lambda between response and the next event, the bot will look like it just acks and never replies.

The first thing to test after deploying:

1. Register one Slack app (see above).
2. Mention the bot in a channel: `@gurumi 안녕`.
3. Watch CloudWatch Logs for the SSR function. You should see, in order:
   - `slack.route.…` info logs (route handler)
   - `slack.agent.start`
   - `slack.agent.done`
4. The bot should post a reply in the thread within a few seconds.

If you see `slack.route.*` but no `slack.agent.*` logs **and** no reply, `after()` is being killed prematurely. Fallback options (in increasing complexity):

- Push the dispatch into Upstash QStash and trigger a follow-up `/api/slack/worker` endpoint (the codebase already has Upstash credentials wired up via `@upstash/redis`).
- Provision an SQS queue + a separate worker Lambda, with the receiver writing the event and the worker reading it.
- Add a self-invoke (Lambda → Lambda via the AWS SDK) — the trickiest path because Amplify hides the SSR function ARN.

## Operational notes

- **Slack retries** (`X-Slack-Retry-Num` header) are short-circuited with a plain 200; combined with the `SLACK_DONE#…` long-TTL marker, the agent never re-runs on a retried delivery.
- **DynamoDB TTL** sweeps `SLACK_DEDUP#…` (5 min) and `SLACK_THREAD#…` (1 h). `SLACK_APP#…` and `SLACK_DONE#…` (1 h) too — operator UI and CLI commands write fresh rows on each interaction.
- **Multi-app warm-container caching**: `getSlackCredentials` caches per `api_app_id` for 5 min by default. `invalidateSlackCredentials` is called whenever the web UI / CLI updates secrets so rotations take effect immediately on the container that handled the change. Other warm containers pick up the change within the TTL window.
- **`:x:` reaction**: deletes a bot reply when the reactor is the original thread asker OR appears in the effective `ALLOWED_USER_IDS`. Original-asker lookup uses `conversations.history(latest=msg_ts, inclusive=true, limit=1)` to find the parent ts, then `conversations.replies(ts=parent_ts, limit=1)` for the asker.
- **`edit_image`** calls OpenAI's `/v1/images/edits` multipart endpoint directly (the `@ai-sdk/openai` provider doesn't expose an edit primitive). When `IMAGE_PROVIDER=bedrock`, the tool surfaces a structured "unsupported" error so the agent can pivot to `generate_image` or a text reply.

## Known limitations

- Image generation + edit are OpenAI-only. Bedrock (Nova Canvas / Titan Image) is unsupported — there is no stable ai-sdk wrapper for it, and both tools surface a `provider 'bedrock' not supported (only openai)` error when `IMAGE_PROVIDER=bedrock`.
- There is no user-memory feature (`remember` / `forget`). The `mem:{user_id}` key prefix is reserved for it.

## Operator allowlist

The `/slack` web UI and `pnpm slack-apps` CLI gate on `OPERATOR_ALLOWED_EMAILS` (CSV). When unset the UI is open to any authenticated user (a `slack.operator.allowlist_empty` warning is logged per request). For production, populate this env with the email addresses you want to allow.

## Throttle

`MAX_THROTTLE_COUNT` (default 100) is enforced as a per-user concurrent-active-requests counter via Upstash Redis REST (when configured) or local Valkey via `REDIS_URL`. The counter has a 10-minute TTL fallback so a release that gets dropped (e.g. Lambda timeout mid-handler) doesn't leak the slot forever. No KV configured = throttle disabled (always allowed).

## Related docs

- [`docs/amplify-deploy.md`](./amplify-deploy.md) — IAM, env vars, Amplify build config.
- [`docs/dynamodb-schema.md`](./dynamodb-schema.md) — DynamoDB single-table schema.
