# DynamoDB Single-Table Schema

One DynamoDB table stores everything: Better Auth (`user / session / account / verification`) and the Slack agent's per-tenant rows (`SLACK_APP / SLACK_DEDUP / SLACK_DONE / SLACK_THREAD`). The legacy domain-entity helpers (`USER#…/PROFILE`, `PROJECT#…/META`, `USER#…/PROJECT#…`) from the starter scaffolding remain in `src/lib/dynamodb.ts` and continue to coexist without collision — they use different sort keys from the auth rows.

## Table

| Attribute | Type | Role |
|---|---|---|
| `PK` | String | Partition key |
| `SK` | String | Sort key |
| `GSI1PK` | String | GSI1 partition key (sparse) |
| `GSI1SK` | String | GSI1 sort key (sparse) |
| `ttl` | Number | Epoch seconds. DynamoDB auto-deletes when reached. |
| `entity` | String | Discriminator for the row's type |

### Indexes

- Primary: `PK` (HASH), `SK` (RANGE).
- GSI1: `GSI1PK` (HASH), `GSI1SK` (RANGE), Projection: `ALL`.

### TTL

Enabled on the `ttl` attribute. Auto-deletes:

- Better Auth `session` and `verification` rows (`expiresAt`).
- Slack `SLACK_DEDUP#…` rows (300 s).
- Slack `SLACK_DONE#…` rows (3600 s).
- Slack `SLACK_THREAD#…` rows (3600 s).

Other entities (Better Auth `user`/`account`, Slack `SLACK_APP`) omit `ttl` and live forever.

### Billing

- Local development: doesn't matter (DynamoDB Local).
- Production: `PAY_PER_REQUEST` recommended for low-to-medium-traffic deployments. `pnpm db:init` defaults to on-demand.

## Slack agent key map

| Use | PK | SK | GSI1PK | GSI1SK | TTL |
|---|---|---|---|---|---|
| App metadata + per-app ACL/persona | `SLACK_APP#<api_app_id>` | `META` | `SLACK_APP:TEAM#<team_id>` | `SLACK_APP` | — |
| In-flight dedup reservation | `SLACK_DEDUP#<api_app_id>#<event_key>` | `META` | — | — | 300 s |
| Completion marker (idempotency) | `SLACK_DONE#<api_app_id>#<event_key>` | `META` | — | — | 3600 s |
| Thread conversation history | `SLACK_THREAD#<api_app_id>#<thread_ts>` | `META` | — | — | 3600 s |

The `SLACK_APP` row carries optional attributes set by the operator UI / CLI:

- `displayName: string` — operator-friendly label.
- `teamId / teamName / teamDomain / botUserId / botUserName` — populated from `auth.test` on registration.
- `allowedChannelIds: string[]` — channel allowlist override (empty list = explicit allow-all).
- `allowedUserIds: string[]` — user allowlist override (empty list = explicit allow-all).
- `personaMessage: string` — persona override (empty string = explicit no-persona).
- `firstSeenAt / lastSeenAt: number` — epoch seconds, auto-maintained.

`event_key` for dedup is `client_msg_id` when Slack provides one, otherwise `${channel}:${ts}`. For reactions it's `reaction:${event_ts}:${reactor}`.

## Better Auth key map

| Model | PK | SK | GSI1PK | GSI1SK | TTL |
|---|---|---|---|---|---|
| `user` | `USER#<id>` | `META` | `USER:EMAIL#<email_lc>` | `USER` | — |
| `session` ¹ | `SESSION#<id>` | `META` | `SESSION:TOKEN#<token>` | `SESSION` | `expiresAt` |
| `account` | `ACCOUNT#<id>` | `META` | `ACCOUNT:PROVIDER#<providerId>#<accountId>` | `ACCOUNT` | — |
| `verification` | `VERIFICATION#<id>` | `META` | `VERIFICATION:IDENT#<identifier>` | `VERIFICATION` | `expiresAt` |

¹ When `secondaryStorage` is configured (default: Valkey/Upstash), Better Auth stores sessions in the KV and **skips the `SESSION#*` rows entirely**.

`email` is normalized to lowercase before being written to `GSI1PK` so case-insensitive sign-in lookups hit the same partition.

The auth adapter routes lookups in this order:

1. **`id eq` only** → `GetItem` against the primary key.
2. **Known indexed field eq** (email/token/identifier/providerId+accountId) → `Query GSI1`, then in-memory filter.
3. **Otherwise** → `Scan` filtered by entity prefix (rare for Better Auth's call patterns).

Updates that touch indexed fields are handled via `PutItem` (replacing the row entirely) so GSI1 keys stay consistent.

## Coexistence of PK prefixes

Multiple feature areas write to the same table, separated by PK prefix:

| Prefix | Owner |
|---|---|
| `USER#` | Better Auth (SK=`META`) and starter scaffolding (SK=`PROFILE`) |
| `SESSION#`, `ACCOUNT#`, `VERIFICATION#` | Better Auth |
| `PROJECT#`, `USER#…/PROJECT#…` | Starter scaffolding (unused by the Slack agent, but the helpers remain) |
| `SLACK_APP#`, `SLACK_DEDUP#`, `SLACK_DONE#`, `SLACK_THREAD#` | Slack agent |

The auth adapter never touches rows where `SK !== "META"`, so domain queries stay isolated. Slack rows are scoped by their `SLACK_*` prefix so a poorly-formed query can't accidentally match auth or domain rows.

## Provisioning

### Local (DynamoDB Local + docker-compose)

```bash
docker compose --profile test up -d
# Set DYNAMODB_ENDPOINT="http://localhost:8000" in .env.local
pnpm db:init
```

The init script is idempotent: it creates the table on first run, enables TTL, and reports "already exists" thereafter. DynamoDB Local doesn't implement TTL — `pnpm db:init` swallows the resulting `UnknownOperationException` and warns.

### Production (real DynamoDB)

Provision via `pnpm db:init` against the standard AWS credential chain plus `AWS_REGION` and `DYNAMODB_TABLE_NAME` (omit `DYNAMODB_ENDPOINT`). Or provision via Terraform / CDK / console — the schema is summarized at the top of this doc.

## Cloud-man compatibility

`pnpm db:init` tags every table it creates so they show up in [cloud-man](https://github.com/opspresso/cloud-man), the in-house AWS resource manager. The tag set matches what cloud-man itself applies when creating a table:

| Tag key | Value |
|---|---|
| `ManagedBy` | `CloudManager` |
| `Name` | `<DYNAMODB_TABLE_NAME>` |
| `Resource-Type` | `dynamodb:table` |
| `Created-By` | `cloud-manager` |
| `Created-At` | ISO timestamp of the script run |

Re-running `pnpm db:init` against an existing table is a no-op for tagging if `ManagedBy=CloudManager` is already present; otherwise it backfills the full set via `TagResource`. DynamoDB Local doesn't implement `TagResource`, so tagging is silently skipped when `DYNAMODB_ENDPOINT` is set.
