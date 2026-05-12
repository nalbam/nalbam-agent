# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this template or in the auth/data flows it ships, please **do not open a public GitHub issue**.

Instead, email the maintainer at the address listed on the GitHub profile of [@nalbam](https://github.com/nalbam) with:

- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Affected version / commit

You should expect an initial acknowledgment within **3 business days** and a remediation plan within **14 days** for confirmed issues.

## Scope

In scope:
- The Better Auth configuration in this repository (`src/lib/auth.ts`, `src/lib/auth/`).
- The DynamoDB single-table adapter (`src/lib/auth/dynamodb-adapter.ts`).
- Server-only handling of secrets (`src/lib/env.ts`).
- The default API surface under `src/app/api/**` (including the CSP report receiver at `/api/csp-report`).
- The security headers + CSP defined in `next.config.ts`.
- The open-redirect guard in `src/lib/safe-redirect.ts` (consumed by `/login` and `/signup` for `?redirect=`).

Out of scope (please report upstream):
- [Better Auth](https://github.com/better-auth/better-auth) core vulnerabilities.
- AWS SDK / DynamoDB Local.
- Next.js / React.

## Hardening expectations for forks

If you fork this template:

1. **Rotate** `BETTER_AUTH_SECRET` and any AWS credentials before deploying — never reuse the example values.
2. Set `TRUSTED_ORIGINS` for every production origin you serve from.
3. Restrict the IAM role attached to your Amplify SSR compute role to the minimum DynamoDB actions documented in [`docs/amplify-deploy.md`](./docs/amplify-deploy.md).
4. Enable encryption at rest on your DynamoDB table (default for new tables, but verify on imports).
5. Keep dependencies current — `pnpm audit` is wired into CI; treat any high/critical finding as blocking.
