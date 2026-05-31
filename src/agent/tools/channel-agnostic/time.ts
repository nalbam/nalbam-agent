/** Channel-agnostic tool: current time in an IANA timezone. */
import { tool } from "ai";
import { z } from "zod";

import { defineTool } from "@/agent/tools/registry";

export const getCurrentTimeTool = defineTool({
  name: "get_current_time",
  build: () =>
    tool({
      description:
        "Return the current wall-clock time. Uses Asia/Seoul unless a timezone is given.",
      inputSchema: z.object({
        timezone: z.string().optional().describe("IANA timezone, e.g. 'Asia/Seoul'."),
      }),
      execute: async ({ timezone }) => {
        const tz = timezone?.trim() || "Asia/Seoul";
        const now = new Date();
        const formatted = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          weekday: "long",
        }).format(now);
        return { formatted, timezone: tz, unix: Math.floor(now.getTime() / 1000) };
      },
    }),
});
