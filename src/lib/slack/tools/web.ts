/**
 * Public-HTTPS web fetch (Jina Reader with raw-fetch fallback) + SSRF guard.
 *
 * Two-layer extraction:
 *   1. Try Jina Reader (`https://r.jina.ai/<url>`) which returns clean markdown.
 *   2. On failure, hit the URL directly and strip HTML with a simple regex
 *      pipeline.
 *
 * SSRF guard (applies to BOTH paths):
 *   - scheme must be https
 *   - hostname is not an IP literal
 *   - every address returned by DNS for the hostname is a public, routable
 *     unicast address (not private / loopback / link-local / multicast)
 *   - redirects refused — a 3xx pointing at a private host would silently
 *     defeat the pre-flight DNS check
 *
 * Note: Node's fetch resolves DNS internally per call, so there's a small TOCTOU
 * window between our `dns.lookup` and the fetch's own resolution. Acceptable
 * for an LLM tool — defense in depth is the pre-flight + redirect refusal +
 * size cap, not perfect IP pinning.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { tool, type Tool } from "ai";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";

const USER_AGENT = "nalbam-agent/1.0 (+https://github.com/nalbam/nalbam-agent)";
const FETCH_TIMEOUT_MS = 12_000;
const JINA_HEADER_MAX_LINES = 10;

const JINA_LINK_RE = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s()]*(?:\([^\s)]*\))?[^\s)]*)\)/g;

const inputSchema = z.object({
  url: z.string().describe("Absolute https URL of the page to fetch."),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(20_000)
    .optional()
    .describe("Optional cap on returned content characters. Clamped by MAX_WEB_CHARS."),
  maxLinks: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Optional cap on returned link count. Clamped by MAX_WEB_LINKS."),
});

export const isPublicAddress = (address: string): boolean => {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map((n) => Number.parseInt(n, 10));
    // RFC1918 + loopback + link-local + 0.0.0.0/8 + multicast/reserved.
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 0) return false;
    if (a >= 224) return false; // multicast + reserved
    return true;
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return false;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return false;
    if (lower.startsWith("ff")) return false; // multicast
    // IPv4-mapped IPv6 — re-validate the embedded v4.
    if (lower.startsWith("::ffff:")) {
      const tail = lower.slice("::ffff:".length);
      if (isIP(tail) === 4) return isPublicAddress(tail);
    }
    return true;
  }
  return false;
};

const validatePublicHttpsUrl = async (raw: string): Promise<URL> => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("fetch_webpage requires an absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("fetch_webpage requires https");
  }
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

const readBodyCapped = async (res: Response, maxBytes: number): Promise<string> => {
  const cl = res.headers.get("content-length");
  if (cl && Number.parseInt(cl, 10) > maxBytes) {
    throw new Error(`webpage exceeds MAX_WEB_BYTES=${maxBytes}`);
  }
  if (!res.body) return "";
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
        throw new Error(`webpage exceeds MAX_WEB_BYTES=${maxBytes}`);
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
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
};

const parseJinaResponse = (text: string): { title: string; body: string } => {
  if (!text) return { title: "", body: "" };
  const lines = text.split("\n");
  let title = "";
  let bodyStart = 0;
  const max = Math.min(lines.length, JINA_HEADER_MAX_LINES);
  for (let i = 0; i < max; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("Title: ")) {
      title = line.slice("Title: ".length).trim();
      bodyStart = Math.max(bodyStart, i + 1);
    } else if (line.startsWith("URL Source: ")) {
      bodyStart = Math.max(bodyStart, i + 1);
    } else if (line.startsWith("Markdown Content:")) {
      const inline = line.slice("Markdown Content:".length).trim();
      if (inline) {
        const bodyLines = [inline, ...lines.slice(i + 1)];
        return { title, body: bodyLines.join("\n").replace(/^\n+/, "") };
      }
      bodyStart = i + 1;
      break;
    }
  }
  if (bodyStart === 0) return { title, body: text };
  return { title, body: lines.slice(bodyStart).join("\n").replace(/^\n+/, "") };
};

const filterLinks = (
  rawLinks: Array<{ title: string; url: string }>,
  baseUrl: string,
  limit: number,
): Array<{ title: string; url: string }> => {
  if (limit <= 0) return [];
  const base = (() => {
    try {
      const u = new URL(baseUrl);
      u.hash = "";
      return u.toString();
    } catch {
      return baseUrl;
    }
  })();
  const seen = new Set<string>();
  const out: Array<{ title: string; url: string }> = [];
  for (const link of rawLinks) {
    if (!link.url.startsWith("https://")) continue;
    let normalized: string;
    try {
      const u = new URL(link.url);
      u.hash = "";
      normalized = u.toString();
    } catch {
      continue;
    }
    if (normalized === base) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ title: (link.title || link.url).trim(), url: link.url });
    if (out.length >= limit) break;
  }
  return out;
};

const extractMarkdownLinks = (
  md: string,
  base: string,
  limit: number,
): Array<{ title: string; url: string }> => {
  const matches: Array<{ title: string; url: string }> = [];
  JINA_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JINA_LINK_RE.exec(md)) !== null) {
    matches.push({ title: m[1] ?? "", url: m[2] ?? "" });
  }
  return filterLinks(matches, base, limit);
};

const stripHtml = (
  html: string,
): { title: string; text: string; links: Array<{ title: string; url: string }> } => {
  // Drop script/style/noscript first so their contents don't bleed into text.
  let cleaned = html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.trim().replace(/\s+/g, " ") ?? "";

  const links: Array<{ title: string; url: string }> = [];
  cleaned.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_full, href, inner) => {
    const text = String(inner)
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    links.push({ title: text, url: String(href) });
    return "";
  });

  // Insert paragraph breaks on block-ending tags before stripping.
  cleaned = cleaned.replace(/<\/?(p|div|li|h[1-6]|br|tr)[^>]*>/gi, "\n");
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = cleaned.replace(/&nbsp;/gi, " ");
  cleaned = cleaned.replace(/&amp;/gi, "&");
  cleaned = cleaned.replace(/&lt;/gi, "<");
  cleaned = cleaned.replace(/&gt;/gi, ">");
  cleaned = cleaned.replace(/&quot;/gi, '"');
  cleaned = cleaned.replace(/&#39;/gi, "'");
  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return { title, text: lines.join("\n"), links };
};

interface FetchWebpageResult {
  url: string;
  title: string;
  content: string;
  links: Array<{ title: string; url: string }>;
  chars: number;
  truncated: boolean;
  source: "jina" | "raw";
}

const tryJina = async (
  base: string,
  target: string,
  maxBytes: number,
): Promise<{ title: string; body: string } | null> => {
  const endpoint = `${base.replace(/\/+$/, "")}/${encodeURI(target)}`;
  const res = await fetchWithDeadline(endpoint, {
    method: "GET",
    headers: {
      accept: "text/markdown",
      "x-return-format": "markdown",
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`jina status ${res.status}`);
  }
  const text = await readBodyCapped(res, maxBytes);
  const parsed = parseJinaResponse(text);
  if (!parsed.body.trim()) return null;
  return parsed;
};

const rawFetch = async (
  target: string,
  maxBytes: number,
): Promise<{ title: string; text: string; links: Array<{ title: string; url: string }> }> => {
  const res = await fetchWithDeadline(target, { method: "GET" });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`redirects not allowed (status ${res.status})`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }
  const html = await readBodyCapped(res, maxBytes);
  return stripHtml(html);
};

export const fetchWebpageTool = (): Tool =>
  tool({
    description:
      "Fetch a public HTTPS web page and return clean text content plus a list of outbound links. Use this for summarizing articles, landing pages, or news indexes. For Slack-hosted files use read_attached_document / read_attached_images instead.",
    inputSchema,
    execute: async ({ url, maxChars, maxLinks }) => {
      const env = getServerEnv();
      await validatePublicHttpsUrl(url);
      const effectiveChars = Math.min(maxChars ?? env.MAX_WEB_CHARS, env.MAX_WEB_CHARS);
      const effectiveLinks = Math.min(maxLinks ?? env.MAX_WEB_LINKS, env.MAX_WEB_LINKS);

      let title = "";
      let content = "";
      let links: Array<{ title: string; url: string }> = [];
      let source: "jina" | "raw" = "jina";
      let jinaErr: string | undefined;
      try {
        const jina = await tryJina(env.JINA_READER_BASE, url, env.MAX_WEB_BYTES);
        if (jina) {
          title = jina.title;
          content = jina.body;
          links = extractMarkdownLinks(jina.body, url, effectiveLinks);
        } else {
          jinaErr = "empty body";
        }
      } catch (err) {
        jinaErr = err instanceof Error ? err.message : "jina failed";
      }

      if (!content) {
        // Belt-and-suspenders re-validate before the raw fetch.
        await validatePublicHttpsUrl(url);
        try {
          const raw = await rawFetch(url, env.MAX_WEB_BYTES);
          title = raw.title || title;
          content = raw.text;
          links = filterLinks(raw.links, url, effectiveLinks);
          source = "raw";
        } catch (err) {
          throw new Error(
            `fetch_webpage failed: jina=${jinaErr ?? "n/a"}, raw=${err instanceof Error ? err.message : "unknown"}`,
          );
        }
      }

      let truncated = false;
      if (content.length > effectiveChars) {
        content = content.slice(0, effectiveChars);
        truncated = true;
      }

      const result: FetchWebpageResult = {
        url,
        title,
        content,
        links,
        chars: content.length,
        truncated,
        source,
      };
      return result;
    },
  });
