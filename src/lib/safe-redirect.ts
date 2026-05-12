/**
 * Resolve a post-auth redirect target.
 *
 * Untrusted input (from query strings) MUST be normalized to an internal path
 * before being passed to `router.push` / Better Auth's `callbackURL`.
 * Otherwise an attacker can craft `/login?redirect=https://evil.example.com`
 * to bounce victims off-origin after they sign in (open redirect → phishing).
 *
 * Accept: paths that start with a single `/`, e.g. `/`, `/dashboard`,
 * `/settings?tab=billing`.
 * Reject: anything else — absolute URLs (`https://…`), protocol-relative
 * (`//host`), backslash variants Windows treats as separators (`/\\host`).
 */
export const safeInternalPath = (input: string | null | undefined, fallback: string): string => {
  if (typeof input !== "string" || input.length === 0) return fallback;
  if (!input.startsWith("/")) return fallback;
  // Block protocol-relative URLs like `//attacker.example.com/…`
  if (input.startsWith("//")) return fallback;
  // Block `/\…` which some browsers normalize to `//…`
  if (input.startsWith("/\\")) return fallback;
  return input;
};
