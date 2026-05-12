/**
 * Current-time tool.
 *
 * Returns wall-clock time in a caller-specified IANA timezone, defaulting
 * to the server's `DEFAULT_TIMEZONE` env. Used for "today" / "this week" /
 * weekday questions where the model would otherwise hallucinate a date.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";

const inputSchema = z.object({
  timezone: z
    .string()
    .optional()
    .describe(
      "Optional IANA timezone (e.g. 'Asia/Seoul', 'UTC', 'America/New_York'). Omit to use the server default.",
    ),
});

interface CurrentTimeResult {
  iso: string;
  timezone: string;
  weekday: string;
  unix: number;
}

const tryFormat = (tz: string, now: Date): CurrentTimeResult => {
  // Throws RangeError on invalid IANA name — caller maps to user error.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "long",
  }).formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") === "24" ? "00" : get("hour"); // some locales emit 24
  const minute = get("minute");
  const second = get("second");
  const weekday = get("weekday");
  // Note: this `iso` is the local wall-clock time in `tz` rendered like ISO 8601
  // without an offset suffix — sufficient for the agent's "what day/time is it?"
  // use case. The `unix` field is the true authoritative UTC instant.
  return {
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
    timezone: tz,
    weekday,
    unix: Math.floor(now.getTime() / 1000),
  };
};

export const getCurrentTimeTool = (): Tool =>
  tool({
    description:
      "Return the current wall-clock time. Uses the server default timezone (DEFAULT_TIMEZONE env) unless 'timezone' is provided. Useful for 'today', 'now', 'this week', or weekday questions.",
    inputSchema,
    execute: async ({ timezone }) => {
      const env = getServerEnv();
      const tz = timezone?.trim() || env.DEFAULT_TIMEZONE;
      try {
        return tryFormat(tz, new Date());
      } catch (err) {
        throw new Error(
          `unknown timezone: ${tz} (${err instanceof Error ? err.message : "invalid IANA name"})`,
        );
      }
    },
  });
