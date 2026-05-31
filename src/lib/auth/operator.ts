/**
 * Operator-role gate for the (future) operator UI.
 *
 * Resolution: when `OPERATOR_ALLOWED_EMAILS` env is set (CSV), only emails on
 * the list pass. When the env is unset, any Better-Auth-authenticated user
 * passes (with an `operator.allowlist_empty` warning so the operator knows the
 * UI is wide-open). This lets a fresh install bootstrap with the first sign-up
 * while making it trivial to lock down for production.
 */
import { getServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

const parseAllowedEmails = (raw: string | undefined): string[] => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
};

export interface SessionUserShape {
  id?: string;
  email?: string | null;
}

export interface OperatorCheckResult {
  allowed: boolean;
  /** True when the env allowlist is empty — UI is wide-open. */
  unrestricted: boolean;
}

export const isOperatorAllowed = (
  user: SessionUserShape | null | undefined,
): OperatorCheckResult => {
  const allowed = parseAllowedEmails(getServerEnv().OPERATOR_ALLOWED_EMAILS);
  if (allowed.length === 0) {
    logger.warn("operator.allowlist_empty", { userId: user?.id });
    // Empty env = open mode. Still require authentication (handled upstream).
    return { allowed: Boolean(user), unrestricted: true };
  }
  const email = (user?.email ?? "").toLowerCase();
  return { allowed: !!email && allowed.includes(email), unrestricted: false };
};
