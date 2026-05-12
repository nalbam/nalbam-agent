/**
 * Multi-tenant Slack credential loader backed by AWS SSM Parameter Store.
 *
 * Per-app secrets live as SecureString parameters at:
 *
 *   {SLACK_SSM_PREFIX}/{api_app_id}/signing_secret
 *   {SLACK_SSM_PREFIX}/{api_app_id}/bot_token
 *
 * Both must be present for the app to be considered configured. A missing or
 * partially configured app returns `null` — callers translate that into a
 * structured log + HTTP 200 so Slack doesn't keep retrying an unrecoverable
 * misconfiguration. Negative results are cached for the same TTL so a
 * misconfigured app's burst can't storm SSM.
 *
 * The SSM client is imported lazily so it stays out of the cold-start bundle
 * when Slack isn't exercised (same pattern as `src/lib/email.ts` for SES).
 */
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export interface SlackAppCredentials {
  signingSecret: string;
  botToken: string;
}

type CacheEntry = { expiresAt: number; value: SlackAppCredentials | null };

interface SsmGetParametersClient {
  getParameters: (names: string[]) => Promise<Record<string, string>>;
  putParameter: (name: string, value: string) => Promise<void>;
  deleteParameter: (name: string) => Promise<void>;
}

let cachedClient: SsmGetParametersClient | undefined;
const cache = new Map<string, CacheEntry>();

const buildClient = async (): Promise<SsmGetParametersClient> => {
  const { SSMClient, GetParametersCommand, PutParameterCommand, DeleteParameterCommand } =
    await import("@aws-sdk/client-ssm");
  const client = new SSMClient({ region: getServerEnv().AWS_REGION });
  return {
    getParameters: async (names) => {
      const res = await client.send(
        new GetParametersCommand({ Names: names, WithDecryption: true }),
      );
      const out: Record<string, string> = {};
      for (const p of res.Parameters ?? []) {
        if (p.Name && typeof p.Value === "string") {
          out[p.Name] = p.Value;
        }
      }
      return out;
    },
    putParameter: async (name, value) => {
      await client.send(
        new PutParameterCommand({
          Name: name,
          Value: value,
          Type: "SecureString",
          Overwrite: true,
        }),
      );
    },
    deleteParameter: async (name) => {
      try {
        await client.send(new DeleteParameterCommand({ Name: name }));
      } catch (err) {
        // ParameterNotFound: nothing to delete; treat as success.
        const code = (err as { name?: string }).name;
        if (code === "ParameterNotFound") return;
        throw err;
      }
    },
  };
};

const getClient = async (): Promise<SsmGetParametersClient> => {
  if (cachedClient) return cachedClient;
  cachedClient = await buildClient();
  return cachedClient;
};

const now = (): number => Math.floor(Date.now() / 1000);

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

export interface CredentialsStoreDeps {
  /** Override for tests. */
  client?: SsmGetParametersClient;
  /** Override for tests; default reads SLACK_SSM_PREFIX. */
  prefix?: string;
  /** Override for tests; default reads SLACK_SSM_CACHE_TTL_SECONDS. */
  ttlSeconds?: number;
  /** Override for tests; default uses real wall clock. */
  nowSeconds?: () => number;
}

const resolveDeps = async (deps: CredentialsStoreDeps = {}) => {
  const env = getServerEnv();
  return {
    client: deps.client ?? (await getClient()),
    prefix: trimSlash(deps.prefix ?? env.SLACK_SSM_PREFIX),
    ttlSeconds: deps.ttlSeconds ?? env.SLACK_SSM_CACHE_TTL_SECONDS,
    now: deps.nowSeconds ?? now,
  };
};

/**
 * Return Slack credentials for `apiAppId`, or `null` when not configured.
 *
 * Transient errors (network, IAM, SSM outage) return `null` WITHOUT writing
 * a negative cache entry — a follow-up request should retry. Only confirmed
 * missing parameters are negative-cached.
 */
export const getSlackCredentials = async (
  apiAppId: string,
  deps: CredentialsStoreDeps = {},
): Promise<SlackAppCredentials | null> => {
  if (!apiAppId) return null;
  const { client, prefix, ttlSeconds, now: nowFn } = await resolveDeps(deps);
  const cached = cache.get(apiAppId);
  if (cached && cached.expiresAt > nowFn()) {
    return cached.value;
  }

  const signingName = `${prefix}/${apiAppId}/signing_secret`;
  const tokenName = `${prefix}/${apiAppId}/bot_token`;

  let params: Record<string, string>;
  try {
    params = await client.getParameters([signingName, tokenName]);
  } catch (err) {
    logger.warn("slack.credentials.ssm_error", {
      apiAppId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const signingSecret = params[signingName];
  const botToken = params[tokenName];
  if (!signingSecret || !botToken) {
    cache.set(apiAppId, { expiresAt: nowFn() + ttlSeconds, value: null });
    return null;
  }
  const value: SlackAppCredentials = { signingSecret, botToken };
  cache.set(apiAppId, { expiresAt: nowFn() + ttlSeconds, value });
  return value;
};

export const invalidateSlackCredentials = (apiAppId: string): void => {
  cache.delete(apiAppId);
};

/**
 * Write Slack credentials to SSM as SecureString. Used by the operator UI
 * and the bootstrap CLI. Both parameters are written before the cache is
 * invalidated so a follow-up event sees the new values atomically.
 */
export const putSlackCredentials = async (
  apiAppId: string,
  creds: SlackAppCredentials,
  deps: CredentialsStoreDeps = {},
): Promise<void> => {
  if (!apiAppId) throw new Error("apiAppId is required");
  const { client, prefix } = await resolveDeps(deps);
  const signingName = `${prefix}/${apiAppId}/signing_secret`;
  const tokenName = `${prefix}/${apiAppId}/bot_token`;
  await Promise.all([
    client.putParameter(signingName, creds.signingSecret),
    client.putParameter(tokenName, creds.botToken),
  ]);
  invalidateSlackCredentials(apiAppId);
};

/**
 * Remove Slack credentials from SSM. Missing parameters are silently
 * treated as success so retries are idempotent.
 */
export const deleteSlackCredentials = async (
  apiAppId: string,
  deps: CredentialsStoreDeps = {},
): Promise<void> => {
  if (!apiAppId) throw new Error("apiAppId is required");
  const { client, prefix } = await resolveDeps(deps);
  const signingName = `${prefix}/${apiAppId}/signing_secret`;
  const tokenName = `${prefix}/${apiAppId}/bot_token`;
  await Promise.all([client.deleteParameter(signingName), client.deleteParameter(tokenName)]);
  invalidateSlackCredentials(apiAppId);
};

/** Test-only helper to reset module-level state between tests. */
export const __resetSlackCredentialsForTests = (): void => {
  cache.clear();
  cachedClient = undefined;
};
