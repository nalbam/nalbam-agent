/**
 * Channel adapter registry (architecture §5.1 plugin protocol).
 *
 * Adapters self-register via `defineChannel`. The core only knows the
 * registry — it never imports a concrete channel. Bundled channels are
 * triggered by the side-effect import in `@/channels`.
 */
import type { ChannelAdapter } from "@/channels/types";

const channels = new Map<string, ChannelAdapter>();

export const defineChannel = (adapter: ChannelAdapter): ChannelAdapter => {
  channels.set(adapter.id, adapter);
  return adapter;
};

export const getChannel = (id: string): ChannelAdapter | undefined => channels.get(id);

export const listChannels = (): ChannelAdapter[] => [...channels.values()];
