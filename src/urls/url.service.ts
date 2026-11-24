import type { CacheLogger, UrlCache } from "./url.cache.js";
import type { UrlRepository } from "./url.repository.js";
import { isValidShortCode } from "./url.schema.js";

export interface ShortUrl {
  code: string;
  originalUrl: string;
  shortUrl: string;
  createdAt: string;
}

export type RedirectResolution =
  | { status: "found"; originalUrl: string; source: "cache" | "database" }
  | { status: "invalid_code" }
  | { status: "not_found" }
  | { status: "inactive" }
  | { status: "expired" };

const silentLogger: CacheLogger = { warn: () => undefined };

export class UrlService {
  constructor(
    private readonly repository: Pick<
      UrlRepository,
      "create" | "findRedirectTarget"
    >,
    private readonly publicBaseUrl: string,
    private readonly cache?: UrlCache,
  ) {}

  async createShortUrl(originalUrl: string): Promise<ShortUrl> {
    const created = await this.repository.create(originalUrl);

    return {
      code: created.code,
      originalUrl: created.originalUrl,
      shortUrl: `${this.publicBaseUrl}/${created.code}`,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async resolveRedirect(
    code: string,
    log: CacheLogger = silentLogger,
  ): Promise<RedirectResolution> {
    if (!isValidShortCode(code)) {
      return { status: "invalid_code" };
    }

    // Unusable cached entries (e.g. expired by now) fall through to PostgreSQL.
    const cached = await this.cache?.get(code, log);
    if (cached && this.cache?.isUsable(cached)) {
      return { status: "found", originalUrl: cached.originalUrl, source: "cache" };
    }

    const target = await this.repository.findRedirectTarget(code);

    if (!target) {
      return { status: "not_found" };
    }

    if (!target.isActive) {
      return { status: "inactive" };
    }

    if (target.isExpired) {
      return { status: "expired" };
    }

    await this.cache?.set(
      code,
      {
        originalUrl: target.originalUrl,
        isActive: target.isActive,
        expiresAt: target.expiresAt?.toISOString() ?? null,
      },
      target.expiresInSeconds,
      log,
    );

    return {
      status: "found",
      originalUrl: target.originalUrl,
      source: "database",
    };
  }
}
