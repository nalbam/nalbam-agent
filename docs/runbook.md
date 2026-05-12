# Operations Runbook

Common operational scenarios for `nalbam-agent`. Each section is self-contained — you should be able to run from cold without reading the rest of the doc.

## Spin up local development from a clean clone

Default mode: real AWS DynamoDB + real AWS SSM + local Valkey. Make sure your AWS credentials are configured (`aws configure`, `aws sso login`, or `AWS_PROFILE`).

```bash
nvm use            # Node 22 (per .nvmrc)
corepack enable    # picks pnpm 11 from packageManager pin
pnpm install
cp .env.example .env.local
# At minimum, fill:
#   BETTER_AUTH_SECRET (openssl rand -base64 32)
#   OPENAI_API_KEY     (sk-…)
#   AWS_REGION, DYNAMODB_TABLE_NAME

docker compose up -d           # Valkey only (KV for Better Auth secondaryStorage)
pnpm db:init                   # creates the DynamoDB table on real AWS
pnpm dev
```

Sanity check:

- <http://localhost:3000> renders the landing page.
- <http://localhost:3000/api/health> → 200 OK.
- The DynamoDB table is visible in the AWS console under the configured region.
- `docker exec starter-valkey valkey-cli ping` → `PONG`.

### Offline / integration-test mode

Use DynamoDB Local instead of real AWS:

```bash
docker compose --profile test up -d   # adds dynamodb-local + admin UI
# Set DYNAMODB_ENDPOINT="http://localhost:8000" in .env.local
pnpm db:init
pnpm dev
```

The admin UI is at <http://localhost:8001>. There is no SSM Local — Slack credential reads/writes still hit real AWS in this mode unless you stub `getSlackCredentials` in tests.

## Provision a fresh production DynamoDB table

`pnpm db:init` is idempotent and works against any endpoint:

```bash
unset DYNAMODB_ENDPOINT
export AWS_REGION=ap-northeast-2
export DYNAMODB_TABLE_NAME=app-main
pnpm db:init
```

Verify:

```bash
aws dynamodb describe-table --table-name app-main \
  --query 'Table.{Status:TableStatus,GSI:GlobalSecondaryIndexes[0].IndexName}'
aws dynamodb describe-time-to-live --table-name app-main
```

## Register a Slack app

Either via the operator UI (recommended for ad-hoc work) or the CLI (for ops bootstrapping / non-interactive environments).

### Web UI

1. Visit `/signup` and create an operator account (or sign in via `/login`).
2. Go to `/slack/new`.
3. Paste the **App ID** (`A0XXX…`), **Signing secret**, and **Bot token** (`xoxb-…`). Optionally set a **Display name**.
4. The server action verifies the bot token via `auth.test` before writing SSM parameters; on failure nothing is persisted.

### CLI

```bash
pnpm slack-apps register A0XXXXXXXXX
# Prompts hide the signing secret and bot token as you type.

pnpm slack-apps list
pnpm slack-apps get A0XXXXXXXXX
```

