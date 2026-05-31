/** Request-scoped logger binding (architecture §5.8). */
import { logger, type Logger } from "@/lib/logger";

export const requestLogger = (fields: Record<string, unknown>): Logger => logger.child(fields);
