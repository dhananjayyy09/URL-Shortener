import type { UrlRepository } from "./url.repository.js";

export interface ShortUrl {
  code: string;
  originalUrl: string;
  shortUrl: string;
  createdAt: string;
}

export class UrlService {
  constructor(
    private readonly repository: Pick<UrlRepository, "create">,
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
}
