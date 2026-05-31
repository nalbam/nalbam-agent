/**
 * Tool registry (architecture §5.4).
 *
 * Tools self-register via `defineTool`. `buildToolset` returns only the tools
 * whose required capabilities are all provided by the channel — so a channel
 * without `uploadMedia` never sees `generate_image`, etc.
 */
import type { Tool } from "ai";

import type { ToolContext, ToolDefinition } from "@/agent/tools/types";

const tools = new Map<string, ToolDefinition>();

export const defineTool = (tool: ToolDefinition): ToolDefinition => {
  tools.set(tool.name, tool);
  return tool;
};

export const listTools = (): ToolDefinition[] => [...tools.values()];

export const buildToolset = (ctx: ToolContext): Record<string, Tool> => {
  const out: Record<string, Tool> = {};
  for (const tool of tools.values()) {
    const ok = (tool.requires ?? []).every((cap) => typeof ctx.caps[cap] === "function");
    if (ok) out[tool.name] = tool.build(ctx);
  }
  return out;
};
