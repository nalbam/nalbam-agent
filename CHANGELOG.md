# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Improved — audit follow-up

- **Agent forced-compose** — when `stepCountIs(N)` halts on a tool-calls
  turn without final text, the agent now runs one extra tool-less
  `generateText` follow-up so the user gets an answer instead of the
  "(응답을 생성하지 못했습니다)" fallback. Mirrors the original
  `_compose_without_tools`.
- **`request_id` + `logger.child`** — every request now carries a
  per-invocation UUID through router → handlers → agent → tools so
  CloudWatch can group a single request's events in multi-tenant
  deployments.
- **Thread history OCC** — `loadThreadHistory` returns a row version,
  `saveThreadHistory` enforces it via `ConditionExpression`. Concurrent
  mentions in the same thread now lose loudly (`slack.conversation.race_lost`)
  instead of silently dropping a turn via last-write-wins.
- **`touchSlackApp` after dedup** — retries/duplicates no longer bump
  `lastSeenAt`. Read the existing row before dedup (for `botUserId`),
  defer the write until dedup passes.
- **`slack.agent.start` log uses display name** — `getUserName` resolves
  the Slack handle before the start event so CloudWatch reads more
  naturally than raw `Uxxxx`.
- **`assistant.threads.setStatus`** — typing-style indicator while the
  agent works, before the first stream chunk arrives. Graceful no-op on
  workspaces without the assistant API.
- **`read_attached_images` vision calls parallel** — `Promise.all` over
  the candidates instead of serial `await`; limit=3 is now ~3× faster on
  the multimodal LLM round-trips.
- **`MAX_THROTTLE_COUNT` enforced** — Upstash/Valkey INCR counter with
  TTL fallback. No-op when neither KV is configured.
- **Reactions handler retries** — `conversations.history` and
  `conversations.replies` now go through the shared `withSlackRetry`
  helper. `withSlackRetry` was promoted from `tools/slack-tools.ts` to
  `src/lib/slack/with-retry.ts` so it can be reused across modules.
- **`search.ts` `redirect: "manual"`** — defense-in-depth consistency
  with the other tool fetches; the search hosts don't redirect today
  but a future change wouldn't bypass the SSRF posture.
- **`edit_image` actually edits** — direct OpenAI `/v1/images/edits`
  multipart call (`@ai-sdk/openai` does not expose an edit primitive).
  Replaces the prior stub. Bedrock edit remains unsupported and returns
  a structured error so the agent pivots to `generate_image`.
- **Operator UI allowlist** — `OPERATOR_ALLOWED_EMAILS` env (CSV) gates
  `/slack/*` at the layout level AND at every server action's
  `requireSession()` as defense-in-depth. Unset = open mode with a
  `slack.operator.allowlist_empty` warning per request.
- **Handler integration tests** — 14 new tests covering `handleMessage`
  (dedup short-circuit, empty-text bail, dedup-then-touch order, channel
  block, user block, throttle reject, throttle release on agent throw)
  and `handleReaction` (`:x:` asker / item-user / unauthorized / dedup /
  ALLOWED_USER_IDS).

### Added — Slack AI agent migration

Ported `lambda-gurumi-bot` (Python + Serverless Framework + AWS Lambda) onto this Next.js 16 + Better Auth + DynamoDB codebase, deployed to AWS Amplify Hosting (SSR). Five sequential PRs:

- **PR1 — Infrastructure** (`1d3c024`):
  - 27 new server env vars (`SLACK_SSM_*`, `LLM_*`, agent budget, rendering caps, doc/web/image limits, ACL, persona) validated with zod.
  - DynamoDB key builders extended with `slackApp / slackDedup / slackDone / slackThread` and `gsi1.bySlackTeam`.
  - `src/lib/slack/` modules: `verify` (HMAC + 5-min replay guard), `credentials` (SSM SecureString reader/writer + TTL + negative cache), `app-metadata` (CRUD), `dedup` (two-stage idempotency), `conversation` (history with greedy newest-first truncation), `formatter` (mrkdwn splitter + token redaction), `client` (per-token WebClient cache), `user-name-cache` (parallel warm + in-flight dedupe).

