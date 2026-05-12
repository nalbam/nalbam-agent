# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please **do not open a public GitHub issue**.

Instead, email the maintainer at the address listed on the GitHub profile of [@nalbam](https://github.com/nalbam) with:

- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Affected version / commit

You should expect an initial acknowledgment within **3 business days** and a remediation plan within **14 days** for confirmed issues.

## Scope

In scope:

**Slack agent surface**
- The Slack events receiver at `/api/slack/events` (`src/app/api/slack/events/route.ts`).
- Slack request signature verification (`src/lib/slack/verify.ts`) — HMAC computation, timing-safe compare, replay window.
- Per-app secret handling via AWS SSM Parameter Store (`src/lib/slack/credentials.ts`) — caching, negative cache, rotation invalidation.
- Slack-file download SSRF guards (`src/lib/slack/tools/slack-tools.ts`, `src/lib/slack/tools/image.ts`):
  - Host allowlist (`files*.slack.com`, profile-image CDN hosts).
  - `Authorization: Bearer <bot_token>` sent only to `files*.slack.com`, never to profile / CDN hosts.
  - `redirect: "manual"` on every Slack-file fetch.
- Public-web SSRF guard in `src/lib/slack/tools/web.ts` and `image.ts`:
  - HTTPS only, IP literal rejected, DNS resolves to public unicast (IPv4 + IPv6 + IPv4-mapped).
  - `redirect: "manual"` on every external fetch.
- Magic-byte image-format detection in `attach_image_from_url` (`src/lib/slack/tools/image.ts`) — header trust insufficient; PNG / JPEG / GIF / WebP / BMP signatures verified.
- Two-stage idempotency in `src/lib/slack/dedup.ts` — prevents agent re-execution on Slack/Lambda retries.
- ACL evaluator in `src/lib/slack/acl.ts` — channel/user allowlist with per-app overrides (DynamoDB) over env CSV.
- Operator UI server actions at `src/app/(protected)/slack/actions.ts` — every action re-validates the session via `getSession()` as defense-in-depth against direct fetch attacks on the action endpoint.

**Auth + shared infrastructure**
- Better Auth configuration (`src/lib/auth.ts`, `src/lib/auth/*`).
- The DynamoDB single-table adapter (`src/lib/auth/dynamodb-adapter.ts`).
- Server-only env handling (`src/lib/env.ts`).
- Security headers + CSP defined in `next.config.ts`.
- CSP report receiver at `/api/csp-report`.
- Open-redirect guard `src/lib/safe-redirect.ts` (`/login` and `/signup`).

Out of scope (please report upstream):
- [Better Auth](https://github.com/better-auth/better-auth) core.
- [Vercel AI SDK](https://github.com/vercel/ai), `@ai-sdk/openai`, `@ai-sdk/amazon-bedrock`.
- AWS SDK v3, `@slack/web-api`, `unpdf`.
- Next.js / React.

## Hardening expectations for operators

If you deploy this project:

1. **Rotate** `BETTER_AUTH_SECRET` and any AWS credentials before the first deploy — never reuse example values.
2. Set `TRUSTED_ORIGINS` for every production origin you serve from.
3. Restrict the IAM role attached to your Amplify SSR compute role to the minimum DynamoDB + SSM (+ optional Bedrock + SES) actions documented in [`docs/amplify-deploy.md`](./docs/amplify-deploy.md). In particular, scope `ssm:*Parameter*` ARNs to your `SLACK_SSM_PREFIX`.
4. Enable encryption at rest on your DynamoDB table (default for new tables; verify on imports).
5. Use SSM SecureString (KMS) for per-app `signing_secret` and `bot_token` — never put them in env vars or DynamoDB.
6. **Rotate Slack secrets immediately if a token leaks.** `pnpm slack-apps register` overwrites both SSM parameters in place; the next request picks up the new values within the SSM cache TTL (default 5 min). Force-invalidate via `pnpm slack-apps delete` followed by `register` if you need to be sure.
7. Consider gating the operator UI to a known internal email domain — the starter Better Auth setup accepts any sign-up. The `/slack/*` routes use a generic "any authenticated user" check today; if you treat the bot configuration as sensitive, add a role check to `(protected)/slack/actions.ts` requireSession helper.
8. Tighten the `ssm:PutParameter` / `ssm:DeleteParameter` IAM permissions to a dedicated bootstrap role if you don't want runtime invocations to be able to write secrets — leave only `ssm:GetParameters` on the SSR compute role.
9. Watch CloudWatch for these event keys to detect abuse:
   - `slack.route.bad_signature` (verification failures)
   - `slack.route.unknown_app` (unconfigured app pinging the endpoint)
   - `slack.channel.blocked` / `slack.user.blocked` (ACL hits)
   - `slack.reaction.unauthorized` (`:x:` from a user who isn't the asker and isn't in the allowlist)
   - `slack.dedup.skip` with `reason: in_flight` (potential thundering-herd retries)
10. Keep dependencies current — `pnpm audit` is wired into CI; treat any high/critical finding as blocking.
