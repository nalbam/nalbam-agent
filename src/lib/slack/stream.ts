/**
 * Slack streaming output.
 *
 * Streams LLM deltas into a single Slack message via chat.postMessage +
 * repeated chat.update. The placeholder message is posted LAZILY — only
 * after the first content delta arrives — so a fast tool-only turn that
 * produces no text never leaves an empty `:robot_face:` line in the thread.
 *
 * Update throttling: chat.update is Tier 3 (≈50/min). Default min interval
 * of 600 ms keeps a typical streaming session under that rate.
 *
 * Overflow handling: when the rolling buffer approaches `maxLen`, the
 * current message is finalized with the accumulated content (closing any
 * unbalanced code fence) and a fresh placeholder is opened for the
 * remainder. On `msg_too_long` from chat.update — Slack's mrkdwn coercion
 * caps a single block at ~3000 chars regardless of the documented 4000 —
 * we spill via chat.postMessage and reset for the next delta.
 *
 * On `stop(finalText)`, the accumulated content is split via the formatter
 * and the first chunk lands in the current ts; remaining chunks post as
 * fresh thread messages.
 */
import type { WebClient } from "@slack/web-api";

import { logger } from "@/lib/logger";
import { sanitizeError, splitMessage } from "@/lib/slack/formatter";

const CODE_FENCE = "```";
const PARAGRAPH_SEP = "\n\n";

const isSlackError = (err: unknown, code: string): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const data = (err as { data?: { error?: string } }).data;
  return data?.error === code;
};

export interface StreamingMessageOptions {
  client: WebClient;
  channel: string;
  threadTs: string;
  /** Slack emoji rendered while content is being streamed. */
  placeholder?: string;
  /** Minimum ms between chat.update calls. */
  minIntervalMs?: number;
  /** Soft per-message cap; rolls over when exceeded. */
  maxLen?: number;
  /** Override for tests; default uses real wall clock. */
  nowMs?: () => number;
}

export class StreamingMessage {
  private readonly client: WebClient;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly placeholder: string;
  private readonly minIntervalMs: number;
  private readonly maxLen: number;
  private readonly now: () => number;

  /** Concatenation of every prefix already sealed into earlier ts'es via roll. */
  private finalizedText = "";
  private buffer = "";
  private lastFlush = 0;
  private stopped = false;
  private ts: string | undefined;