- **PR2 — Events route + agent** (`0ce1149`):
  - `POST /api/slack/events` — verify → dedup → `next/server` `after()` → 200 OK in <200ms.
  - Vercel AI SDK `streamText` wrapper with `stopWhen: stepCountIs(AGENT_MAX_STEPS)`.
  - `StreamingMessage` — lazy placeholder, throttled `chat.update`, code-fence balancing on overflow, `msg_too_long` recovery via `chat.postMessage` spill.
  - 5-layer system prompt (task rules + Slack mrkdwn + attachment rules + `SYSTEM_MESSAGE` + per-app `PERSONA_MESSAGE`).
  - ACL evaluator with per-app override semantics (empty list = explicit allow-all, empty string = explicit no persona).

- **PR3 — Agent tools** (`60bfe89`): 8 tools wired into the registry:
  - `get_current_time` (IANA timezone)
  - `fetch_webpage` (Jina Reader + raw HTML fallback, DNS-public-IP SSRF guard)
  - `search_web` (Tavily → DuckDuckGo) / `search_images` (Tavily-only)
  - `read_attached_images` (with `describeImage` vision call), `read_attached_document` (PDF via `unpdf`, text/* via UTF-8 decode), `fetch_user_profile`, `fetch_thread_history` (parallel name warm + per-message + aggregate text budget)

- **PR4 — Image tools** (`4297bd3`):
  - `generate_image` (OpenAI-only via `experimental_generateImage`)
  - `attach_image_from_url` (HTTPS + SSRF guard + magic-byte detection + `files.uploadV2`)
  - `edit_image` (stub returning structured error so the agent can pivot)

- **PR5 — Reactions + operator UI + CLI + docs** (`f09953f`):
  - `reaction_added` `:x:` deletes a bot reply when reactor is the original asker OR appears in effective `ALLOWED_USER_IDS`.
  - Better Auth-protected operator UI at `/slack`, `/slack/new`, `/slack/[appId]` (list / register with `auth.test` verification / edit ACL+persona+displayName / danger-zone delete).
  - `pnpm slack-apps` CLI mirroring the same operations.
  - `docs/slack-bot.md` (new) + `docs/amplify-deploy.md` updates (SSM + Bedrock IAM statements, Slack-bot env-var table).

Test footprint: 152 unit tests across 17 files. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` all green at HEAD.

### Known limitations

- **`after()` on Amplify SSR is unverified in-the-wild.** First deploy must confirm via CloudWatch that `slack.agent.start` → `slack.agent.done` both appear after the HTTP 200 returns. Fallback paths (Upstash QStash / SQS / self-invoke) are sketched in `docs/slack-bot.md`.
- Bedrock image generation / edit (Nova Canvas / Titan Image) is not wired — OpenAI-only for now. Both `generate_image` and `edit_image` surface an explicit error when `IMAGE_PROVIDER=bedrock`.
- User memory tools (`remember` / `forget`) from the Python original are intentionally not migrated; the `mem:{user_id}` key prefix is reserved.

## [0.1.0] — Starter foundation

Pre-Slack-bot scaffolding (preserved on `8bd6227 Initial commit`):

- Next.js 16 (App Router) + React 19 + TypeScript strict (`noUncheckedIndexedAccess`, `noImplicitOverride`).
- Better Auth 1.6 with custom DynamoDB single-table adapter (`src/lib/auth/dynamodb-adapter.ts`).
- Upstash Redis (prod) / Valkey (dev) as Better Auth `secondaryStorage` (auto-fallback to in-memory).
- Google OAuth (`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`) gated by `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED`.
- Email/password sign-in toggle (`AUTH_EMAIL_ENABLED` / `NEXT_PUBLIC_AUTH_EMAIL_ENABLED`).
- zod-validated env (`src/lib/env.ts`) with lazy server resolution.
- Auth pages (`/login`, `/signup`), demo dashboard, cookie-based middleware guard.
- App Router essentials: `error.tsx`, `not-found.tsx`, `loading.tsx`, `/api/health`, `/api/csp-report`.
- SEO / PWA: `sitemap.ts`, `robots.ts`, `manifest.ts`, `opengraph-image.tsx`.
- shadcn/ui primitives, Pretendard variable font via `next/font/local`.
- `docker-compose.yml` (Valkey + DynamoDB Local + admin UI) and `pnpm db:init` provisioning script.
- Vitest unit + integration harness, ESLint flat config, Prettier, Husky + lint-staged + commitlint.
- AWS Amplify deploy assets (`amplify.yml`, IAM policy template).
