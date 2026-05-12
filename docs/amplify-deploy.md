# Amplify Deployment Guide

This template is built to run on **AWS Amplify Hosting** with SSR (Lambda compute). The Better Auth + DynamoDB + Upstash combination keeps every request VPC-free, so cold starts stay short and there is no NAT Gateway cost.

> **Next.js 16 + Amplify compatibility note**
>
> The Amplify Hosting documentation still lists Next.js 12–15 as the officially supported matrix, but a Hosting-side fix for the Turbopack `.next/node_modules` symlink issue rolled out **2026-02-11**, after which Next.js 16 (App Router) deploys correctly. References:
>
> - [aws-amplify/amplify-js#14600 (NextJS 16 Support)](https://github.com/aws-amplify/amplify-js/issues/14600) — closed 2026-02-16
> - [aws-amplify/amplify-hosting#4074 (16.1 EEXIST symlink fix)](https://github.com/aws-amplify/amplify-hosting/issues/4074) — closed 2026-02-17
>
> If you adopt **Pages Router**, set `bundlePagesRouterDependencies: true` in `next.config.ts` to stay under Amplify's 230 MB build artifact limit. App Router (this template's default) is unaffected.

## 1. Prerequisites

- Amplify Hosting app connected to this repository
- A DynamoDB table provisioned in your AWS account (production replacement for `app-main`). See [`docs/dynamodb-schema.md`](./dynamodb-schema.md) for the schema.
- Upstash Redis database (REST URL + token) for `secondaryStorage` (sessions / rate limit). [https://upstash.com](https://upstash.com)

## 2. IAM policy for the SSR compute role

In the Amplify console, go to *App settings → IAM roles → SSR Compute role* and attach a policy that grants DynamoDB access to the table and its GSI:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoDBSingleTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem",
        "dynamodb:DescribeTable",
        "dynamodb:TransactWriteItems",
        "dynamodb:TransactGetItems"
      ],
      "Resource": [
        "arn:aws:dynamodb:ap-northeast-2:<ACCOUNT_ID>:table/app-main",
        "arn:aws:dynamodb:ap-northeast-2:<ACCOUNT_ID>:table/app-main/index/*"
      ]
    }
  ]
}
```

Replace `<ACCOUNT_ID>` and the region/table name with your values.

> Do **not** ship `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` as Amplify environment variables in production. The compute role's IAM credentials are picked up automatically by the AWS SDK's default credential chain.

### Tightening the policy: dropping `Scan`

The adapter only falls back to `Scan` when a query touches a non-indexed field — for the default Better Auth surface (`user/session/account/verification`) this should never happen. Once you've verified your deployment doesn't trigger the fallback (watch for `dynamodb-adapter.scan-fallback` warnings in CloudWatch), remove `dynamodb:Scan` from the policy so an accidental future code path fails loudly with `AccessDeniedException` instead of running silently.

If a plugin you add later does need scans, prefer to introduce a new GSI keyed on the queried field instead of widening the IAM policy.

If you set `AWS_SES_FROM` to enable transactional email, also attach an SES statement to the same role:

```json
{
  "Sid": "SESEmailSender",
  "Effect": "Allow",
  "Action": ["ses:SendEmail", "ses:SendRawEmail"],
  "Resource": "arn:aws:ses:<REGION>:<ACCOUNT_ID>:identity/<verified-sender-domain-or-address>"
}
```

## 3. Environment variables

Set these in Amplify Hosting → *App settings → Environment variables*:

| Variable | Required | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | yes | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | yes | e.g. `https://app.example.com` |
| `TRUSTED_ORIGINS` | optional | Comma-separated additional origins |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | yes | Same as above (client-side) |
| `NEXT_PUBLIC_APP_NAME` | optional | Defaults to `Next.js Tailwind Starter` |
| `AWS_REGION` | yes | Region of your DynamoDB table |
| `DYNAMODB_TABLE_NAME` | yes | e.g. `app-main` |
| `UPSTASH_REDIS_REST_URL` | yes (prod) | From Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | yes (prod) | From Upstash console |
| `DYNAMODB_ENDPOINT` | **no** | Leave empty in prod. Only used to point at DynamoDB Local. |
| `REDIS_URL` | **no** | Leave empty in prod (use Upstash). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | **no** | Use the compute role instead. |
| `AWS_SES_FROM` | optional | Verified SES sender address. When set, `src/lib/email.ts` routes Better Auth verification / reset / invitation emails through SES via the compute role. |
| `AUTH_EMAIL_ENABLED` / `NEXT_PUBLIC_AUTH_EMAIL_ENABLED` | optional | Defaults to enabled. Set to `false` to disable email/password sign-in. |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | optional | OAuth client from <https://console.cloud.google.com/apis/credentials>. Authorized redirect URI must include `${BETTER_AUTH_URL}/api/auth/callback/google`. |
| `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED` | optional | Set to `true` to render the "Continue with Google" button. Set together with the two `AUTH_GOOGLE_*` secrets. |
| `LOG_LEVEL` | optional | One of `debug` / `info` / `warn` / `error`. Defaults to `info` in production. |

The repo's [`amplify.yml`](../amplify.yml) handles install + build; no further build configuration is required.

## 4. Provision DynamoDB

Use the schema in [`docs/dynamodb-schema.md`](./dynamodb-schema.md). Minimum:

- Partition key `PK` (S), Sort key `SK` (S)
- GSI `GSI1`: partition `GSI1PK` (S), sort `GSI1SK` (S), projection `ALL`
- TTL attribute: `ttl`
- Billing mode: PAY_PER_REQUEST (recommended for unpredictable starter traffic)

## 5. Connect & deploy

1. Push to your default branch.
2. Amplify auto-builds via `amplify.yml`.
3. After the first deploy, hit `https://<your-domain>/api/health` to confirm the SSR Lambda is up.
4. Create a test account via `/signup`, then verify a `USER#…` row exists in DynamoDB and a `better-auth.session_token` cookie was issued.

## 6. Rolling out additional regions

If you serve users globally, deploy a Read Replica via DynamoDB Global Tables and add an `AWS_REGION` override per Amplify branch. Better Auth and the adapter are stateless — every region's SSR Lambda will read/write to the local replica.

## 7. Troubleshooting

- **`getServerEnv()` throws on first request** — `BETTER_AUTH_SECRET` not set.
- **`AccessDeniedException` on DynamoDB** — IAM policy missing the `index/*` resource for GSI1.
- **Sessions are not persisted across requests** — Upstash variables missing (Better Auth fell back to no `secondaryStorage`).
- **Cookies not set on production** — `BETTER_AUTH_URL` mismatched with the site origin or `TRUSTED_ORIGINS` not configured for additional domains.
