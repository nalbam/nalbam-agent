/**
 * CSP violation receiver.
 *
 * Browsers POST violation reports here when `Content-Security-Policy` (or
 * `Content-Security-Policy-Report-Only`) is configured with `report-uri` and
 * `report-to`. Reports arrive as JSON with one of two shapes:
 *
 *  - Level 2 (`report-uri`):  { "csp-report": { ... } }
 *  - Reporting API (`report-to`): [{ "type": "csp-violation", "body": { ... } }]
 *
 * The endpoint is publicly reachable (browsers send reports without auth), so
 * we apply two layers of abuse mitigation:
 *
 *   1. Content-Type gate — only accept the MIME types real browsers use.
 *      Anything else (`text/plain`, `application/x-www-form-urlencoded`, …)
 *      is dropped at 415 before we parse.
 *   2. IP-keyed rate limit via Better Auth's secondaryStorage when configured.
 *      A misbehaving client (or attacker spraying reports) is throttled at
 *      60 events per minute per IP. Without KV (local dev), we degrade to
 *      "log everything" so the receiver remains useful.
 */

import { NextResponse, type NextRequest } from "next/server";

import { hasSecondaryStorage, secondaryStorage } from "@/lib/auth/secondary-storage";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16_384;
const REPORT_CONTENT_TYPES = [
  "application/csp-report",
  "application/reports+json",
  "application/json",
];
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;

const isAcceptedContentType = (header: string | null): boolean => {
  if (!header) return false;
  const mime = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return REPORT_CONTENT_TYPES.includes(mime);
};

const clientIp = (request: NextRequest): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",", 1)[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
};

const allowByRateLimit = async (ip: string): Promise<boolean> => {
  if (!hasSecondaryStorage()) return true;
  const key = `csp-report:${ip}`;
  try {
    // Better Auth's SecondaryStorage.get returns string | object | null; the
    // counter is always a stringified number, so guard on typeof string.
    const current = await secondaryStorage.get(key);
    const count = typeof current === "string" ? Number.parseInt(current, 10) : 0;
    if (Number.isFinite(count) && count >= RATE_LIMIT) return false;
    await secondaryStorage.set(key, String(count + 1), RATE_WINDOW_SECONDS);
    return true;
  } catch {
    // KV transient failure — fail-open so we don't lose reports.
    return true;
  }
};

export async function POST(request: NextRequest) {
  if (!isAcceptedContentType(request.headers.get("content-type"))) {
    return new NextResponse(null, { status: 415 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  if (!(await allowByRateLimit(clientIp(request)))) {
    return new NextResponse(null, { status: 429 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  logger.warn("csp.violation", {
    userAgent: request.headers.get("user-agent") ?? undefined,
    report: payload,
  });

  return new NextResponse(null, { status: 204 });
}
