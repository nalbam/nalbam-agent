# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please **do not open a public GitHub issue**.

Instead, email the maintainer at the address listed on the GitHub profile of [@nalbam](https://github.com/nalbam) with:

- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Affected version / commit

You should expect an initial acknowledgment within **3 business days** and a remediation plan within **14 days** for confirmed issues.

## Scope

The codebase is currently a greenfield skeleton (see [`docs/architecture.md`](./docs/architecture.md) / [`docs/roadmap.md`](./docs/roadmap.md)). The implemented surface is the auth + shared infrastructure; the agent surface exists as interfaces today and is hardened as each piece is implemented.

In scope — **implemented**:

- Better Auth configuration (`src/lib/auth.ts`, `src/lib/auth/*`) and the DynamoDB single-table adapter (`src/lib/auth/dynamodb-adapter.ts`).
- Server-only env handling (`src/lib/env.ts`).
- DynamoDB key sanitization — `validateId` / `sanitizeKeyValue` (`src/lib/dynamodb.ts`).
- Operator gate (`src/lib/auth/operator.ts`) + the `/operator/*` cookie check in `src/proxy.ts`.
- Security headers + CSP in `next.config.ts`; CSP report receiver at `/api/csp-report`.
- Open-redirect guard `src/lib/safe-redirect.ts` (`/login`, `/signup`).

In scope — **agent surface (in progress; design in [`docs/architecture.md`](./docs/architecture.md) §7)**:

- Channel ingress `/api/channels/[channel]` and per-channel verification (HMAC signature / API token) in each `ChannelAdapter.ingest`.
- SSRF guards in capability-bound tools — host allowlist, HTTPS-only, `redirect: "manual"`, byte caps; bearer tokens sent only to trusted hosts.
- Two-stage idempotency (`DedupService`) and deny-by-default access control (`AclPolicy`).
- Per-channel credential isolation (`CredentialProvider`) — secrets in a secret manager (e.g. SSM SecureString), never in code or DynamoDB.

Agent security acceptance criteria before production use:

- Every enabled channel verifies authenticity before normalization and rejects replayed requests.
- Every agent storage key is scoped by `{channel}:{tenantId}` through a shared key builder.
- Agent ACL is deny-by-default unless an explicit tenant or deployment policy allows the user/surface.
- Tool network access is HTTPS-only, size-capped, redirect-controlled, and protected against private/link-local targets.
- Logs and error payloads redact tokens, signatures, raw request bodies, user-provided bearer values, and secret manager paths that reveal tenant internals.
- Credential rotation has a bounded cache TTL and an explicit invalidation path.

Out of scope (please report upstream):

- [Better Auth](https://github.com/better-auth/better-auth) core.
- [Vercel AI SDK](https://github.com/vercel/ai), `@ai-sdk/openai`, `@ai-sdk/amazon-bedrock`.
- AWS SDK v3, `@slack/web-api`, `unpdf`.
- Next.js / React.

## Hardening expectations for operators

If you deploy this project:

1. **Rotate** `BETTER_AUTH_SECRET` and any AWS credentials before the first deploy — never reuse example values.
2. Set `TRUSTED_ORIGINS` for every production origin you serve from.
3. Restrict the IAM role on the SSR compute role to the minimum DynamoDB actions (+ SSM once a channel credential provider is implemented), scoped to your table and its GSI; scope `ssm:*Parameter*` ARNs to your `SLACK_SSM_PREFIX`.
4. Enable encryption at rest on your DynamoDB table (default for new tables; verify on imports).
5. Set `OPERATOR_ALLOWED_EMAILS` in production — when unset, any authenticated user passes (an `operator.allowlist_empty` warning is logged).
6. Keep per-channel secrets in a secret manager (SSM SecureString / KMS) — never in env vars or DynamoDB.
7. Keep dependencies current — `pnpm audit` is wired into CI; treat any high/critical finding as blocking.
8. Treat each channel tenant as a separate security boundary. Do not reuse bot tokens, API tokens, or signing secrets across tenants.
9. Verify `after()` behavior in your SSR host before accepting webhook traffic. If post-response work can be interrupted, run channel processing through a durable queue/worker.

Watch CloudWatch for these event keys (skeleton; per-channel verification keys are added as each adapter is implemented):

- `operator.allowlist_empty` — operator UI is wide open (allowlist unset).
- `agent.start` / `agent.done` — conversation pipeline lifecycle.
- `dedup.skip` with `reason: in_flight` — potential thundering-herd retries.
- `acl.blocked` — access-control denials.
