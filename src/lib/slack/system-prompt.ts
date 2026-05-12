/**
 * System prompt assembly.
 *
 * Five layers, joined with blank lines:
 *
 *   1. Task rules         (fixed in code)
 *   2. Slack mrkdwn rules (fixed in code)
 *   3. Attachment rules   (fixed in code)
 *   4. SYSTEM_MESSAGE     (operator policy, global only — no per-app override)
 *   5. PERSONA_MESSAGE    (tone, per-app override resolved by caller)
 *
 * The language directive is re-emphasized at the very end so the model does
 * not drift even when a persona is written in a different language.
 *
 * Note: original lambda-gurumi-bot had a 6th layer for user memory. That layer
 * is intentionally omitted (memory feature not migrated in this iteration).
 */

const TASK_RULES = `You are an assistant for Slack mention requests. Plan work, call tools when needed, and provide concise helpful answers. When multiple independent tools are required, emit their tool_calls in parallel within a single turn instead of running them one-by-one. If a tool returns ok:false, tell the user briefly what failed (one short line) and, when it makes sense, suggest an alternative — do not retry blindly with the same arguments and do not fabricate a result.
When you decide to use tools in a turn, emit ONLY the tool_calls — do not also output any text in that same turn. Streaming a "let me check..." preamble before tool_calls leaks to the user and renders as duplicate output once the real answer arrives. Save user-facing text for the turn AFTER tool results return.`;

const SLACK_RULES = `When you call generate_image or edit_image, the resulting image is already uploaded inline into the Slack thread. Do NOT repeat the image URL or permalink in your text reply — just describe or caption the image briefly. The user sees the picture attached directly; a URL line is duplicate noise.
Pick the right tool: generate_image for fresh prompts with no source image; edit_image whenever the user wants to transform, restyle, or modify an existing image (theirs or one earlier in the thread). For edits to a thread image, call fetch_thread_history first to obtain url_private_download, then pass it to edit_image(prompt=..., urls=[...]).
Slack renders mrkdwn, not GitHub markdown. Use *bold* with single asterisks, _italic_, \`code\`, and <https://url|label> for links. Do NOT use **bold** or [label](url) — those appear as raw text in Slack.`;

const ATTACHMENT_RULES = `If the user asks about an image or document in the current thread, call read_attached_images / read_attached_document first — they target files attached to the triggering message. If the result is an empty list, the attachment lives on an earlier message: call fetch_thread_history, take the url_private_download values from that message's files, then call read_attached_images(urls=[...]) or read_attached_document(urls=[...]) with them. When the user's reference to a file is ambiguous (e.g. "이 사진", "아까 그 파일"), call read_attached_images (or read_attached_document) speculatively first — it returns an empty list cheaply when no file is attached to the current message, and that signals you to fall back to fetch_thread_history. Never guess or fabricate file URLs.`;

export interface BuildSystemPromptInput {
  /** Operator policy. Global only — no per-app override (security field). */
  systemMessage?: string;
  /** Tone / persona. Per-app override is already resolved by the caller. */
  personaMessage?: string;
  /** "ko" | "en". Drives the trailing language directive. */
  responseLanguage: "ko" | "en";
}

export const buildSystemPrompt = ({
  systemMessage,
  personaMessage,
  responseLanguage,
}: BuildSystemPromptInput): string => {
  const sections: string[] = [TASK_RULES, SLACK_RULES, ATTACHMENT_RULES];
  if (systemMessage) {
    sections.push(`Additional policy:\n${systemMessage}`);
  }
  if (personaMessage) {
    sections.push(`Response style:\n${personaMessage}`);
  }
  sections.push(`Respond in language: ${responseLanguage}.`);
  return sections.join("\n\n");
};
