/**
 * System prompt assembly (architecture §5.3).
 *
 * Layers: task rules + channel rendering rules (adapter-injected) + operator
 * policy (global) + tenant persona + language directive. The channel layer is
 * what makes the same core render mrkdwn on Slack, markdown on web, etc.
 */
export interface BuildSystemPromptInput {
  /** Channel markup rules from `ChannelAdapter.renderingRules()`. */
  rendering: string;
  /** Operator policy — global only (security field). */
  systemMessage?: string;
  /** Tenant persona override; empty/undefined = none. */
  persona?: string;
  language: "ko" | "en";
}

const TASK_RULES =
  "You are an assistant. Plan work, call tools when needed, and give concise, helpful answers. " +
  "When multiple independent tools are required, emit their tool calls in parallel. " +
  "If a tool returns an error, briefly tell the user what failed and suggest an alternative.";

export const buildSystemPrompt = ({
  rendering,
  systemMessage,
  persona,
  language,
}: BuildSystemPromptInput): string => {
  const sections: string[] = [TASK_RULES];
  if (rendering) sections.push(rendering);
  if (systemMessage) sections.push(`Additional policy:\n${systemMessage}`);
  if (persona) sections.push(`Response style:\n${persona}`);
  sections.push(`Respond in language: ${language}.`);
  return sections.join("\n\n");
};
