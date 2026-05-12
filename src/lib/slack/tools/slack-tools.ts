/**
 * Slack-centric agent tools.
 *
 *   - read_attached_images:    download images from the triggering mention
 *                              (and optional extra urls) → vision describe.
 *   - fetch_user_profile:      users.info lookup with display-name cache reuse.
 *   - read_attached_document:  download PDF/text files and extract text via
 *                              unpdf (PDF) or UTF-8 decode (text/*).
 *   - fetch_thread_history:    conversations.replies with parallel user-name
 *                              resolution and aggregate-text budget.
 *
 * Security:
 *   - Slack file fetches are limited to files*.slack.com or known Slack
 *     profile-image hosts (avatars.slack-edge.com / a.slack-edge.com /
 *     secure.gravatar.com).
 *   - `Authorization: Bearer <bot_token>` is only sent to files*.slack.com.
 *     Profile-image hosts are public CDN — sending the token there could
 *     leak it via 3xx redirects.
 *   - Redirects are refused on every download so a 3xx cannot carry the
 *     token to an off-host target.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { describeImage } from "@/lib/llm/vision";
import { findUserIdByName, setUserName, warmUserNames, getUserName } from "@/lib/slack/user-name-cache";

import type { ToolContext } from "@/lib/slack/tools/registry";

const SLACK_FILE_HOSTS = new Set([
  "files.slack.com",
  "files-edge.slack.com",
  "files-pri.slack.com",
]);
const SLACK_PROFILE_HOSTS = new Set([
  "avatars.slack-edge.com",
  "a.slack-edge.com",
  "secure.gravatar.com",
]);
const SLACK_IMAGE_HOSTS = new Set<string>([...SLACK_FILE_HOSTS, ...SLACK_PROFILE_HOSTS]);

const USER_ID_RE = /^[UW][A-Z0-9]+$/;
const FETCH_TIMEOUT_MS = 15_000;
const HISTORY_TEXT_CHARS = 2000;
const HISTORY_TOTAL_CHARS = 30_000;

// ── HTTP helpers ─────────────────────────────────────────────────────────

const fetchWithDeadline = async (
  url: string,
  init: RequestInit,
): Promise<Response> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};

const readBodyCapped = async (res: Response, maxBytes: number): Promise<Uint8Array> => {
  const cl = res.headers.get("content-length");
  if (cl && Number.parseInt(cl, 10) > maxBytes) {
    throw new Error(`exceeds size cap ${maxBytes}`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`exceeds size cap ${maxBytes}`);
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return buf;
};

const downloadSlackFile = async (
  url: string,
  token: string,
  maxBytes: number,
): Promise<{ body: Uint8Array; mime: string }> => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("invalid Slack file URL");
  }
  if (!SLACK_IMAGE_HOSTS.has(parsed.hostname)) {
    throw new Error("invalid Slack file URL");
  }
  const headers: Record<string, string> = {};
  if (SLACK_FILE_HOSTS.has(parsed.hostname)) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetchWithDeadline(url, { method: "GET", headers });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`refused redirect (status ${res.status})`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }
  const mime = (res.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";
  const body = await readBodyCapped(res, maxBytes);
  return { body, mime };
};

const guessImageMime = (url: string): string => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".bmp")) return "image/bmp";
    if (path.endsWith(".heic")) return "image/heic";
  } catch {
    // fall through
  }
  return "image/png";
};

const filenameFromUrl = (url: string): string => {
  try {
    const path = new URL(url).pathname;
    const name = path.split("/").pop() ?? "";
    return name || "image";
  } catch {
    return "image";
  }
};

// ── shared event-file shape ──────────────────────────────────────────────

interface SlackFileEntry {
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  permalink?: string;
  title?: string;
}

const eventFiles = (event: ToolContext["event"]): SlackFileEntry[] => {
  const files = event?.files;
  if (!Array.isArray(files)) return [];
  return files.filter((f): f is SlackFileEntry => typeof f === "object" && f !== null);
};

// ── read_attached_images ────────────────────────────────────────────────

const readImagesSchema = z.object({
  limit: z.number().int().min(1).max(10).optional().default(3),
  urls: z
    .array(z.string())
    .optional()
    .describe(
      "Additional image URLs to describe. Must be either a Slack file URL (files*.slack.com) or a Slack profile image URL (avatars.slack-edge.com, a.slack-edge.com, secure.gravatar.com).",
    ),
});

export const readAttachedImagesTool = (ctx: ToolContext): Tool =>
  tool({
    description:
      "Read image files and return textual descriptions. By default reads images attached to the current Slack mention. Pass `urls` to also read images referenced from thread history (url_private_download returned by fetch_thread_history) or profile images (image_url returned by fetch_user_profile).",
    inputSchema: readImagesSchema,
    execute: async ({ limit, urls }) => {
      const env = getServerEnv();
      const token = ctx.client.token;
      if (!token) throw new Error("Slack client missing token");
      type Candidate = { url: string; mime: string; name: string };
      const seen = new Set<string>();
      const candidates: Candidate[] = [];

      for (const f of eventFiles(ctx.event).slice(0, limit)) {
        if (candidates.length >= limit) break;
        const mime = String(f.mimetype ?? "");
        if (!mime.startsWith("image/")) continue;
        const dl = f.url_private_download ?? f.url_private;
        if (!dl || seen.has(dl)) continue;
        seen.add(dl);
        candidates.push({ url: dl, mime, name: f.name ?? "image" });
      }
      for (const extra of urls ?? []) {
        if (candidates.length >= limit) break;
        if (seen.has(extra)) continue;
        seen.add(extra);
        candidates.push({ url: extra, mime: "", name: filenameFromUrl(extra) });
      }

      // Pre-flight host validation surfaces synchronously.
      for (const c of candidates) {
        try {
          const u = new URL(c.url);
          if (u.protocol !== "https:" || !SLACK_IMAGE_HOSTS.has(u.hostname)) {
            throw new Error("invalid Slack file download URL");
          }
        } catch {
          throw new Error("invalid Slack file download URL");
        }
      }

      if (candidates.length === 0) return [];

      const out: Array<{ name: string; summary: string }> = [];
      // Sequential to bound concurrent vision calls — multimodal LLM
      // requests are expensive, and the agent rarely needs >3 images.
      for (const c of candidates) {
        try {
          const { body, mime } = await downloadSlackFile(c.url, token, env.MAX_IMAGE_BYTES);
          const effective = mime.startsWith("image/") ? mime : guessImageMime(c.url);
          if (!effective.startsWith("image/")) continue;
          const summary = await describeImage({ data: body, mediaType: effective });
          out.push({ name: c.name, summary });
        } catch (err) {
          logger.warn("slack.read_attached_images.failed", {
            url: c.url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return out;
    },
  });

// ── fetch_user_profile ──────────────────────────────────────────────────

const userProfileSchema = z.object({
  user: z
    .string()
    .describe("Slack user ID (U…/W…), <@U…> mention, or display name."),
});

const resolveUserId = (identifier: string): string | undefined => {
  if (!identifier) return undefined;
  let candidate = identifier.trim();
  if (candidate.startsWith("<@") && candidate.endsWith(">")) {
    candidate = candidate.slice(2, -1).split("|", 1)[0] ?? candidate;
  }
  if (USER_ID_RE.test(candidate)) return candidate;
  return findUserIdByName(identifier.trim());
};

const warmCacheFromThread = async (ctx: ToolContext): Promise<boolean> => {
  if (!ctx.threadTs || !ctx.channel) return false;
  try {
    const res = await ctx.client.conversations.replies({
      channel: ctx.channel,
      ts: ctx.threadTs,
      limit: 50,
    });
    const messages = (res.messages ?? []) as Array<{ user?: string }>;
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.user) ids.add(m.user);
    }
    if (ids.size === 0) return false;
    await warmUserNames(ctx.client, ids);
    return true;
  } catch (err) {
    logger.debug("slack.warm_cache_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
};

interface SlackProfile {
  display_name?: string;
  real_name?: string;
  image_original?: string;
  image_1024?: string;
  image_512?: string;
  image_192?: string;
  image_72?: string;
}

interface SlackUserShape {
  real_name?: string;
  profile?: SlackProfile;
}

export const fetchUserProfileTool = (ctx: ToolContext): Tool =>
  tool({
    description:
      "Look up a Slack user's profile and return their display name, real name, and profile image URL. Accepts either a Slack user ID (U…/W…), a mention like <@U12345>, or a display name (resolved against names already seen in this session — call fetch_thread_history first if a name lookup fails). The returned image_url can be passed via the `urls` parameter of edit_image (to restyle the avatar) or read_attached_images (to describe it).",
    inputSchema: userProfileSchema,
    execute: async ({ user }) => {
      let userId = resolveUserId(user);
      if (!userId) {
        if (await warmCacheFromThread(ctx)) {
          userId = resolveUserId(user);
        }
      }
      if (!userId) {
        throw new Error(
          `could not resolve user ${user}. Pass a user ID (U…/W…), a <@U…> mention, or call fetch_thread_history first so the display name is in cache.`,
        );
      }
      const res = await ctx.client.users.info({ user: userId });
      const u = (res.user ?? {}) as SlackUserShape;
      const profile = u.profile ?? {};
      const realName = u.real_name || profile.real_name || "";
      const displayName = profile.display_name || realName || userId;
      const imageUrl =
        profile.image_original ||
        profile.image_1024 ||
        profile.image_512 ||
        profile.image_192 ||
        profile.image_72 ||
        "";
      setUserName(userId, displayName);
      return {
        user_id: userId,
        display_name: displayName,
        real_name: realName,
        image_url: imageUrl,
      };
    },
  });

// ── read_attached_document ──────────────────────────────────────────────

const readDocsSchema = z.object({
  limit: z.number().int().min(1).max(5).optional().default(2),
  urls: z
    .array(z.string())
    .optional()
    .describe("Extra Slack file URLs (must be on files*.slack.com)."),
});

const DOC_PDF = "application/pdf";
const DOC_TEXT_PREFIX = "text/";

const parsePdf = async (
  data: Uint8Array,
  maxPages: number,
  maxChars: number,
): Promise<{ text: string; pages: number; truncated: boolean }> => {
  // Lazy import so unpdf stays out of cold-start for requests that don't
  // touch this tool.
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  const pageCount = pdf.numPages;
  if (pageCount > maxPages) {
    throw new Error(`document exceeds MAX_DOC_PAGES=${maxPages}`);
  }
  const { text } = await extractText(pdf, { mergePages: true });
  const combined = Array.isArray(text) ? text.join("\n") : String(text ?? "");
  let truncated = false;
  let out = combined;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return { text: out, pages: pageCount, truncated };
};

const parseTextBody = (
  data: Uint8Array,
  maxChars: number,
): { text: string; truncated: boolean } => {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data);
  const truncated = decoded.length > maxChars;
  return { text: truncated ? decoded.slice(0, maxChars) : decoded, truncated };
};

export const readAttachedDocumentTool = (ctx: ToolContext): Tool =>
  tool({
    description:
      "Read PDF or text/* files attached to the current Slack mention (and optionally extra URLs on files*.slack.com) and return the extracted text. Images are skipped — use read_attached_images for those. Returns one entry per document; if a document fails (encrypted, oversize, corrupt) the entry carries an 'error' key.",
    inputSchema: readDocsSchema,
    execute: async ({ limit, urls }) => {
      const env = getServerEnv();
      const token = ctx.client.token;
      if (!token) throw new Error("Slack client missing token");
      const maxBytes = env.MAX_DOC_BYTES;
      const maxChars = env.MAX_DOC_CHARS;
      const maxPages = env.MAX_DOC_PAGES;

      const isDocMime = (mime: string): boolean => {
        const lower = (mime || "").toLowerCase();
        return lower === DOC_PDF || lower.startsWith(DOC_TEXT_PREFIX);
      };

      type Candidate = { url: string; mimeHint: string; name: string };
      const seen = new Set<string>();
      const candidates: Candidate[] = [];
      for (const f of eventFiles(ctx.event).slice(0, limit)) {
        if (candidates.length >= limit) break;
        const mime = String(f.mimetype ?? "");
        if (!isDocMime(mime)) continue;
        const dl = f.url_private_download ?? f.url_private;
        if (!dl || seen.has(dl)) continue;
        seen.add(dl);
        candidates.push({ url: dl, mimeHint: mime, name: f.name ?? "document" });
      }
      for (const extra of urls ?? []) {
        if (candidates.length >= limit) break;
        if (seen.has(extra)) continue;
        seen.add(extra);
        candidates.push({ url: extra, mimeHint: "", name: filenameFromUrl(extra) });
      }

      if (candidates.length === 0) return [];

      const out: Array<Record<string, unknown>> = [];
      for (const c of candidates) {
        try {
          const { body, mime: headerMime } = await downloadSlackFile(c.url, token, maxBytes);
          const mime = (headerMime || c.mimeHint || "").toLowerCase();
          if (mime === DOC_PDF) {
            try {
              const parsed = await parsePdf(body, maxPages, maxChars);
              out.push({
                name: c.name,
                mimetype: DOC_PDF,
                pages: parsed.pages,
                chars: parsed.text.length,
                truncated: parsed.truncated,
                text: parsed.text,
              });
            } catch (err) {
              out.push({
                name: c.name,
                error: err instanceof Error ? err.message : "PDF parse failed",
              });
            }
          } else if (mime.startsWith(DOC_TEXT_PREFIX)) {
            const parsed = parseTextBody(body, maxChars);
            out.push({
              name: c.name,
              mimetype: mime,
              pages: 0,
              chars: parsed.text.length,
              truncated: parsed.truncated,
              text: parsed.text,
            });
          }
          // Silent skip for non-doc mimes (images handled elsewhere).
        } catch (err) {
          out.push({
            name: c.name,
            error: err instanceof Error ? err.message : "download failed",
          });
        }
      }
      return out;
    },
  });

// ── fetch_thread_history ───────────────────────────────────────────────

const threadHistorySchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
});

interface SlackHistoryReaction {
  name?: string;
  count?: number;
  users?: string[];
}

interface SlackHistoryMessage {
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  files?: SlackFileEntry[];
  reactions?: SlackHistoryReaction[];
}

const withSlackRetry = async <T>(
  fn: () => Promise<T>,
  label: string,
  attempts = 3,
): Promise<T> => {
  let delayMs = 1000;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const data = (err as { data?: { error?: string } }).data;
      if (data?.error === "ratelimited" && i < attempts - 1) {
        logger.warn("slack.ratelimited", { label, delayMs });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${label}: exhausted retries`);
};

export const fetchThreadHistoryTool = (ctx: ToolContext): Tool =>
  tool({
    description:
      "Fetch recent messages from the current Slack thread for context. Returns each message's user display name, text, file metadata (for images include url_private_download so read_attached_images can describe them), reactions with emoji names and reacting users, and timestamp.",
    inputSchema: threadHistorySchema,
    execute: async ({ limit }) => {
      if (!ctx.threadTs || !ctx.channel) {
        return [];
      }
      const res = await withSlackRetry(
        () =>
          ctx.client.conversations.replies({
            channel: ctx.channel!,
            ts: ctx.threadTs!,
            limit,
          }),
        "conversations.replies",
      );
      const messages = (res.messages ?? []) as SlackHistoryMessage[];

      const userIds = new Set<string>();
      for (const m of messages) {
        if (m.user) userIds.add(m.user);
        for (const r of m.reactions ?? []) {
          for (const u of r.users ?? []) {
            if (u) userIds.add(u);
          }
        }
      }
      await warmUserNames(ctx.client, userIds);

      const out: Array<Record<string, unknown>> = [];
      let totalChars = 0;
      for (let idx = 0; idx < messages.length; idx += 1) {
        const m = messages[idx]!;
        const userId = m.user ?? "";
        const author = userId
          ? await getUserName(ctx.client, userId)
          : (m.username ?? m.bot_id ?? "");
        const files = (m.files ?? []).map((f) => ({
          name: f.name ?? "",
          mimetype: f.mimetype ?? "",
          url_private_download: f.url_private_download ?? "",
          permalink: f.permalink ?? "",
          title: f.title ?? "",
        }));
        const reactions = await Promise.all(
          (m.reactions ?? []).map(async (r) => ({
            emoji: r.name ?? "",
            count: r.count ?? 0,
            users: await Promise.all(
              (r.users ?? []).map((u) => getUserName(ctx.client, u)),
            ),
          })),
        );
        let text = m.text ?? "";
        if (text.length > HISTORY_TEXT_CHARS) {
          text = text.slice(0, HISTORY_TEXT_CHARS) + "…";
        }
        const budgetLeft = HISTORY_TOTAL_CHARS - totalChars;
        if (budgetLeft <= 0) {
          const remaining = messages.length - idx;
          out.push({
            user: author,
            text: `[${remaining} more messages truncated]`,
            ts: m.ts ?? "",
            files,
            reactions,
          });
          break;
        }
        if (text.length > budgetLeft) {
          text = text.slice(0, budgetLeft) + "…";
        }
        totalChars += text.length;
        out.push({
          user: author,
          text,
          ts: m.ts ?? "",
          files,
          reactions,
        });
      }
      return out;
    },
  });
