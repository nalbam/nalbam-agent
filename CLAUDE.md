# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**`nalbam-agent`** — the goal is a **multi-tenant, multi-channel, plugin-extensible AI agent** (design: [`docs/architecture.md`](./docs/architecture.md); implementation goals: [`docs/roadmap.md`](./docs/roadmap.md)).

**The current code is a greenfield skeleton** of that design — interfaces and not-implemented stubs that compile, type-check, and pass a small contract test suite. It does **not** yet run a real agent. The previous Slack-only implementation was removed; Slack is now just the first channel adapter, currently a stub. Build real behavior by filling the skeleton per `docs/roadmap.md` "구현 순서" — **without modifying the core for a new channel/tool/provider**.

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
pnpm db:init            # provision DynamoDB table + GSI1 + TTL (real AWS by default)
pnpm db:delete          # delete the table (refuses without ManagedBy=CloudManager tag)
docker compose up -d    # Valkey only (KV)
docker compose --profile test up -d   # also starts DynamoDB Local + admin UI
```

`.env.local` minimum: `BETTER_AUTH_SECRET` (≥ 32 chars), `AWS_REGION`, `DYNAMODB_TABLE_NAME`, and `OPENAI_API_KEY` when `LLM_PROVIDER=openai`. Local AWS credentials (via `~/.aws/credentials`, `AWS_PROFILE`, or SSO) must be available — dev hits real DynamoDB by default. Add every new env var to **both** the zod schema in `src/lib/env.ts` and `.env.example`.

## Stack & conventions

- **Next.js 16 App Router** under `src/app/`, React 19, TypeScript `strict + noUncheckedIndexedAccess + noImplicitOverride`.
- **Vercel AI SDK 6** (`ai` + `@ai-sdk/openai` + `@ai-sdk/amazon-bedrock`) — the agent runtime will use `streamText` with `stopWhen: stepCountIs(...)`.
- **Path alias**: `@/*` → `./src/*`.
- **Tailwind v4** via `@tailwindcss/postcss`. Tokens in `src/app/globals.css` under `@theme inline`. No `tailwind.config.*`.
- **shadcn/ui** (`new-york`, base color `slate`) in `src/components/ui/`.
- **Pretendard** fonts copied from `node_modules/pretendard` into `src/app/fonts/` by `scripts/copy-fonts.mjs` (postinstall). `next/font/local` needs a literal path, hence the copy.
- Some deps (`@slack/web-api`, `unpdf`, `@aws-sdk/client-ssm`) are retained for the Slack channel + document tools that are not yet reimplemented.

## Architecture (greenfield skeleton)

Transport-agnostic core; channels/tools/providers/storage plug in behind interfaces. Data flow:

```
POST /api/channels/[channel]  → adapter.ingest() normalizes native payload → InboundMessage
  → after(() => runConversation(msg, adapter, deps))   (HTTP 200 returns immediately)
runConversation: dedup → tenant → ACL → throttle → context → agent → egress(Responder) → persist
```

### `src/core/` — channel-agnostic domain
- `types.ts` — `InboundMessage` / `OutboundChunk` / `Attachment` / `MediaRef` / `HistoryEntry` / `Surface`.
- `pipeline.ts` — `runConversation(msg, adapter, deps)`; cross-cutting flow. Keys scoped `{channel}:{tenantId}:…`.
- `dedup.ts` / `acl.ts` / `throttle.ts` — service **interfaces** (`DedupService`, `AclPolicy`, `ThrottleService`).
- `tenant.ts` — `TenantConfig` / `TenantResolver`. `errors.ts` — `NotImplementedError`.
- `deps.ts` — `buildPipelineDeps()` wires **passthrough/no-op stub services** so the pipeline flows end to end. Replace with real services per roadmap.

### `src/channels/` — channel adapters (plugin)
- `types.ts` — `ChannelAdapter` (ingest / credentials / responder / capabilities / renderingRules), `Responder`, `Capabilities`, `RawIngress`, `IngestResult`, mode `webhook | connection | http`.
- `registry.ts` — `defineChannel` / `getChannel` / `listChannels`. `index.ts` — side-effect registration of bundled adapters.
- `slack/adapter.ts` — **stub** Slack adapter (`ingest` throws `NotImplementedError`; responder/capabilities are no-ops).

### `src/agent/` — runtime, providers, tools
- `runtime.ts` — `AgentRuntime` interface + `stubAgentRuntime` (returns an empty result). Real multi-step `streamText` loop + forced-compose lands later.
- `system-prompt.ts` — layered prompt; the adapter injects channel rendering rules.
- `providers/` — `LlmProvider` registry (`defineProvider` / `getModel`) + `openai`/`bedrock` (these **work**).
- `tools/` — `ToolDefinition` (+ `requires: Capability[]`), `registry.ts` `buildToolset(ctx)` registers a tool only when the channel provides every required capability. `channel-agnostic/time.ts` is the one working tool; the rest (web/search/attachments/profile/history/image) are to be added.

### `src/storage/`, `src/memory/`, `src/credentials/`
- `storage/types.ts` — `StorageProvider` (`KvStore` + `DocStore`). `storage/memory-kv.ts` — working in-memory KV (tests/dev). DynamoDB doc backend to be added (reuse `dynamodb-helpers.ts`).
- `memory/types.ts` — `MemoryStore` (short-term conversation / long-term `mem:` / optional search). No impl yet.
- `credentials/types.ts` — `CredentialProvider` (secrets in a secret manager, never in code/DB). No impl yet.

### `src/observability/`, `src/worker/`
- `observability/context.ts` — `requestLogger(fields)` over `logger.child`.
- `worker/socket-worker.ts` — stub entry point for connection-mode channels (Slack Socket Mode / Telegram).

### Reused infrastructure (not greenfield)
- `src/lib/env.ts` — zod-validated server/client env; `getServerEnv()` lazy + cached, fail-fast.
- `src/lib/logger.ts` — JSON-line structured logger; `logger.child({...})` for request-scoped fields.
- `src/lib/dynamodb.ts` + `dynamodb-helpers.ts` — single-table client + `keys.*`/`gsi1.*` + `getItem/putItem/deleteItem/queryGSI1/scanAll/updateItem`. Build keys via `keys.*`; `validateId`/`sanitizeKeyValue` are the only input sanitization.
- `src/lib/auth*` — Better Auth (operator UI) with the DynamoDB adapter; `secondaryStorage` when Redis/Upstash is set. `src/lib/auth/operator.ts` gates the (future) operator UI on `OPERATOR_ALLOWED_EMAILS`.
- `src/lib/email.ts` — SES sender when `AWS_SES_FROM` is set, else console fallback.
- `src/proxy.ts` — cheap session-cookie check on `/operator/*` (operator UI added later); real validation in `app/(protected)/layout.tsx`.
- Next app shell: `layout/page/error/not-found/loading/manifest/sitemap/robots/opengraph`, `src/components/ui/`, `src/instrumentation.ts` (empty `register()` hook — wire Sentry/OTel/PostHog).

### DynamoDB single-table
One table for Better Auth (`USER#`, `SESSION#`, `ACCOUNT#`, `VERIFICATION#`; the adapter builds its own keys) and the agent's future rows. PK/SK + GSI1 + TTL.

## Testing

- Unit/contract tests next to source files (`*.test.ts`): pipeline call order, tool capability filtering, channel registry, in-memory KV.
- Integration tests use the `*.integration.test.ts` suffix against DynamoDB Local; each no-ops when DDB Local is absent.
- `vitest.setup.ts` provides safe env defaults; tests must not depend on `.env.local`.

## Deployment

Target: **AWS Amplify Hosting (SSR)**. Webhook/http channels run on the SSR Lambda; connection-mode channels need the long-running `src/worker/`. Constraints:
- IAM on the SSR compute role (no static AWS keys), granting DynamoDB (+ SSM for the Slack credential provider once implemented).
- Upstash Redis REST for `secondaryStorage` / KV (no VPC).
- `BETTER_AUTH_URL` + `TRUSTED_ORIGINS` must match the deployed origin.

## Common gotchas

- **`after()` on Amplify SSR is load-bearing** — confirm on first deploy that post-response work (`agent.start` → `agent.done`) runs after the HTTP 200. See [`docs/roadmap.md`](./docs/roadmap.md) §9.
- **Don't modify the core to add a channel/tool/provider** — implement the interface and self-register via `defineChannel`/`defineTool`/`defineProvider`.
- **Webhook signature verification** (when implementing a channel's `ingest`): hash the exact raw bytes — never a JSON parse/stringify round-trip.
- **`next/font/local`** needs a literal path; the postinstall copy script is intentional.
- **DynamoDB Local doesn't support TTL** — `pnpm db:init` swallows the error and warns. Production supports it.
- **Local dev hits real AWS by default** (DynamoDB). Use the `test` Compose profile + `DYNAMODB_ENDPOINT` for DynamoDB Local.
