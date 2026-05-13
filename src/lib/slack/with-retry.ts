/**
 * Slack `ratelimited` retry helper.
 *
 * Slack returns `data: { error: "ratelimited" }` plus a `Retry-After` header
 * when an endpoint is over budget. We retry with exponential backoff, up to
 * `attempts` total tries. Non-rate-limit errors propagate immediately.
 *
 * Used by Slack tools (`conversations.replies`) and the reactions handler
 * (`conversations.history` / `conversations.replies`).
 */
import { logger as defaultLogger, type Logger } from "@/lib/logger";

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface WithSlackRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  logger?: Logger;
}

export const withSlackRetry = async <T>(
  fn: () => Promise<T>,
  label: string,
  options: WithSlackRetryOptions = {},
): Promise<T> => {
  const attempts = options.attempts ?? 3;
  const log = options.logger ?? defaultLogger;
  let delayMs = options.baseDelayMs ?? 1000;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const data = (err as { data?: { error?: string } }).data;
      if (data?.error === "ratelimited" && i < attempts - 1) {
        log.warn("slack.ratelimited", { label, delayMs, attempt: i + 1 });
        await sleep(delayMs);
        delayMs *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label}: exhausted retries`);
};
