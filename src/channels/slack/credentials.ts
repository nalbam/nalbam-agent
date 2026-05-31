import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { getServerEnv } from "@/lib/env";

export interface SlackAppCredentials {
  signingSecret: string;
  botToken?: string;
}

export interface SlackCredentialProvider {
  getAppCredentials(apiAppId: string): Promise<SlackAppCredentials | null>;
}

interface CacheEntry {
  credentials: SlackAppCredentials | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let client: SSMClient | undefined;
let overrideProvider: SlackCredentialProvider | undefined;

const getClient = (): SSMClient => {
  if (client) return client;
  const env = getServerEnv();
  client = new SSMClient({
    region: env.AWS_REGION,
    credentials:
      env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
  return client;
};

const readSecureString = async (name: string): Promise<string | undefined> => {
  const result = await getClient().send(
    new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    }),
  );
  return result.Parameter?.Value;
};

export const ssmSlackCredentialProvider: SlackCredentialProvider = {
  async getAppCredentials(apiAppId) {
    const env = getServerEnv();
    const cached = cache.get(apiAppId);
    if (cached && cached.expiresAt > Date.now()) return cached.credentials;

    const base = `${env.SLACK_SSM_PREFIX}/${apiAppId}`;
    const signingSecret = await readSecureString(`${base}/signing_secret`);
    if (!signingSecret) {
      cache.set(apiAppId, {
        credentials: null,
        expiresAt: Date.now() + env.SLACK_SSM_CACHE_TTL_SECONDS * 1000,
      });
      return null;
    }

    let botToken: string | undefined;
    try {
      botToken = await readSecureString(`${base}/bot_token`);
    } catch {
      botToken = undefined;
    }

    const credentials = { signingSecret, botToken };
    cache.set(apiAppId, {
      credentials,
      expiresAt: Date.now() + env.SLACK_SSM_CACHE_TTL_SECONDS * 1000,
    });
    return credentials;
  },
};

export const getSlackCredentialProvider = (): SlackCredentialProvider =>
  overrideProvider ?? ssmSlackCredentialProvider;

export const __setSlackCredentialProviderForTests = (
  provider: SlackCredentialProvider | undefined,
): void => {
  overrideProvider = provider;
  cache.clear();
};
