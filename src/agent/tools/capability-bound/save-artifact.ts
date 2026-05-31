import { tool } from "ai";
import { z } from "zod";

import { defineTool } from "@/agent/tools/registry";

export const saveTextArtifactTool = defineTool({
  name: "save_text_artifact",
  requires: ["uploadMedia"],
  build: (ctx) =>
    tool({
      description:
        "Save a text artifact such as a report, todo list, generated document, or tool output and return a downloadable URL.",
      inputSchema: z.object({
        name: z.string().min(1).max(160).describe("File name, e.g. report.md or todo.txt."),
        content: z.string().min(1).describe("Text content to save."),
        mime: z.string().optional().describe("MIME type. Defaults to text/plain."),
      }),
      execute: async ({ name, content, mime }) => {
        const data = new TextEncoder().encode(content);
        const result = await ctx.caps.uploadMedia?.({
          name,
          mime: mime?.trim() || "text/plain",
          data,
        });
        if (!result) {
          throw new Error("uploadMedia capability is not available.");
        }
        return result;
      },
    }),
});
