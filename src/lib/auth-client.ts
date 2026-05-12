"use client";

import { createAuthClient } from "better-auth/react";

import { clientEnv } from "@/lib/env";

const resolveBaseURL = (): string => {
  if (clientEnv.NEXT_PUBLIC_BETTER_AUTH_URL) {
    return clientEnv.NEXT_PUBLIC_BETTER_AUTH_URL;
  }
  if (typeof window !== "undefined") {
    // Browser fallback — works for single-domain deployments. Multi-domain
    // setups (API on a different host than the page) MUST set
    // NEXT_PUBLIC_BETTER_AUTH_URL explicitly, otherwise auth calls land on
    // the wrong origin.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[auth-client] NEXT_PUBLIC_BETTER_AUTH_URL is not set. " +
          "Falling back to window.location.origin. Set it for multi-domain deployments.",
      );
    }
    return window.location.origin;
  }
  // SSR / import-time before hydration (no window). NEXT_PUBLIC_* is inlined
  // at build time, so this path is hit only when the build itself had no
  // value AND something imports this module on the server. Returning a
  // placeholder is safe because the actual auth calls happen in the browser
  // where window.location.origin will resolve correctly above.
  return "http://localhost:3000";
};

export const authClient = createAuthClient({
  baseURL: resolveBaseURL(),
});
