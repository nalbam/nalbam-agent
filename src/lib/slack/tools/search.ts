/**
 * Web + image search tools.
 *
 * `search_web` uses Tavily when `TAVILY_API_KEY` is set, falling back to
 * DuckDuckGo Instant Answer otherwise.
 *
 * `search_images` requires Tavily (DuckDuckGo doesn't expose images). When
 * the key is missing the tool surfaces a clear error so the agent can fall
 * back to a text-only response.
 */
import { tool, type Tool } from "ai";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";

const DUCKDUCKGO_URL = "https://api.duckduckgo.com/";
const TAVILY_URL = "https://api.tavily.com/search";
const FETCH_TIMEOUT_MS = 15_000;
const SEARCH_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const fetchWithDeadline = async (url: string, init: RequestInit): Promise<Response> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // `redirect: "manual"` keeps us pinned to the known search hosts even if
    // they ever start issuing 3xx — consistent with other tool fetches and
    // defense-in-depth against any future open-redirect on the API.
    return await fetch(url, { ...init, redirect: "manual", signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};

const readBodyCapped = async (res: Response, maxBytes: number): Promise<string> => {
  const cl = res.headers.get("content-length");
  if (cl && Number.parseInt(cl, 10) > maxBytes) {
    throw new Error(`search response exceeds ${maxBytes} bytes`);
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
        throw new Error(`search response exceeds ${maxBytes} bytes`);
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

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilySearchResponse {
  results?: TavilyResult[];
}

const tavilySearch = async (
  apiKey: string,
  query: string,
  limit: number,
): Promise<SearchResult[]> => {
  const res = await fetchWithDeadline(TAVILY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: limit }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Tavily HTTP ${res.status}`);
  }
  const text = await readBodyCapped(res, SEARCH_RESPONSE_MAX_BYTES);
  const parsed = JSON.parse(text) as TavilySearchResponse;
  const results = parsed.results ?? [];
  return results.slice(0, limit).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    content: r.content ?? "",
  }));
};

interface DuckDuckGoResponse {
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

const ddgSearch = async (query: string, limit: number): Promise<SearchResult[]> => {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    no_redirect: "1",
    no_html: "1",
  });
  const url = `${DUCKDUCKGO_URL}?${params.toString()}`;
  const res = await fetchWithDeadline(url, { method: "GET" });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DuckDuckGo HTTP ${res.status}`);
  }
  const text = await readBodyCapped(res, SEARCH_RESPONSE_MAX_BYTES);
  const parsed = JSON.parse(text) as DuckDuckGoResponse;
  const out: SearchResult[] = [];
  if (parsed.AbstractURL) {
    out.push({
      title: parsed.AbstractText ?? "",
      url: parsed.AbstractURL,
      content: parsed.AbstractText ?? "",
    });
  }
  for (const item of parsed.RelatedTopics ?? []) {
    if (out.length >= limit) break;
    if (item.Text && item.FirstURL) {
      out.push({ title: item.Text, url: item.FirstURL, content: "" });
    }
  }
  return out.slice(0, limit);
};

const searchWebSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(20).optional().default(5),
});

export const searchWebTool = (): Tool =>
  tool({
    description:
      "Search the public web for up-to-date information. Uses Tavily if TAVILY_API_KEY is set, otherwise DuckDuckGo Instant Answer.",
    inputSchema: searchWebSchema,
    execute: async ({ query, limit }) => {
      const env = getServerEnv();
      if (env.TAVILY_API_KEY) {
        return tavilySearch(env.TAVILY_API_KEY, query, limit);
      }
      return ddgSearch(query, limit);
    },
  });

interface TavilyImagesResponse {
  images?: Array<string | { url?: string; description?: string }>;
}

const tavilyImageSearch = async (
  apiKey: string,
  query: string,
  limit: number,
): Promise<Array<{ url: string; description: string }>> => {
  const res = await fetchWithDeadline(TAVILY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      // Tavily's image count is decoupled from `max_results`; cap on the
      // client side after the response.
      max_results: Math.max(limit, 5),
      include_images: true,
      include_image_descriptions: true,
    }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Tavily HTTP ${res.status}`);
  }
  const text = await readBodyCapped(res, SEARCH_RESPONSE_MAX_BYTES);
  const parsed = JSON.parse(text) as TavilyImagesResponse;
  const raw = parsed.images ?? [];
  const out: Array<{ url: string; description: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= limit) break;
    let url = "";
    let description = "";
    if (typeof item === "string") {
      url = item;
    } else if (item && typeof item === "object") {
      url = item.url ?? "";
      description = item.description ?? "";
    }
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, description });
  }
  return out;
};

const searchImagesSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(10).optional().default(5),
});

export const searchImagesTool = (): Tool =>
  tool({
    description:
      "Search the public web for images matching a query and return their URLs and descriptions. Requires TAVILY_API_KEY (raises an error if unset — there is no DDG fallback for image search). Each result is a public web URL — to attach the picked image to the Slack thread, pass the URL to attach_image_from_url.",
    inputSchema: searchImagesSchema,
    execute: async ({ query, limit }) => {
      const env = getServerEnv();
      if (!env.TAVILY_API_KEY) {
        throw new Error(
          "image search requires TAVILY_API_KEY — set the env var or fall back to a text response describing where the user could look.",
        );
      }
      return tavilyImageSearch(env.TAVILY_API_KEY, query, limit);
    },
  });
