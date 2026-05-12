/**
 * Server-side structured logger.
 *
 * Edge runtime cannot load Node-only loggers (pino), so we expose a thin
 * facade that resolves to:
 *   - JSON line writer in node runtime (CloudWatch-friendly)
 *   - console fallback in edge runtime
 *
 * Drop in `pino` later by replacing `nodeLogger` if you need transports,
 * redaction, or structured-error serialization.
 */

type Level = "debug" | "info" | "warn" | "error";

interface Logger {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

const SEVERITY: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const minLevel: Level = ((): Level => {
  const v = process.env.LOG_LEVEL;
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
})();

const hasProcessStreams =
  typeof process !== "undefined" &&
  typeof process.stdout?.write === "function" &&
  typeof process.stderr?.write === "function";

const writeLine = (level: Level, fields: Record<string, unknown>) => {
  if (SEVERITY[level] < SEVERITY[minLevel]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    ...fields,
  });
  if (hasProcessStreams) {
    // Node runtime: stdout/stderr separation is what CloudWatch / pino expect.
    if (level === "error" || level === "warn") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
    return;
  }
  // Edge runtime / browser: no `process` streams. console.* is the only sink.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

const buildLogger = (bindings: Record<string, unknown>): Logger => {
  const log = (level: Level, message: string, fields?: Record<string, unknown>) => {
    writeLine(level, { msg: message, ...bindings, ...fields });
  };
  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (extra) => buildLogger({ ...bindings, ...extra }),
  };
};

export const logger: Logger = buildLogger({});
