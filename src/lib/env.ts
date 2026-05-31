import { z } from "zod";

const positiveInt = (min: number, fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return fallback;
      const n = Number.parseInt(v, 10);
      if (Number.isNaN(n) || n < min) return fallback;
      return n;
    });

const httpsUrlOr = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const raw = v?.trim();
      if (!raw) return fallback;
      if (!raw.startsWith("https://")) return fallback;
      return raw;
    });

const trimmedOptional = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : undefined;
  });

const booleanString = (fallback = false) =>
  z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true"));

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters (e.g., openssl rand -base64 32)"),
  BETTER_AUTH_URL: z.string().url().optional(),
  TRUSTED_ORIGINS: z.string().optional(),

  AWS_REGION: z.string().default("ap-northeast-2"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  DYNAMODB_TABLE_NAME: z.string().default("app-main"),
  DYNAMODB_ENDPOINT: z.string().url().optional(),

  S3_BUCKET_NAME: trimmedOptional,
  S3_PREFIX: z.string().default("agent"),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: booleanString(false),

  AWS_SES_FROM: z.string().email().optional(),

  AUTH_EMAIL_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v !== "false"),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),

  // ── Slack channel credential provider (in progress). Per-app secrets live
  // in SSM at `{SLACK_SSM_PREFIX}/{api_app_id}/signing_secret` and `.../bot_token`.
  SLACK_SSM_PREFIX: z.string().default("/nalbam-agent/slack/apps"),
  SLACK_SSM_CACHE_TTL_SECONDS: positiveInt(10, 300),
  // Comma-separated tenant token hashes for the bundled HTTP API channel:
  //   tenant_id:sha256_hex_token,other_tenant:sha256_hex_token
  // Raw bearer tokens must not be stored in env.
  API_CHANNEL_TOKENS: trimmedOptional,
  // Comma-separated email allowlist for the operator UI (under /operator, added
  // later). When unset (default), any Better-Auth-authenticated user passes (an
  // `operator.allowlist_empty` warning is logged). Set in production.
  OPERATOR_ALLOWED_EMAILS: trimmedOptional,

  // ── LLM / agent
  LLM_PROVIDER: z.enum(["openai", "bedrock", "xai", "gemini", "claude"]).default("openai"),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  IMAGE_PROVIDER: z.enum(["openai", "bedrock"]).optional(),
  IMAGE_MODEL: z.string().default("gpt-image-1"),
  OPENAI_API_KEY: trimmedOptional,
  XAI_API_KEY: trimmedOptional,
  XAI_BASE_URL: trimmedOptional,
  GEMINI_API_KEY: trimmedOptional,
  GEMINI_BASE_URL: trimmedOptional,
  CLAUDE_API_KEY: trimmedOptional,
  CLAUDE_BASE_URL: trimmedOptional,
  TAVILY_API_KEY: trimmedOptional,
  AGENT_MAX_STEPS: positiveInt(2, 6),
  MAX_OUTPUT_TOKENS: positiveInt(256, 4096),
  RESPONSE_LANGUAGE: z.enum(["ko", "en"]).default("ko"),
  SYSTEM_MESSAGE: trimmedOptional,
  PERSONA_MESSAGE: trimmedOptional,

  // ── core behavior (channel-agnostic)
  // JSON array of static tenant metadata until the operator UI / doc backend
  // owns tenant configuration.
  AGENT_TENANTS_JSON: trimmedOptional,
  MAX_HISTORY_CHARS: positiveInt(500, 4000),
  MAX_THROTTLE_COUNT: positiveInt(1, 100),

  // ── document / web extraction
  DEFAULT_TIMEZONE: z
    .string()
    .optional()
    .transform((v) => v?.trim() || "Asia/Seoul"),
  MAX_DOC_CHARS: positiveInt(1000, 20_000),
  MAX_DOC_PAGES: positiveInt(1, 50),
  MAX_DOC_BYTES: positiveInt(64 * 1024, 25 * 1024 * 1024),
  MAX_WEB_CHARS: positiveInt(500, 8000),
  MAX_WEB_BYTES: positiveInt(64 * 1024, 2 * 1024 * 1024),
  MAX_WEB_LINKS: positiveInt(0, 20),
  MAX_IMAGE_BYTES: positiveInt(64 * 1024, 10 * 1024 * 1024),
  JINA_READER_BASE: httpsUrlOr("https://r.jina.ai"),
});

