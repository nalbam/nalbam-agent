# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**`nalbam-agent`** — the goal is a **multi-tenant, multi-channel, plugin-extensible AI agent** (design: [`docs/architecture.md`](./docs/architecture.md); implementation goals: [`docs/roadmap.md`](./docs/roadmap.md)).

**The code is a working MVP-in-progress** built on that design — no longer a pure skeleton. The transport-agnostic core runs end to end: the HTTP API channel flows to a real LLM provider, and the Slack channel verifies/normalizes Events API webhooks, replies via a `chat.postMessage`/`chat.update` responder, and exposes its capabilities. Many target features remain (see snapshot). Keep building per `docs/roadmap.md` "구현 순서" — **without modifying the core for a new channel/tool/provider**.

Current implementation snapshot (roadmap "현재 구현 스냅샷" is the source of truth):
- Implemented: normalized core types, channel/tool/provider registries, `runConversation` pipeline with real KV-backed dedup/throttle + deny-by-default ACL + static tenant resolver; `aiSdkAgentRuntime` (`streamText` + delta streaming + step/token accounting); openai/bedrock/openai-compatible providers; Slack adapter (HMAC verify, normalize, responder, `fetchHistory`/`downloadAttachment`/`uploadMedia`/`fetchUserProfile` capabilities) + SSM credential provider; token-based HTTP API channel (SHA-256 token, S3 `uploadMedia`); `StorageProvider` (DynamoDB `kv`+`doc`, S3-or-memory `blob`); `get_current_time` + `save_text_artifact` tools; Better Auth + DynamoDB infrastructure (secondaryStorage also on DynamoDB KV).
- Partial/stubs: forced-compose (hardcoded off), connection-mode worker (`src/worker/socket-worker.ts` throws), in-memory memory store (conversation/user memory not yet on the DynamoDB `doc` backend), search memory.
- Missing: Web UI / Telegram channels; web/search/document/image/execute/read/edit/delegate/todo tools; generic per-channel `CredentialProvider` + cache/rotation; operator UI.

