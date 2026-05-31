/**
 * Tool definitions (architecture §5.4).
 *
 * Channel-agnostic tools depend on nothing channel-specific; capability-bound
 * tools declare `requires` and are registered only when the channel provides
 * every listed capability.
 */
import type { Tool } from "ai";

import type { Capabilities } from "@/channels/types";
import type { InboundMessage } from "@/core/types";
import type { TenantConfig } from "@/core/tenant";
import type { Logger } from "@/lib/logger";

export type Capability = keyof Capabilities;

export interface ToolContext {
  msg: InboundMessage;
  caps: Capabilities;
  tenant: TenantConfig | null;
  log: Logger;
}

export interface ToolDefinition {
  name: string;
  /** Empty/omitted = channel-agnostic; otherwise the channel must provide all. */
  requires?: Capability[];
  build(ctx: ToolContext): Tool;
}
