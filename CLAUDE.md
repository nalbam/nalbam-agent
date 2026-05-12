# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**`nalbam-agent`** — a multi-tenant Slack AI agent. One Amplify deployment serves arbitrarily many Slack apps. Each app's signing secret + bot token live as SSM SecureString parameters; per-app ACL / persona overrides live in DynamoDB.

Ported from [`lambda-gurumi-bot`](https://github.com/nalbam/lambda-gurumi-bot) (Python + Serverless + Lambda). Full architecture in [`docs/slack-bot.md`](./docs/slack-bot.md).

## Commands

Package manager: **pnpm** (Node.js 22+, pnpm 11+ — `engines` and `packageManager` are pinned).

```bash
pnpm install
pnpm dev                # http://localhost:3000
pnpm build
pnpm start
pnpm lint               # ESLint flat config
pnpm typecheck          # tsc --noEmit
pnpm format             # Prettier write
pnpm test               # Vitest run
pnpm test:watch
pnpm db:init            # provision DynamoDB table + GSI1 + TTL (real AWS by default)
pnpm db:delete          # delete the table (refuses without ManagedBy=CloudManager tag)
pnpm slack-apps         # operator CLI: list / get / register / delete / acl / persona / name
docker compose up -d    # Valkey only (KV)
docker compose --profile test up -d   # also starts DynamoDB Local + admin UI for integration tests
```

`.env.local` must be populated before `pnpm dev`. Minimum: `BETTER_AUTH_SECRET` (≥ 32 chars), `OPENAI_API_KEY`, `AWS_REGION`, `DYNAMODB_TABLE_NAME`. Local AWS credentials (via `~/.aws/credentials`, `AWS_PROFILE`, or SSO) must be available — dev hits the real DynamoDB table and the real SSM Parameter Store by default.

## Stack & conventions

- **Next.js 16 App Router** under `src/app/` with React 19 and TypeScript `strict + noUncheckedIndexedAccess + noImplicitOverride`.
- **Vercel AI SDK 6** (`ai` + `@ai-sdk/openai` + `@ai-sdk/amazon-bedrock`) — `streamText` with native function calling and `stopWhen: stepCountIs(...)`.
- **`@slack/web-api`** for outbound Slack calls.
- **Path alias**: `@/*` → `./src/*`.
- **Tailwind v4** via `@tailwindcss/postcss`. Tokens live in `src/app/globals.css` under `@theme inline`. There is no `tailwind.config.*`.
- **shadcn/ui** (`new-york`, base color `slate`). Primitives in `src/components/ui/`.
- **Pretendard** fonts copied from `node_modules/pretendard` into `src/app/fonts/` by `scripts/copy-fonts.mjs` (postinstall).
- **ESLint** flat config extending `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`.

## Architecture

### Slack receiver (`src/app/api/slack/events/route.ts`)

The single entrypoint for Slack:

1. Read RAW body (signature verification requires exact bytes).
2. Short-circuit `X-Slack-Retry-Num` retries with 200 OK (Slack's already-acked event).
3. Echo `url_verification` challenge (Slack endpoint setup has no `api_app_id`, so signing is impossible — this is the only unsigned path).
4. Look up the app's `signing_secret` + `bot_token` in SSM via `getSlackCredentials(apiAppId)`.
5. Verify HMAC-SHA256 against the raw body + timestamp (`src/lib/slack/verify.ts`).
6. Register the heavy work with `after(() => dispatchEvent(...))` from `next/server`.
7. Return `200 OK` immediately.

The `after()` primitive is load-bearing — it replaces the original lambda-gurumi-bot's receiver/worker self-invoke pattern. Confirm via CloudWatch on the first production deploy that `slack.agent.start` → `slack.agent.done` both appear after the HTTP response.

### Slack lib (`src/lib/slack/`)

- `verify.ts` — Slack HMAC + 5-min replay guard. Timing-safe compare.
- `credentials.ts` — SSM SecureString reader/writer. 5-min in-process LRU + negative cache. Lazy SDK import.
- `app-metadata.ts` — DynamoDB CRUD for `SLACK_APP#{api_app_id}/META` rows. Per-app `allowedChannelIds`, `allowedUserIds`, `personaMessage` overrides.
- `dedup.ts` — Two-stage idempotency. `reserve()` writes `SLACK_DEDUP#…` with `ConditionExpression=attribute_not_exists(PK)` (race-safe). `markDone()` writes the long-TTL `SLACK_DONE#…` marker after success.
- `conversation.ts` — Thread history with greedy newest-first truncation to `MAX_HISTORY_CHARS`.
- `formatter.ts` — mrkdwn splitter (paragraph → sentence → line → hard slice) with code-fence balancing. `sanitizeError()` redacts provider tokens.
- `client.ts` — Per-token `WebClient` cache. Lazy `@slack/web-api` import.
- `user-name-cache.ts` — `<@U…>` → display-name cache with parallel warm + in-flight dedupe.
- `acl.ts` — Channel/user allowlist eval. Per-app override (DB) wins when defined; empty list = explicit allow-all (overrides non-empty env).
- `system-prompt.ts` — 5-layer prompt: task rules + Slack mrkdwn rules + attachment rules + `SYSTEM_MESSAGE` (global only) + `PERSONA_MESSAGE` (per-app override resolved upstream).
- `stream.ts` — `StreamingMessage`: lazy placeholder, throttled `chat.update`, roll-finalize on `maxLen` overflow, `msg_too_long` recovery via `chat.postMessage` spill.
- `router.ts` — Event dispatch (`app_mention` / `message.im` / `reaction_added`). Pre-filters unhandled reactions so they never enter dedup.
- `agent.ts` — `streamText` wrapper with `stopWhen: stepCountIs(AGENT_MAX_STEPS)`, `onStepFinish` for tool-call accounting, textStream → `onTextChunk` callback.
- `handlers/message.ts` — `app_mention` + DM. Touch metadata → strip bot self-mention → dedup → ACL → warm user names → load history → run agent → save history → markDone.
- `handlers/reactions.ts` — `:x:` deletes a bot reply; authorization via original asker OR effective `ALLOWED_USER_IDS`. Original-asker lookup uses `conversations.history(latest+inclusive+limit=1)` → `conversations.replies(ts=parent_ts, limit=1)`.
- `tools/registry.ts` — `buildToolRegistry(context)` returns the dict passed to `streamText({ tools })`.
- `tools/time.ts`, `tools/web.ts`, `tools/search.ts`, `tools/slack-tools.ts`, `tools/image.ts` — 11 tools total. See `docs/slack-bot.md` for the per-tool description.

### LLM (`src/lib/llm/`)

- `factory.ts` — `getModel({ provider, model })` over `@ai-sdk/openai` + `@ai-sdk/amazon-bedrock`. `getTextModelFromEnv()` reads `LLM_PROVIDER` / `LLM_MODEL`.
- `vision.ts` — `describeImage({ data, mediaType })` — multimodal `generateText` for the `read_attached_images` tool.

### Auth (`src/lib/auth.ts`, `src/lib/auth/*`)

Better Auth secures the **operator UI** at `/slack` (and the legacy `/dashboard` demo if you keep it).

- `getAuth()` is a lazy singleton — `betterAuth(...)` is constructed on first call so `pnpm build` succeeds without secrets.
- `database: dynamodbAdapter` — the adapter factory in `src/lib/auth/dynamodb-adapter.ts`.
- `secondaryStorage: secondaryStorage` (when `REDIS_URL` or `UPSTASH_REDIS_REST_URL` is set).
- `emailAndPassword` / `socialProviders.google` toggles still apply.
- `src/proxy.ts` (Next 16's renamed `middleware`) does a cheap cookie-presence check on `/dashboard/*` and `/slack/*`. Real validation happens in `app/(protected)/layout.tsx`.

### Operator UI (`src/app/(protected)/slack/`)

- `page.tsx` — list of registered apps.
- `new/page.tsx` — register form. Server action runs `auth.test` against the supplied bot token → writes SSM SecureStrings → upserts the metadata row.
- `[appId]/page.tsx` — display name / channel-allowlist / user-allowlist / persona / danger-zone delete.
- `actions.ts` — server actions. Every action re-calls `getSession()` as defense-in-depth.

### env (`src/lib/env.ts`)

- `clientEnv` — parsed eagerly at import (NEXT_PUBLIC_* only).
- `getServerEnv()` — lazy, server-side only, cached. Throws with a multi-line summary listing every invalid variable.
- Add new env vars to **both** the zod schema and `.env.example`.

### Email / logger / instrumentation

- `src/lib/email.ts` — `getEmailService()` returns an AWS SES sender when `AWS_SES_FROM` is set, otherwise a console-only fallback. Lazy SES SDK import.
- `src/lib/logger.ts` — JSON-line structured logger (CloudWatch-friendly). Honors `LOG_LEVEL` (default `debug` in dev, `info` in prod). Use `logger.child({ ... })` to bind request-scoped fields like `apiAppId`, `channel`, `user`, `client_msg_id`.
- `src/instrumentation.ts` — Next.js `register()` hook. Empty by default; wire Sentry / OpenTelemetry / PostHog here.

### DynamoDB single-table (`src/lib/dynamodb.ts`, `src/lib/dynamodb-helpers.ts`)

One table for Better Auth AND the Slack agent. PK/SK + GSI1 + TTL. Schema details: [`docs/dynamodb-schema.md`](./docs/dynamodb-schema.md). PK prefixes in use:

- **Auth**: `USER#`, `SESSION#`, `ACCOUNT#`, `VERIFICATION#` (SK=`META`).
- **Slack**: `SLACK_APP#`, `SLACK_DEDUP#`, `SLACK_DONE#`, `SLACK_THREAD#` (SK=`META`).
- **Domain demo** (unused after the migration but the helpers stay): `USER#…/PROFILE`, `PROJECT#…/META`, `USER#…/PROJECT#…`.

Always build keys via `keys.*` and `gsi1.*`. Never hand-roll `PK`/`SK` strings — `validateId` (max 256 chars, regex `^[a-zA-Z0-9_-]+$`) and `sanitizeKeyValue` are the only input sanitization layer. Use `getDocumentClient()` for reads/writes (with `removeUndefinedValues: true`).

`dynamodb-helpers.ts` exposes `getItem/putItem/deleteItem/queryByPK/queryGSI1/scanAll/transactWrite/updateItem` thin wrappers — prefer these over raw commands.

### UI

- `src/app/layout.tsx` mounts the global `<Toaster />` and applies `pretendard.variable`. Body styling lives in `globals.css` (tokens + radial gradient).
- shadcn primitives use design tokens (`bg-card`, `text-foreground`, etc.). Avoid raw `slate-*` classes when a token exists.

## Testing

- Unit tests live next to source files (`*.test.ts`). 152 passing at HEAD.
- Integration tests use the `*.integration.test.ts` suffix and run against DynamoDB Local. Each test calls `if (!available) return;` so missing DDB Local just no-ops the assertions.
- `vitest.setup.ts` provides safe defaults for env vars; tests should not depend on `.env.local`.

## Deployment

Target: **AWS Amplify Hosting (SSR)**. Full guide in [`docs/amplify-deploy.md`](./docs/amplify-deploy.md). Key constraints:

- IAM role on the SSR compute role (no static AWS keys in env).
- IAM must grant SSM (GetParameters / PutParameter / DeleteParameter on `SLACK_SSM_PREFIX/*`) AND DynamoDB.
- Upstash Redis REST for `secondaryStorage` (no VPC).
- `BETTER_AUTH_URL` + `TRUSTED_ORIGINS` must match the deployed origin.

## Common gotchas

- **`after()` on Amplify SSR**: confirm via CloudWatch on first deploy that the post-response work runs (see `docs/slack-bot.md` verification steps). The whole agent design rides on this.
- **Slack signing**: do NOT read JSON via Next's helpers before signing verification — the HMAC is computed over the exact bytes Slack sent, not a parse/stringify round-trip.
- **Slack file Authorization leak**: only files*.slack.com get the bot token. Profile-image hosts (`avatars.slack-edge.com`, `secure.gravatar.com`) are public CDN — sending the token would leak it via redirects. The Slack-file fetcher always sets `redirect: "manual"`.
- **`pnpm install`** may prompt to re-create `node_modules` after `package.json` changes — normal pnpm behavior.
- **`pnpm-workspace.yaml`** exists with `packages: []` so pnpm 11 honors `allowBuilds` (esbuild/sharp/unrs-resolver opt-ins).
- **`next/font/local`** requires a literal path — it cannot reach into `node_modules`. The postinstall copy script (`scripts/copy-fonts.mjs`) is intentional.
- **DynamoDB Local doesn't support TTL** — `pnpm db:init` swallows the `UnknownOperationException` and warns. Production DynamoDB does support it.
- **Local dev hits real AWS by default** for both DynamoDB and SSM (uses the local credential chain). To use DynamoDB Local instead, start the `test` Compose profile and set `DYNAMODB_ENDPOINT="http://localhost:8000"`. There's no SSM Local equivalent — develop against your real dev-account SSM, or stub `getSlackCredentials` deps in tests.
- **`pnpm db:init`** waits for the table to become `ACTIVE` after `CreateTable` before enabling TTL — real AWS returns from CreateTable while the table is still in `CREATING` state.