MVP acceptance target (not yet fully met): the Slack webhook path through dedup/throttle/ACL/memory + a real LLM provider + Slack final reply, plus HTTP API as a second channel — all without touching `src/core`. See `docs/roadmap.md` "MVP 수용 기준".

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
docker compose --profile test up -d   # DynamoDB Local + admin UI (integration tests)
```

`.env.local` minimum: `BETTER_AUTH_SECRET` (≥ 32 chars), `AWS_REGION`, `DYNAMODB_TABLE_NAME`, and `OPENAI_API_KEY` when `LLM_PROVIDER=openai`. Per channel: `S3_BUCKET_NAME` to enable the S3 blob backend (else in-memory), `API_CHANNEL_TOKENS` (`tenant_id:sha256_hex` list) for the HTTP API channel, `AGENT_TENANTS_JSON` for static tenant metadata until the operator/doc backend owns it. Local AWS credentials (via `~/.aws/credentials`, `AWS_PROFILE`, or SSO) must be available — dev hits real DynamoDB by default. Add every new env var to **both** the zod schema in `src/lib/env.ts` and `.env.example`.

## Stack & conventions

- **Next.js 16 App Router** under `src/app/`, React 19, TypeScript `strict + noUncheckedIndexedAccess + noImplicitOverride`.
- **Vercel AI SDK 6** (`ai` + `@ai-sdk/openai` + `@ai-sdk/amazon-bedrock`; openai-compatible providers `xai`/`gemini`/`claude` via `createOpenAI`) — the agent runtime uses `streamText` with `stopWhen: stepCountIs(...)`.
- **Path alias**: `@/*` → `./src/*`.
- **Tailwind v4** via `@tailwindcss/postcss`. Tokens in `src/app/globals.css` under `@theme inline`. No `tailwind.config.*`.
- **shadcn/ui** (`new-york`, base color `slate`) in `src/components/ui/`.
- **Pretendard** fonts copied from `node_modules/pretendard` into `src/app/fonts/` by `scripts/copy-fonts.mjs` (postinstall). `next/font/local` needs a literal path, hence the copy.
- `@slack/web-api` + `@aws-sdk/client-ssm` are used by the Slack channel (responder/capabilities + SSM credential provider); `@aws-sdk/client-s3` + `s3-request-presigner` back the S3 blob store; `unpdf` is retained for the document tool not yet implemented.

## Architecture

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
- `deps.ts` — `buildPipelineDeps()` wires **real services**: DynamoDB KV-backed dedup/throttle (`dedup-service.ts`/`throttle-service.ts`), deny-by-default `acl-policy.ts`, `AGENT_TENANTS_JSON`-backed `tenant-resolver.ts`, in-memory memory store (DynamoDB `doc` backend wiring pending), `StorageProvider`, and `aiSdkAgentRuntime`.

### `src/channels/` — channel adapters (plugin)
- `types.ts` — `ChannelAdapter` (ingest / credentials / responder / capabilities / renderingRules), `Responder`, `Capabilities`, `RawIngress`, `IngestResult`, mode `webhook | connection | http`.
- `registry.ts` — `defineChannel` / `getChannel` / `listChannels`. `index.ts` — side-effect registration of bundled adapters (`slack`, `api`).
- `slack/adapter.ts` — Slack Events API adapter: HMAC signature verify + timestamp replay guard, mention/surface normalization, `chat.postMessage`/`chat.update` responder with chunking, and `fetchHistory`/`downloadAttachment`/`uploadMedia`/`fetchUserProfile` capabilities. `slack/credentials.ts` — `ssmSlackCredentialProvider` reads signing secret + bot token from SSM SecureString with TTL cache. (Socket Mode / connection adapter not yet.)
- `api/adapter.ts` — token-based HTTP API channel: SHA-256 bearer-hash auth (constant-time), zod-validated normalization, synchronous responder, S3-backed `uploadMedia`.

### `src/agent/` — runtime, providers, tools
- `runtime.ts` — `AgentRuntime` interface + `aiSdkAgentRuntime`: multi-step `streamText` loop with `stepCountIs`, delta streaming to the responder, step/token/tool-call accounting. Forced-compose is hardcoded off; `stubAgentRuntime` remains for tests.
- `system-prompt.ts` — layered prompt; the adapter injects channel rendering rules.
- `providers/` — `LlmProvider` registry (`defineProvider` / `getModel`) + `openai`/`bedrock`/`openai-compatible` (`xai`/`gemini`/`claude`); all working.
- `tools/` — `ToolDefinition` (+ `requires: Capability[]`), `registry.ts` `buildToolset(ctx)` registers a tool only when the channel provides every required capability. Implemented: `channel-agnostic/time.ts` (`get_current_time`) and `capability-bound/save-artifact.ts` (`save_text_artifact`, requires `uploadMedia`). The rest (web/search/attachments/profile/history/image/execute/edit/delegate/todo) are to be added.

### `src/storage/`, `src/memory/`, `src/credentials/`
- `storage/types.ts` — `StorageProvider` (`kv` + `doc` + `blob`). `provider.ts` factory: `kv`/`doc` are DynamoDB (`dynamodb-kv.ts`/`dynamodb-doc.ts`, single table; KV uses conditional `setNx` + atomic `ADD` + native TTL with lazy `expiresAt`), `blob` is `s3-blob.ts` when `S3_BUCKET_NAME` is set else `memory-blob.ts`. in-memory `kv`/`doc` (`memory-kv.ts`/`memory-doc.ts`) remain as test doubles.
- `memory/types.ts` — `MemoryStore`. `memory-store.ts` implements in-memory short-term (conversation, char-budget trim) + long-term (`mem:`, `remember`/`forget`); search is interface-only. Operational backend + TTL/OCC to be added.
- `credentials/types.ts` — generic `CredentialProvider` interface (no generic impl yet). The Slack channel ships its own `ssmSlackCredentialProvider` (SSM SecureString); secrets stay in the secret manager, never in code/DB.

### `src/observability/`, `src/worker/`
- `observability/context.ts` — `requestLogger(fields)` over `logger.child`.
- `worker/socket-worker.ts` — stub entry point for connection-mode channels (Slack Socket Mode / Telegram).

### Reused infrastructure (not greenfield)
- `src/lib/env.ts` — zod-validated server/client env; `getServerEnv()` lazy + cached, fail-fast.
- `src/lib/logger.ts` — JSON-line structured logger; `logger.child({...})` for request-scoped fields.
- `src/lib/dynamodb.ts` + `dynamodb-helpers.ts` — single-table client + `keys.*`/`gsi1.*` + `getItem/putItem/deleteItem/queryGSI1/scanAll/updateItem`. Build keys via `keys.*`; `validateId`/`sanitizeKeyValue` are the only input sanitization.
- `src/lib/auth*` — Better Auth (operator UI) with the DynamoDB adapter; `secondaryStorage` rides on the DynamoDB-backed KV store (`src/lib/auth/secondary-storage.ts`). `src/lib/auth/operator.ts` gates the (future) operator UI on `OPERATOR_ALLOWED_EMAILS`.
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
- IAM on the SSR compute role (no static AWS keys), granting DynamoDB, SSM (Slack credential provider), and S3 (blob store).
- `secondaryStorage` and the agent KV both ride on DynamoDB — no separate Redis/KV infra or VPC.
- `BETTER_AUTH_URL` + `TRUSTED_ORIGINS` must match the deployed origin.

## Common gotchas

- **`after()` on Amplify SSR is load-bearing** — confirm on first deploy that post-response work (`agent.start` → `agent.done`) runs after the HTTP 200. See [`docs/roadmap.md`](./docs/roadmap.md) §9.
- **Don't modify the core to add a channel/tool/provider** — implement the interface and self-register via `defineChannel`/`defineTool`/`defineProvider`.
- **Scope every tenant key** — dedup, throttle, conversation, memory, credentials, and usage must include `{channel}:{tenantId}`. Do not use bare `userId` or `conversationId` in persistent keys.
- **Capabilities, not channel names** — capability-bound tools should test `ctx.caps`, never `msg.channel === "slack"`.
- **Webhook signature verification** (when implementing a channel's `ingest`): hash the exact raw bytes — never a JSON parse/stringify round-trip.
- **`next/font/local`** needs a literal path; the postinstall copy script is intentional.
- **DynamoDB Local doesn't support TTL** — `pnpm db:init` swallows the error and warns. Production supports it.
- **Local dev hits real AWS by default** (DynamoDB). Use the `test` Compose profile + `DYNAMODB_ENDPOINT` for DynamoDB Local.
