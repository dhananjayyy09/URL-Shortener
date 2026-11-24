import { z } from "zod";
import type { CacheStore } from "../types/ports.js";
import { redactErrorMessage } from "../utils/redact.js";
import { ThrottledWarning, type WarnLogger } from "../utils/throttled-warning.js";
import { MAX_URL_LENGTH } from "./url.schema.js";

export const URL_CACHE_KEY_PREFIX = "scaleurl:url:";

export function urlCacheKey(code: string): string {
  return `${URL_CACHE_KEY_PREFIX}${code}`;
}

export interface CachedRedirect {
  originalUrl: string;
  isActive: boolean;
  expiresAt: string | null;
}

export type CacheLogger = WarnLogger;

const ERROR_LOG_INTERVAL_MS = 30_000;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const cachedRedirectSchema = z.object({
  originalUrl: z.string().min(1).max(MAX_URL_LENGTH).refine(isHttpUrl),
  isActive: z.boolean(),
  expiresAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)))
    .nullable(),
});

function parseEntry(raw: string): CachedRedirect | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = cachedRedirectSchema.safeParse(data);
  return result.success ? result.data : null;
}

// Redis is an optimization: every failure is logged (throttled) and reported as a miss.
export class UrlCache {
  private readonly errorLog: ThrottledWarning;

  constructor(
    private readonly store: CacheStore,
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {
    this.errorLog = new ThrottledWarning(
      "URL cache unavailable; falling back to PostgreSQL",
      ERROR_LOG_INTERVAL_MS,
      now,
    );
  }

  async get(code: string, log: CacheLogger): Promise<CachedRedirect | null> {
    const key = urlCacheKey(code);
    let raw: string | null;

    try {
      raw = await this.store.get(key);
    } catch (error) {
      this.logError(log, "get", error);
      return null;
    }

    if (raw === null) {
      return null;
    }

    const entry = parseEntry(raw);
    if (!entry) {
      log.warn({ cacheKey: key }, "ignoring malformed URL cache entry");
    }
    return entry;
  }

  async set(
    code: string,
    entry: CachedRedirect,
    expiresInSeconds: number | null,
    log: CacheLogger,
  ): Promise<void> {
    const ttl = this.ttlFor(expiresInSeconds);
    if (ttl < 1) {
      return;
    }

    try {
      await this.store.set(urlCacheKey(code), JSON.stringify(entry), ttl);
    } catch (error) {
      this.logError(log, "set", error);
    }
  }

  // The cache TTL never outlives the URL itself.
  ttlFor(expiresInSeconds: number | null): number {
    if (expiresInSeconds === null) {
      return this.ttlSeconds;
    }
    return Math.min(this.ttlSeconds, Math.floor(expiresInSeconds));
  }

  isUsable(entry: CachedRedirect): boolean {
    return (
      entry.isActive &&
      (entry.expiresAt === null || Date.parse(entry.expiresAt) > this.now())
    );
  }

  private logError(log: CacheLogger, operation: string, error: unknown): void {
    this.errorLog.log(log, { operation, error: redactErrorMessage(error) });
  }
}
