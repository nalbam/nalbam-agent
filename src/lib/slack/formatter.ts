/**
 * Slack-safe message splitting.
 *
 * Slack's `chat.postMessage` / `chat.update` cap `text` at ~3000 characters
 * for mrkdwn-rendered content (the documented 4000 limit applies to plain
 * text without markdown coercion). Long agent answers must be split into
 * multiple chunks while preserving code blocks and avoiding mid-token cuts.
 *
 * Strategy (greedy, paragraph-first):
 *   1. Cut at the last `\n\n` that fits inside `maxLen`. Keeps sentences whole.
 *   2. If that cut lands inside a ``` code block (odd fence count), push the
 *      whole block to the next chunk by cutting at the `\n\n` right before
 *      it opens.
 *   3. If the block itself exceeds `maxLen`, cut inside the block at `\n\n`
 *      or `\n`; seal the current chunk with `\n```` and open the next with
 *      ``` `+`\n` so both chunks render as balanced fences in Slack.
 *   4. When no `\n\n` fits, fall back to a sentence boundary (.!? + WS),
 *      then to a single `\n`, then to a hard slice.
 */

const CODE_FENCE = "```";
const PARAGRAPH_SEP = "\n\n";
const SENTENCE_SPLIT = /(?<=[.!?])\s+/g;

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

const fallbackCut = (text: string, maxLen: number): [string, number] => {
  SENTENCE_SPLIT.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  for (;;) {
    const match = SENTENCE_SPLIT.exec(text);
    if (!match) break;
    if (match.index >= maxLen) break;
    last = match;
  }
  if (last) {
    return [text.slice(0, last.index), last.index + last[0].length];
  }
  const lineCut = text.lastIndexOf("\n", maxLen);
  if (lineCut > 0) {
    return [text.slice(0, lineCut), lineCut + 1];
  }
  return [text.slice(0, maxLen), maxLen];
};

/**
 * Split `text` into chunks no longer than `maxLen`. Empty input returns `[""]`
 * so callers can post a placeholder when needed.
 */
export const splitMessage = (text: string, maxLen = 3000): string[] => {
  if (!text) return [""];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  const fenceSuffix = `\n${CODE_FENCE}`;
  const fencePrefix = `${CODE_FENCE}\n`;

  while (remaining.length > maxLen) {
    // 1. Greedy paragraph-boundary cut.
    let cut = remaining.lastIndexOf(PARAGRAPH_SEP, maxLen);
    let first: string;
    let tailStart: number;
    if (cut > 0) {
      first = remaining.slice(0, cut);
      tailStart = cut + PARAGRAPH_SEP.length;
    } else {
      [first, tailStart] = fallbackCut(remaining, maxLen);
    }

    // 2. Code-fence balance: odd ``` count means the cut split a block.
    if (countOccurrences(first, CODE_FENCE) % 2 === 1) {
      const lastFence = first.lastIndexOf(CODE_FENCE);
      const blockStartCut = first.lastIndexOf(PARAGRAPH_SEP, lastFence);
      if (blockStartCut > 0) {
        first = remaining.slice(0, blockStartCut);
        tailStart = blockStartCut + PARAGRAPH_SEP.length;
      } else {
        const minCut = lastFence + CODE_FENCE.length + 1;
        const innerBudget = maxLen - fenceSuffix.length;
        const innerCut = remaining.slice(minCut, innerBudget).lastIndexOf(PARAGRAPH_SEP);
        if (innerCut > 0) {
          const absCut = minCut + innerCut;
          first = remaining.slice(0, absCut);
          tailStart = absCut + PARAGRAPH_SEP.length;
        } else {
          const lineCut = remaining.slice(minCut, innerBudget).lastIndexOf("\n");
          if (lineCut > 0) {
            const absCut = minCut + lineCut;
            first = remaining.slice(0, absCut);
            tailStart = absCut + 1;
          } else {
            first = remaining.slice(0, innerBudget);
            tailStart = innerBudget;
          }
        }
        chunks.push(first + fenceSuffix);
        remaining = fencePrefix + remaining.slice(tailStart);
        cut = -1;
        continue;
      }
    }

    chunks.push(first);
    remaining = remaining.slice(tailStart);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
};

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [/xox[abprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]"],
  [/sk-ant-[A-Za-z0-9\-_]{10,}/g, "[redacted-anthropic-key]"],
  [/sk-[A-Za-z0-9\-_]{10,}/g, "[redacted-openai-key]"],
  [/xai-[A-Za-z0-9\-_]{10,}/g, "[redacted-xai-key]"],
  [/tvly-[A-Za-z0-9\-_]{10,}/g, "[redacted-tavily-key]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-aws-key]"],
];

/**
 * Strip provider tokens / AWS keys / long paths from error messages before
 * surfacing them to logs or user-facing channels.
 */
export const sanitizeError = (err: unknown): string => {
  let msg = err instanceof Error ? err.message : String(err);
  if (!msg) msg = err instanceof Error ? err.name : "unknown error";
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    msg = msg.replace(pattern, replacement);
  }
  // Strip ts/js path-like tokens.
  msg = msg.replace(/\/[\w./-]+\.(?:ts|tsx|js|mjs|cjs)/g, "[path]");
  if (msg.length > 300) msg = `${msg.slice(0, 297)}...`;
  return msg;
};
