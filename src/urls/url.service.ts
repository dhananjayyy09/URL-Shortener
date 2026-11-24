import type { UrlRepository } from "./url.repository.js";
import { isValidShortCode } from "./url.schema.js";

export interface ShortUrl {
  code: string;
  originalUrl: string;
  shortUrl: string;
  createdAt: string;
}

export type RedirectResolution =
  | { status: "found"; originalUrl: string }
  | { status: "invalid_code" }
  | { status: "not_found" }
  | { status: "inactive" }
  | { status: "expired" };

export class UrlService {
  constructor(
    private readonly repository: Pick<
      UrlRepository,
      "create" | "findRedirectTarget"
    >,
    private readonly publicBaseUrl: string,
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

  async resolveRedirect(code: string): Promise<RedirectResolution> {
    if (!isValidShortCode(code)) {
      return { status: "invalid_code" };
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

    return { status: "found", originalUrl: target.originalUrl };
  }
}
