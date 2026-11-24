import { config as loadDotenv } from "dotenv";
import { isIP } from "node:net";
import { z } from "zod";

const logLevels = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

const databaseUrlSchema = z
  .string({ error: "DATABASE_URL is required" })
  .min(1, "DATABASE_URL is required")
  .url("DATABASE_URL must be a valid URL");

const publicBaseUrlSchema = z
  .string({ error: "PUBLIC_BASE_URL is required" })
  .min(1, "PUBLIC_BASE_URL is required")
  .url("PUBLIC_BASE_URL must be a valid URL")
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.search === "" &&
      url.hash === ""
    );
  }, "PUBLIC_BASE_URL must be an http(s) URL without a query string or fragment")
  .refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  }, "PUBLIC_BASE_URL must not contain credentials")
  .transform((value) => value.replace(/\/+$/, ""));

function positiveInt(name: string, defaultValue: number) {
  const message = `${name} must be a positive integer`;
  return z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : value),
    z.coerce.number({ error: message }).int(message).positive(message),
  );
}

const PROXY_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

function isTrustedProxyEntry(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry)) {
    return true;
  }

  const [address, prefix, ...rest] = entry.split("/");
  // Fastify's proxy parser accepts only alphanumeric zone IDs (fe80::1%eth0).
  const zone = address?.split("%")[1];
  const version =
    address && (zone === undefined || /^[0-9a-z]+$/i.test(zone))
      ? isIP(address)
      : 0;
  if (version === 0 || rest.length > 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!/^\d{1,3}$/.test(prefix)) {
    return false;
  }

  const bits = Number(prefix);
  return bits >= 1 && bits <= (version === 4 ? 32 : 128);
}

// Only explicit proxy addresses are trusted; "true", hop counts and /0 ranges
// would let any client choose its own rate-limit identity via X-Forwarded-For.
const trustProxySchema = z
  .string()
  .optional()
  .transform((value, ctx): false | string[] => {
    const trimmed = value?.trim() ?? "";
    if (trimmed === "" || trimmed.toLowerCase() === "false") {
      return false;
    }

    const entries = trimmed.split(",").map((entry) => entry.trim().toLowerCase());
    if (entries.some((entry) => !isTrustedProxyEntry(entry))) {
      ctx.addIssue({
        code: "custom",
        message:
          "TRUST_PROXY must be false or a comma-separated list of proxy IPs, CIDR ranges (prefix 1 or more), loopback, linklocal or uniquelocal",
      });
      return z.NEVER;
    }
    return entries;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.preprocess((value) => {
    if (value === undefined || value === "") {
      return 3000;
    }
    return value;
  }, z.coerce.number().int().min(1).max(65535)),
  DATABASE_URL: databaseUrlSchema,
  REDIS_URL: z
    .string({ error: "REDIS_URL is required" })
    .min(1, "REDIS_URL is required")
    .url("REDIS_URL must be a valid URL"),
  PUBLIC_BASE_URL: publicBaseUrlSchema,
  URL_CACHE_TTL_SECONDS: positiveInt("URL_CACHE_TTL_SECONDS", 300),
  CREATE_URL_RATE_LIMIT_MAX: positiveInt("CREATE_URL_RATE_LIMIT_MAX", 20),
  CREATE_URL_RATE_LIMIT_WINDOW_SECONDS: positiveInt(
    "CREATE_URL_RATE_LIMIT_WINDOW_SECONDS",
    60,
  ),
  REDIRECT_RATE_LIMIT_MAX: positiveInt("REDIRECT_RATE_LIMIT_MAX", 120),
  REDIRECT_RATE_LIMIT_WINDOW_SECONDS: positiveInt(
    "REDIRECT_RATE_LIMIT_WINDOW_SECONDS",
    60,
  ),
  TRUST_PROXY: trustProxySchema,
  LOG_LEVEL: z.enum(logLevels).default("info"),
});

const databaseEnvSchema = z.object({ DATABASE_URL: databaseUrlSchema });

export type Env = z.infer<typeof envSchema>;

export function loadLocalEnv(): void {
  if (process.env.NODE_ENV === "production") {
    return;
  }

  loadDotenv({ override: false, quiet: true });
}

function redactSecrets(
  message: string,
  source: NodeJS.Dict<string>,
): string {
  let redacted = message;
  const candidates = [source.DATABASE_URL, source.REDIS_URL].filter(
    (value): value is string => Boolean(value),
  );

  for (const candidate of candidates) {
    redacted = redacted.split(candidate).join("[redacted]");
  }

  return redacted.replace(/:\/\/([^/\s]+)@/g, "://[redacted]@");
}

function parseWith<T extends z.ZodType>(
  schema: T,
  source: NodeJS.Dict<string>,
): z.infer<T> {
  const result = schema.safeParse(source);

  if (result.success) {
    return result.data;
  }

  const details = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "environment";
      return `${path}: ${issue.message}`;
    })
    .join("\n");

  throw new Error(
    redactSecrets(`Invalid environment configuration:\n${details}`, source),
  );
}

export function parseEnv(source: NodeJS.Dict<string>): Env {
  return parseWith(envSchema, source);
}

export function parseDatabaseEnv(
  source: NodeJS.Dict<string>,
): z.infer<typeof databaseEnvSchema> {
  return parseWith(databaseEnvSchema, source);
}
