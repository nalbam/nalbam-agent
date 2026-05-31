/**
 * Long-running worker for connection-mode channels (architecture §5.1).
 *
 * Drives the same `runConversation` core as the webhook route, but for
 * channels that hold a persistent connection (Slack Socket Mode, Telegram
 * polling). Skeleton stub — activated in a later step.
 */
import { NotImplementedError } from "@/core/errors";

export const startSocketWorker = async (): Promise<void> => {
  throw new NotImplementedError("worker.socket");
};
