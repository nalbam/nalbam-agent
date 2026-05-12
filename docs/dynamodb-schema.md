# DynamoDB Single-Table Schema

The application stores all entities — Better Auth's `user/session/account/verification` plus the domain entities (`USER#…/PROFILE`, `PROJECT#…/META`, `USER#…/PROJECT#…`) — in one table.

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

- Primary: `PK` (HASH), `SK` (RANGE)
- GSI1: `GSI1PK` (HASH), `GSI1SK` (RANGE), Projection: ALL

### TTL

Enabled on the `ttl` attribute. Used by `session` (expiresAt) and `verification` (expiresAt). Other entities omit `ttl` and live forever.

### Billing

- Local development: doesn't matter (DynamoDB Local).
- Production: PAY_PER_REQUEST recommended for starter / low-traffic apps.

## Better Auth key mapping

| Model | PK | SK | GSI1PK | GSI1SK | TTL |
|---|---|---|---|---|---|
| `user` | `USER#<id>` | `META` | `USER:EMAIL#<email_lc>` | `USER` | — |
| `session` ¹ | `SESSION#<id>` | `META` | `SESSION:TOKEN#<token>` | `SESSION` | `expiresAt` |
| `account` | `ACCOUNT#<id>` | `META` | `ACCOUNT:PROVIDER#<providerId>#<accountId>` | `ACCOUNT` | — |
| `verification` | `VERIFICATION#<id>` | `META` | `VERIFICATION:IDENT#<identifier>` | `VERIFICATION` | `expiresAt` |

¹ When `secondaryStorage` is configured (the starter default — Valkey/Upstash), Better Auth stores sessions in the KV and **skips the `SESSION#*` rows entirely**. The mapping above only applies when `secondaryStorage` is absent or `session.storeSessionInDatabase: true` is set.

`email` is normalized to lowercase before being written to GSI1PK so case-insensitive sign-in lookups hit the same partition.

The adapter routes lookups in this order:

1. **`id eq` only** → `GetItem` against the primary key.
2. **Known indexed field eq** (email/token/identifier/providerId+accountId) → `Query` GSI1, then in-memory filter for any extra clauses.
3. **Otherwise** → `Scan` filtered by entity prefix (rare for Better Auth's call patterns).

Updates that touch indexed fields are handled via `PutItem` (replacing the row entirely) so GSI1 keys stay consistent.

## Domain entities (existing helpers)

`src/lib/dynamodb.ts` exposes `keys.user/project/userProject` for the original single-table design. These coexist with the auth rows because:

- `USER#<id>/PROFILE` (domain) and `USER#<id>/META` (auth) sit on the same partition but different sort keys.
- The auth adapter never touches rows where `SK !== "META"` so domain queries stay isolated.

## Provisioning

### Local (DynamoDB Local + docker-compose)

`dynamodb-local` (and its admin UI) live under the `test` Compose profile; the default `docker compose up -d` only starts Valkey. Bring them up explicitly and point the SDK at the local endpoint:

```bash
docker compose --profile test up -d
# Set DYNAMODB_ENDPOINT="http://localhost:8000" in .env.local
pnpm db:init
```

The init script is idempotent: it creates the table on first run, enables TTL, and reports "already exists" thereafter. DynamoDB Local doesn't implement TTL — `pnpm db:init` swallows the resulting `UnknownOperationException` and warns.

### Production (real DynamoDB)

Provision via Terraform / CDK / console. The `pnpm db:init` script also works against the real endpoint if you set the standard AWS credential chain plus `AWS_REGION` and `DYNAMODB_TABLE_NAME` (omit `DYNAMODB_ENDPOINT`).

## Cloud-man compatibility

`pnpm db:init` tags every table it creates so they show up in [cloud-man](https://github.com/opspresso/cloud-man), the in-house AWS resource manager. The tag set matches what cloud-man itself applies when creating a table:

| Tag key | Value |
|---|---|
| `ManagedBy` | `CloudManager` (the discriminator cloud-man filters on) |
| `Name` | `<DYNAMODB_TABLE_NAME>` |
| `Resource-Type` | `dynamodb:table` |
| `Created-By` | `cloud-manager` |
| `Created-At` | ISO timestamp of the script run |

Re-running `pnpm db:init` against an existing table is a no-op for tagging if `ManagedBy=CloudManager` is already present; otherwise it backfills the full set via `TagResource`. DynamoDB Local doesn't implement `TagResource`, so tagging is silently skipped when `DYNAMODB_ENDPOINT` is set.

The reverse direction works too: a table created via cloud-man's UI with `PK`/`SK` (S, S) + `GSI1` (`GSI1PK`/`GSI1SK`, projection ALL) + TTL on `ttl` matches this adapter's expectations exactly. If you create the table via cloud-man, point `DYNAMODB_TABLE_NAME` at it and skip `pnpm db:init`.

## Migration from the previous schema

If you started this template before the auth adapter was wired up, the original `keys.user/project/userProject` data is unaffected. The new auth rows live on different partitions (`USER#<authId>/META`, etc.) and use GSI1, which the original schema did not exercise.