const clientSchema = z.object({
  NEXT_PUBLIC_BETTER_AUTH_URL: z.string().url().optional(),
  NEXT_PUBLIC_APP_NAME: z.string().default("nalbam-agent"),
  NEXT_PUBLIC_AUTH_EMAIL_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v !== "false"),
  NEXT_PUBLIC_AUTH_GOOGLE_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;

const formatError = (label: string, error: z.ZodError): never => {
  const issues = error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid ${label} environment variables:\n${issues}`);
};

const parseClient = (): ClientEnv => {
  const result = clientSchema.safeParse({
    NEXT_PUBLIC_BETTER_AUTH_URL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_AUTH_EMAIL_ENABLED: process.env.NEXT_PUBLIC_AUTH_EMAIL_ENABLED,
    NEXT_PUBLIC_AUTH_GOOGLE_ENABLED: process.env.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED,
  });
  if (!result.success) {
    return formatError("client", result.error);
  }
  return result.data;
};

export const clientEnv: ClientEnv = parseClient();

let cachedServerEnv: ServerEnv | undefined;

export const getServerEnv = (): ServerEnv => {
  if (typeof window !== "undefined") {
    throw new Error("getServerEnv() must not be called from the browser.");
  }
  if (cachedServerEnv) {
    return cachedServerEnv;
  }
  const result = serverSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    TRUSTED_ORIGINS: process.env.TRUSTED_ORIGINS,
    AWS_REGION: process.env.AWS_REGION,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    DYNAMODB_TABLE_NAME: process.env.DYNAMODB_TABLE_NAME,
    DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
    S3_BUCKET_NAME: process.env.S3_BUCKET_NAME,
    S3_PREFIX: process.env.S3_PREFIX,
    S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL,
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
    AWS_SES_FROM: process.env.AWS_SES_FROM,
    AUTH_EMAIL_ENABLED: process.env.AUTH_EMAIL_ENABLED,
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
    SLACK_SSM_PREFIX: process.env.SLACK_SSM_PREFIX,
    SLACK_SSM_CACHE_TTL_SECONDS: process.env.SLACK_SSM_CACHE_TTL_SECONDS,
    API_CHANNEL_TOKENS: process.env.API_CHANNEL_TOKENS,
    OPERATOR_ALLOWED_EMAILS: process.env.OPERATOR_ALLOWED_EMAILS,
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_MODEL: process.env.LLM_MODEL,
    IMAGE_PROVIDER: process.env.IMAGE_PROVIDER,
    IMAGE_MODEL: process.env.IMAGE_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
    XAI_BASE_URL: process.env.XAI_BASE_URL,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
    CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
    CLAUDE_BASE_URL: process.env.CLAUDE_BASE_URL,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    AGENT_MAX_STEPS: process.env.AGENT_MAX_STEPS,
    MAX_OUTPUT_TOKENS: process.env.MAX_OUTPUT_TOKENS,
    RESPONSE_LANGUAGE: process.env.RESPONSE_LANGUAGE,
    SYSTEM_MESSAGE: process.env.SYSTEM_MESSAGE,
    PERSONA_MESSAGE: process.env.PERSONA_MESSAGE,
    AGENT_TENANTS_JSON: process.env.AGENT_TENANTS_JSON,
    MAX_HISTORY_CHARS: process.env.MAX_HISTORY_CHARS,
    MAX_THROTTLE_COUNT: process.env.MAX_THROTTLE_COUNT,
    DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE,
    MAX_DOC_CHARS: process.env.MAX_DOC_CHARS,
    MAX_DOC_PAGES: process.env.MAX_DOC_PAGES,
    MAX_DOC_BYTES: process.env.MAX_DOC_BYTES,
    MAX_WEB_CHARS: process.env.MAX_WEB_CHARS,
    MAX_WEB_BYTES: process.env.MAX_WEB_BYTES,
    MAX_WEB_LINKS: process.env.MAX_WEB_LINKS,
    MAX_IMAGE_BYTES: process.env.MAX_IMAGE_BYTES,
    JINA_READER_BASE: process.env.JINA_READER_BASE,
  });
  if (!result.success) {
    return formatError("server", result.error);
  }
  cachedServerEnv = result.data;
  return cachedServerEnv;
};

/** Test-only helper to reset the cached server env between cases. */
export const __resetServerEnvForTests = (): void => {
  cachedServerEnv = undefined;
};

export const trustedOriginsList = (env: ServerEnv): string[] => {
  if (!env.TRUSTED_ORIGINS) return [];
  return env.TRUSTED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
};
