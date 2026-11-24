import { config as loadDotenv } from "dotenv";
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
  URL_CACHE_TTL_SECONDS: z.preprocess(
    (value) => (value === undefined || value === "" ? 300 : value),
    z.coerce
      .number({ error: "URL_CACHE_TTL_SECONDS must be a positive integer" })
      .int("URL_CACHE_TTL_SECONDS must be a positive integer")
      .positive("URL_CACHE_TTL_SECONDS must be a positive integer"),
  ),
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
