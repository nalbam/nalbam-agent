/**
 * Per-app Slack WebClient factory.
 *
 * Slack `WebClient` instances are cheap to construct but cache things like
 * retry config and rate-limit state per instance. Keying by `botToken` lets
 * concurrent requests for the same app share one client across the warm
 * Lambda container.
 *
 * The `@slack/web-api` import is lazy so the SDK stays out of the cold-start
 * bundle when Slack routes aren't exercised.
 */
import type { WebClient } from "@slack/web-api";

let cachedWebApi: typeof import("@slack/web-api") | undefined;
const clients = new Map<string, WebClient>();

const loadWebApi = async (): Promise<typeof import("@slack/web-api")> => {
  if (cachedWebApi) return cachedWebApi;
  cachedWebApi = await import("@slack/web-api");
  return cachedWebApi;
};

export const getSlackWebClient = async (botToken: string): Promise<WebClient> => {
  if (!botToken) throw new Error("getSlackWebClient: botToken is required");
  const cached = clients.get(botToken);
  if (cached) return cached;
  const { WebClient: WebClientCtor } = await loadWebApi();
  const client = new WebClientCtor(botToken);
  clients.set(botToken, client);
  return client;
};

export const __resetSlackClientsForTests = (): void => {
  clients.clear();
  cachedWebApi = undefined;
};