Slack-side requirements (scopes, event subscriptions, Request URL) are documented in [`docs/slack-bot.md`](./slack-bot.md#1-slack-side-configuration-one-time-per-workspace).

## Rotate a Slack app's signing secret or bot token

1. In the Slack app dashboard, regenerate the secret/token.
2. Run `pnpm slack-apps register A0XXX…` again with the new values. `putParameter` uses `Overwrite=true`, so both SSM parameters get replaced in place and the metadata row is touched.
3. The on-process credential cache is invalidated immediately on the request that did the rotation. Other warm containers pick up the new values within `SLACK_SSM_CACHE_TTL_SECONDS` (default 300 s).

To force-clear all containers, simulate a deploy by triggering an Amplify rebuild — every cold container starts with an empty cache.

## Change channel / user ACL or persona

```bash
# Channel allowlist override for this one app:
pnpm slack-apps acl set A0XXX --channels=C12345,C67890

# Empty list = explicit allow-all (overrides any non-empty ALLOWED_CHANNEL_IDS env):
pnpm slack-apps acl set A0XXX --channels=

# Drop the override (fall back to ALLOWED_CHANNEL_IDS env):
pnpm slack-apps acl unset A0XXX --channels

# Per-app persona:
pnpm slack-apps persona set A0XXX "자연스러운 한국어로 핵심부터 답한다"
pnpm slack-apps persona set A0XXX --from-file=persona.txt
pnpm slack-apps persona unset A0XXX
```

Equivalent forms exist in the web UI under `/slack/[appId]`. Per-app overrides take effect on the next request (no cache for app metadata — every `handleMessage` does a `touchSlackApp`).

## Verify `after()` works on Amplify SSR

The receiver returns 200 immediately and registers `next/server`'s `after(...)` for the agent run. If Amplify's runtime kills the Lambda between response and the deferred callback, the bot will look like it just acks and never replies.

After the first deploy:

1. Mention the bot in any allowed channel: `@your-bot 안녕`.
2. In CloudWatch Logs for the SSR function, look for this sequence:
   - `slack.route.…` (route handler returns 200)
   - `slack.agent.start`
   - `slack.agent.done`
3. The bot should reply in the thread within a few seconds.

If steps 1 and 2 fire but `slack.agent.start` never appears, see the fallback options in [`docs/slack-bot.md`](./slack-bot.md#verifying-after-works-on-your-amplify-deployment).

## Delete a Slack app

```bash
pnpm slack-apps delete A0XXX
# Prompts for the App ID to confirm.
```

Or the danger-zone delete on `/slack/[appId]`. Both paths:

- `DeleteParameter` on both SSM SecureStrings (idempotent — `ParameterNotFound` is treated as success).
- `DeleteItem` on `SLACK_APP#…/META`.
- Invalidate the in-process credential cache.

`SLACK_DEDUP#…` / `SLACK_DONE#…` / `SLACK_THREAD#…` rows for the deleted app age out naturally via TTL (5 min / 1 h / 1 h).

## `:x:` reaction not deleting the bot message

The `:x:` reaction deletes a bot reply when the reactor is either:

1. The original asker on the thread the bot replied in, OR
2. Listed in the effective `ALLOWED_USER_IDS` (per-app override > env CSV).

If your reaction does nothing, check the CloudWatch logs for one of:

- `slack.reaction.no_bot_id` → the `SLACK_APP#…` row has no `botUserId`. Re-register the app (`pnpm slack-apps register A0XXX`) so `auth.test` populates it.
- `slack.reaction.skip_not_bot_message` → the message you reacted on was authored by someone else.
- `slack.reaction.unauthorized` → reactor passed neither authorization path. Promote the user via `ALLOWED_USER_IDS` (env) or `pnpm slack-apps acl set A0XXX --users=…` to grant per-app authority.

## Force-expire all operator-UI sessions (security incident)

When `secondaryStorage` is configured (default), Better Auth stores sessions in Valkey/Upstash and **does not** write `SESSION#*` rows to DynamoDB. Flush the KV to invalidate every active session:

```bash
# Local (Valkey)
docker exec starter-valkey valkey-cli FLUSHDB

# Upstash REST
curl -X POST "$UPSTASH_REDIS_REST_URL/flushdb" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"
```

If you've enabled `session.storeSessionInDatabase: true` (or removed `secondaryStorage`), Better Auth falls back to writing `SESSION#*` rows. In that mode, also clear them via a scan + delete on `PK begins_with "SESSION#"`.

Then **rotate `BETTER_AUTH_SECRET`** so old cookies are invalidated even if cached client-side, and redeploy.

## Rotate `BETTER_AUTH_SECRET`

1. Generate a new secret: `openssl rand -base64 32`.
2. Update Amplify Hosting → *App settings → Environment variables*.
3. Trigger a rebuild (push or "Redeploy this version").
4. After redeploy, all existing operator-UI sessions become invalid; users must sign in again.

## Re-create the local DB from scratch

```bash
docker compose down -v   # nukes volumes
docker compose up -d
pnpm db:init
```

## Tear down the DynamoDB table

`pnpm db:delete` removes the application table, but only if it carries the cloud-man `ManagedBy=CloudManager` tag (the same tag `pnpm db:init` applies). This avoids accidentally deleting a pre-existing table that wasn't created by this project or by cloud-man.

```bash
# Interactive: prompts to retype the table name
pnpm db:delete

# Non-interactive (CI, scripts):
DDB_DELETE_CONFIRM=app-main pnpm db:delete
```

After deletion you can re-run `pnpm db:init` to recreate the table with the same schema.

## Emergency: Amplify build is failing

Most common causes (in order):

1. **`BETTER_AUTH_SECRET` not set** → `getServerEnv()` throws on first SSR request. The lazy init lets the *build* succeed, but `/page` prerender renders a server component that may trip on missing env. Confirm the env var is set in Amplify console.
2. **`OPENAI_API_KEY` not set** → only blocks runtime, not build. Set it before the bot can reply.
3. **`pnpm-lock.yaml` out of sync** → CI uses `--frozen-lockfile`. Locally re-run `pnpm install` and commit the lockfile change.
4. **Pretendard postinstall missed** → `scripts/copy-fonts.mjs` is a postinstall hook. Verify `pnpm install` ran without `--ignore-scripts`.
5. **DynamoDB IAM access denied** → IAM policy on the SSR compute role missing `arn:.../table/<TABLE>/index/*`.
6. **SSM IAM access denied** → IAM policy missing `ssm:GetParameters` on `arn:aws:ssm:<REGION>:<ACCOUNT>:parameter/<SLACK_SSM_PREFIX>/*`.

## Tighten CSP to enforce mode

`next.config.ts` ships `Content-Security-Policy-Report-Only` so violations log to `/api/csp-report` without blocking anything. Once your deployment runs clean for a few days, switch to enforce:

1. Watch `/api/csp-report` logs (or your CloudWatch query) — confirm there are no entries from legitimate flows (sign-in, OAuth callback, `/slack/*`).
2. In `next.config.ts`, rename `Content-Security-Policy-Report-Only` to `Content-Security-Policy`. Keep `report-uri` so future regressions surface.
3. Drop `'unsafe-inline'` and `'unsafe-eval'` from `script-src` only after introducing a nonce. The Next.js way:
   - Generate a nonce in `proxy.ts` and propagate it via response header.
   - Read it in the root layout: `headers().get("x-nonce")` and forward to `<Script nonce={nonce}>` / inline `<style nonce={nonce}>`.
4. Deploy, re-watch the report endpoint for 24h, then remove `Content-Security-Policy-Report-Only` entirely.

## Backups

DynamoDB on-demand backups are not enabled by default. For production:

```bash
aws dynamodb update-continuous-backups \
  --table-name app-main \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
```

This enables PITR (35-day rolling window). For longer retention, schedule on-demand backups via EventBridge.
