import { z } from "zod";

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

  REDIS_URL: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  AWS_SES_FROM: z.string().email().optional(),

  AUTH_EMAIL_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v !== "false"),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
});

const clientSchema = z.object({
  NEXT_PUBLIC_BETTER_AUTH_URL: z.string().url().optional(),
  NEXT_PUBLIC_APP_NAME: z.string().default("Next.js Tailwind Starter"),
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
    REDIS_URL: process.env.REDIS_URL,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    AWS_SES_FROM: process.env.AWS_SES_FROM,
    AUTH_EMAIL_ENABLED: process.env.AUTH_EMAIL_ENABLED,
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
  });
  if (!result.success) {
    return formatError("server", result.error);
  }
  cachedServerEnv = result.data;
  return cachedServerEnv;
};

export const trustedOriginsList = (env: ServerEnv): string[] => {
  if (!env.TRUSTED_ORIGINS) return [];
  return env.TRUSTED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
};
