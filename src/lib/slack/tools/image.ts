/**
 * Image generation / external-attach tools.
 *
 *   - generate_image:           generate from a text prompt → upload to thread.
 *   - attach_image_from_url:    download a public web image → upload to thread.
 *   - edit_image:               provider-dependent multipart edit. Stubbed
 *                               with a clear error in PR4; revisit when ai-sdk
 *                               exposes a stable edit interface or when we
 *                               wire the OpenAI `/v1/images/edits` endpoint
 *                               directly.
 *
 * Generation uses Vercel AI SDK's `experimental_generateImage`. OpenAI is
 * the only supported provider in this iteration; Bedrock image generation
 * (Nova Canvas / Titan Image) currently has no ai-sdk wrapper, so we
 * surface an explicit "unsupported" error rather than silently producing
 * a stub image.
 *
 * Security for `attach_image_from_url`:
 *   - HTTPS only.
 *   - DNS pre-flight via the shared SSRF guard in `tools/web.ts`.
 *   - `redirect: "manual"` — a 3xx pointing at a private host would defeat
 *     the pre-flight check.
 *   - `Content-Type` must claim `image/*`.
 *   - Magic-byte check — header trust isn't enough; a malicious server can
 *     label HTML/SVG as image/png. Verify the actual bytes match a known
 *     image signature (PNG / JPEG / GIF / WebP / BMP).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { openai } from "@ai-sdk/openai";
import { experimental_generateImage as generateImage, tool, type Tool } from "ai";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

import { isPublicAddress } from "@/lib/slack/tools/web";
import type { ToolContext } from "@/lib/slack/tools/registry";

const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = "nalbam-agent/1.0 (+https://github.com/nalbam/nalbam-agent)";

// ── shared HTTP helpers ─────────────────────────────────────────────────

const validatePublicHttpsUrl = async (raw: string): Promise<URL> => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("attach_image_from_url requires an absolute URL");
  }
  if (parsed.protocol !== "https:") throw new Error("https only");
  const host = parsed.hostname;
  if (!host) throw new Error("URL missing hostname");
  if (isIP(host)) throw new Error("IP literals not allowed");
  let infos: Array<{ address: string }>;
  try {
    infos = await lookup(host, { all: true });
  } catch (err) {
    throw new Error(`DNS resolution failed: ${err instanceof Error ? err.message : "unknown"}`);
  }
  if (infos.length === 0) throw new Error("DNS resolution returned no addresses");
  for (const info of infos) {
    if (!isPublicAddress(info.address)) {
      throw new Error("hostname resolves to non-public address");
    }
  }
  return parsed;
};

const fetchWithDeadline = async (url: string, init: RequestInit): Promise<Response> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: ctrl.signal,
      headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
    });
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

const detectImageMime = (body: Uint8Array): string | undefined => {
  if (body.length < 4) return undefined;
  if (body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47)
    return "image/png";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (
    body[0] === 0x47 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x38 // "GIF8"
  )
    return "image/gif";
  if (
    body.length >= 12 &&
    body[0] === 0x52 &&
    body[1] === 0x49 &&
    body[2] === 0x46 &&
    body[3] === 0x46 && // "RIFF"
    body[8] === 0x57 &&
    body[9] === 0x45 &&
    body[10] === 0x42 &&
    body[11] === 0x50 // "WEBP"
  )
    return "image/webp";
  if (body[0] === 0x42 && body[1] === 0x4d) return "image/bmp";
  return undefined;
};

const filenameForImage = (url: string, mime: string): string => {
  let baseName = "image";
  try {
    const path = new URL(url).pathname;
    const tail = path.split("/").pop() ?? "";
    const clean = tail.split("?", 1)[0]?.split("#", 1)[0] ?? "";
    if (clean && clean.includes(".")) return clean;
    if (clean) baseName = clean;
  } catch {
    // ignored — fall through to default basename
  }
  const ext: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  return `${baseName}.${ext[mime] ?? "png"}`;
};

// ── Slack upload helper ────────────────────────────────────────────────

interface SlackUploadResult {
  permalink: string;
  url_private_download: string;
  title: string;
  mimetype: string;
}

interface SlackUploadResponse {
  files?: Array<{
    permalink?: string;
    url_private?: string;
    url_private_download?: string;
    title?: string;
    mimetype?: string;
  }>;
  file?: {
    permalink?: string;
    url_private?: string;
    url_private_download?: string;
    title?: string;
    mimetype?: string;
  };
}

const uploadToThread = async (
  ctx: ToolContext,
  bytes: Uint8Array,
  filename: string,
  title: string,
): Promise<SlackUploadResult> => {
  if (!ctx.channel) throw new Error("upload requires a channel");
  // `Uint8Array` from typed arrays — Slack SDK accepts Buffer | ReadableStream.
  // `Buffer.from(view)` re-uses the underlying ArrayBuffer (no copy).
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const args: Record<string, unknown> = {
    channel_id: ctx.channel,
    filename,
    title,
    file,
  };
  if (ctx.threadTs) args.thread_ts = ctx.threadTs;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (await ctx.client.files.uploadV2(args as any)) as SlackUploadResponse;
  // files.uploadV2 returns `files: [...]` in current SDK; older shapes used
  // singular `file`. Tolerate both.
  const entry = res.files?.[0] ?? res.file ?? {};
  return {
    permalink: entry.permalink ?? "",
    url_private_download: entry.url_private_download ?? entry.url_private ?? "",
    title: entry.title ?? title,
    mimetype: entry.mimetype ?? "",
  };
};

// ── generate_image ─────────────────────────────────────────────────────

const generateImageSchema = z.object({
  prompt: z.string().describe("What to generate."),
});

export const generateImageTool = (ctx: ToolContext): Tool =>
  tool({
    description:
      "Generate an image from a prompt and upload it to the Slack thread. Returns the permalink. OpenAI provider only in this iteration — Bedrock image generation (Nova Canvas / Titan Image) is not yet supported and the tool surfaces an error for that case.",
    inputSchema: generateImageSchema,
    execute: async ({ prompt }) => {
      const env = getServerEnv();
      const provider = env.IMAGE_PROVIDER ?? env.LLM_PROVIDER;
      if (provider !== "openai") {
        throw new Error(
          `generate_image: provider '${provider}' not supported yet (only openai). Fall back to a text description for the user.`,
        );
      }
      const model = openai.image(env.IMAGE_MODEL);
      const result = await generateImage({ model, prompt });
      const file = result.image;
      // Vercel AI SDK 6.x returns image with `uint8Array` accessor.
      const bytes = file.uint8Array;
      const filename = "generated.png";
      const title = env.IMAGE_MODEL;
      const upload = await uploadToThread(ctx, bytes, filename, title);
      return upload;
    },
  });

// ── attach_image_from_url ──────────────────────────────────────────────

const attachImageSchema = z.object({
  url: z.string().describe("Absolute https URL of the image to attach."),
  title: z.string().optional().describe("Optional Slack file title shown above the upload."),
});

export const attachImageFromUrlTool = (ctx: ToolContext): Tool =>
  tool({
    description:
      "Download a public web image and attach it to the Slack thread. Use this to bring an external image (e.g. a result from search_images) into the conversation — the upload makes it Slack-hosted so subsequent tools (edit_image, read_attached_images) can reference it by its files.slack.com URL. Returns the Slack permalink and url_private_download. Rejects non-https URLs, non-image content types, and oversize payloads (cap from MAX_IMAGE_BYTES).",
    inputSchema: attachImageSchema,
    execute: async ({ url, title }) => {
      const env = getServerEnv();
      await validatePublicHttpsUrl(url);
      const res = await fetchWithDeadline(url, { method: "GET" });
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`refused redirect (status ${res.status})`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}`);
      }
      const headerMime =
        (res.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!headerMime.startsWith("image/")) {
        throw new Error(`URL did not return an image (Content-Type=${headerMime || "missing"})`);
      }
      const body = await readBodyCapped(res, env.MAX_IMAGE_BYTES);
      const detected = detectImageMime(body);
      if (!detected) {
        throw new Error(
          `URL claimed Content-Type=${headerMime} but body is not a recognized image format (png/jpeg/gif/webp/bmp)`,
        );
      }
      const filename = filenameForImage(url, detected);
      const upload = await uploadToThread(ctx, body, filename, title ?? filename);
      logger.info("slack.attach_image_from_url", {
        url,
        mime: detected,
        bytes: body.byteLength,
      });
      return upload;
    },
  });

// ── edit_image (stub) ──────────────────────────────────────────────────

const editImageSchema = z.object({
  prompt: z.string(),
  urls: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(5).optional().default(2),
});

export const editImageTool = (ctx: ToolContext): Tool => {
  void ctx;
  return tool({
    description:
      "Edit an existing image with a text prompt. Currently NOT implemented — returns an error so the agent can pivot to a text-only suggestion or generate_image. This tool will be wired in a follow-up PR.",
    inputSchema: editImageSchema,
    execute: async (args): Promise<{ error: string }> => {
      void args;
      return {
        error:
          "edit_image is not implemented yet — try generate_image with a descriptive prompt, or describe the desired changes textually.",
      };
    },
  });
};