  constructor(opts: StreamingMessageOptions) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.placeholder = opts.placeholder ?? ":robot_face:";
    this.minIntervalMs = opts.minIntervalMs ?? 600;
    this.maxLen = opts.maxLen ?? 3000;
    this.now = opts.nowMs ?? Date.now;
  }

  /** True once we've opened a placeholder. */
  hasStarted(): boolean {
    return this.ts !== undefined;
  }

  /**
   * Accumulate a delta. Opens the placeholder lazily on the first non-empty
   * delta, then flushes on the throttle interval.
   */
  async append(delta: string): Promise<void> {
    if (!delta || this.stopped) return;
    if (this.ts === undefined) {
      await this.openPlaceholder();
      if (this.ts === undefined) return; // open failed; drop silently
    }
    this.buffer += delta;
    const t = this.now();
    if (t - this.lastFlush < this.minIntervalMs) return;
    this.lastFlush = t;
    await this.flush();
  }

  /**
   * Finalize with `finalText`. Splits into Slack-safe chunks; first lands in
   * the placeholder, the rest as follow-up thread messages.
   */
  async stop(finalText: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    let text = finalText;
    // If a roll-finalize already sealed a prefix into an earlier ts, strip
    // it so the latest ts doesn't overwrite itself with overlapping content.
    if (this.finalizedText && text.startsWith(this.finalizedText)) {
      text = text.slice(this.finalizedText.length);
      const fences = countOccurrences(this.finalizedText, CODE_FENCE);
      if (fences % 2 === 1) {
        text = `${CODE_FENCE}\n${text}`;
      }
    }

    const chunks = splitMessage(text, this.maxLen);
    const first = chunks[0] ?? "";
    if (this.ts !== undefined) {
      try {
        await this.client.chat.update({ channel: this.channel, ts: this.ts, text: first });
      } catch (err) {
        logger.warn("slack.stream.final_update_failed", {
          error: sanitizeError(err),
          len: first.length,
        });
        // Drop the still-:robot_face: placeholder, then post first chunk fresh.
        await this.safeDelete(this.ts);
        await this.safePost(first);
      }
    } else {
      // Never opened a placeholder — post directly.
      await this.safePost(first);
    }
    for (const chunk of chunks.slice(1)) {
      await this.safePost(chunk);
    }
  }

  // ---- internals ----

  private async openPlaceholder(): Promise<void> {
    try {
      const res = await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: this.placeholder,
      });
      this.ts = res.ts;
    } catch (err) {
      logger.warn("slack.stream.placeholder_failed", { error: sanitizeError(err) });
    }
  }

  private async flush(): Promise<void> {
    if (!this.buffer || this.ts === undefined) return;
    const text = this.buffer;
    const display = `${text} ${this.placeholder}`;
    if (display.length >= this.maxLen) {
      await this.rollFinalize(text);
      return;
    }
    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.ts,
        text: display,
      });
    } catch (err) {
      if (isSlackError(err, "msg_too_long")) {
        await this.spillToPostMessage(text);
        return;
      }
      logger.warn("slack.stream.update_failed", { error: sanitizeError(err) });
    }
  }

  /** Seal the current ts at a clean boundary and open a fresh placeholder. */
  private async rollFinalize(text: string): Promise<void> {
    const sepIdx = findRollCut(text);
    let sealedBody: string;
    let carry: string;
    let finalizedChunk: string;
    if (sepIdx === null) {
      sealedBody = text;
      carry = "";
      finalizedChunk = text;
    } else {
      sealedBody = text.slice(0, sepIdx.cut);
      carry = text.slice(sepIdx.cut + sepIdx.sepLen);
      finalizedChunk = text.slice(0, sepIdx.cut + sepIdx.sepLen);
    }
    let sealedText = sealedBody;
    let nextPrefix = "";
    if (countOccurrences(sealedBody, CODE_FENCE) % 2 === 1) {
      sealedText = `${sealedBody}\n${CODE_FENCE}`;
      nextPrefix = `${CODE_FENCE}\n`;
    }
    let sealed = false;
    if (this.ts !== undefined) {
      try {
        await this.client.chat.update({
          channel: this.channel,
          ts: this.ts,
          text: sealedText,
        });
        sealed = true;
      } catch (err) {
        logger.warn("slack.stream.roll_seal_failed", { error: sanitizeError(err) });
      }
    }
    if (sealed) {
      this.finalizedText += finalizedChunk;
    }
    await this.rollToNewPlaceholder();
    this.buffer = sealed ? nextPrefix + carry : text;
  }

  private async spillToPostMessage(text: string): Promise<void> {
    const chunks = splitMessage(text, this.maxLen);
    for (const chunk of chunks) {
      await this.safePost(chunk);
    }
    if (this.ts !== undefined) {
      await this.safeDelete(this.ts);
      this.ts = undefined;
    }
    this.buffer = "";
  }

  private async rollToNewPlaceholder(): Promise<void> {
    try {
      const res = await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: this.placeholder,
      });
      this.ts = res.ts;
    } catch (err) {
      logger.warn("slack.stream.roll_open_failed", { error: sanitizeError(err) });
      this.ts = undefined;
    }
  }

  private async safePost(text: string): Promise<void> {
    if (!text) return;
    try {
      await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text,
      });
    } catch (err) {
      logger.warn("slack.stream.followup_post_failed", { error: sanitizeError(err) });
    }
  }

  private async safeDelete(ts: string): Promise<void> {
    try {
      await this.client.chat.delete({ channel: this.channel, ts });
    } catch (err) {
      logger.debug("slack.stream.placeholder_delete_failed", { error: sanitizeError(err) });
    }
  }
}

const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) return count;
    count += 1;
    idx = found + needle.length;
  }
};

const findRollCut = (text: string): { cut: number; sepLen: number } | null => {
  const para = text.lastIndexOf(PARAGRAPH_SEP);
  if (para > 0) return { cut: para, sepLen: PARAGRAPH_SEP.length };
  const line = text.lastIndexOf("\n");
  if (line > 0) return { cut: line, sepLen: 1 };
  return null;
};
