import type { DatabasePort, RedisPort } from "../src/types/ports.js";
import type { CreatedUrl, UrlRepository } from "../src/urls/url.repository.js";
import { UrlService } from "../src/urls/url.service.js";

export const TEST_PUBLIC_BASE_URL = "http://localhost:3000";

export function createMockDatabase(healthy = true): DatabasePort {
  return {
    ping: async () => healthy,
    close: async () => undefined,
  };
}

export function createMockRedis(healthy = true): RedisPort {
  return {
    ping: async () => healthy,
    close: async () => undefined,
  };
}

export type UrlRepositoryStub = Pick<
  UrlRepository,
  "create" | "findRedirectTarget"
>;

export function createMockUrlRepository(
  overrides: Partial<UrlRepositoryStub> = {},
): UrlRepositoryStub {
  return {
    create: async (originalUrl: string): Promise<CreatedUrl> => ({
      id: "125",
      code: "21",
      originalUrl,
      createdAt: new Date("2026-11-21T10:00:00.000Z"),
    }),
    findRedirectTarget: async () => null,
    ...overrides,
  };
}

export function createUrlService(
  repository: UrlRepositoryStub = createMockUrlRepository(),
): UrlService {
  return new UrlService(repository, TEST_PUBLIC_BASE_URL);
}
