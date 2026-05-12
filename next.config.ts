import bundleAnalyzer from "@next/bundle-analyzer";
import type { NextConfig } from "next";

// CSP for the document HTML (and only the document — image/font/etc. routes
// inherit the global headers below). Kept conservative so it doesn't break
// Tailwind / Better Auth / Pretendard out of the box. Tighten before going
// production-strict (drop 'unsafe-inline' from script-src and use a nonce).
//
// Violations are POSTed to /api/csp-report which logs them via the structured
// logger. Both `report-uri` (Level 2, widely supported) and `report-to`
// (Reporting API, modern Chromium/Firefox) are emitted.
const CSP_REPORT_PATH = "/api/csp-report";
const REPORT_TO_GROUP = "csp-endpoint";

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  // Allow Upstash REST and any custom Better Auth origins. Extend as needed.
  "connect-src 'self' https://*.upstash.io",
  "upgrade-insecure-requests",
  `report-uri ${CSP_REPORT_PATH}`,
  `report-to ${REPORT_TO_GROUP}`,
].join("; ");

const reportTo = JSON.stringify({
  group: REPORT_TO_GROUP,
  max_age: 10_886_400,
  endpoints: [{ url: CSP_REPORT_PATH }],
});

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "Report-To", value: reportTo },
  // Report-Only first; flip the header name to "Content-Security-Policy" once
  // you've verified nothing in your own deployment violates it.
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

export default withBundleAnalyzer(nextConfig);
