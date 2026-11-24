import { vi } from "vitest";
import type {
  CacheStore,
  DatabasePort,
  RedisPort,
} from "../src/types/ports.js";
import type { UrlCache } from "../src/urls/url.cache.js";
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
  cache?: UrlCache,
): UrlService {
  return new UrlService(repository, TEST_PUBLIC_BASE_URL, cache);
}

export function createMockCacheStore(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const store = {
    entries,
    get: vi.fn(async (key: string) => entries.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ttlSeconds: number) => {
      entries.set(key, value);
    }),
  } satisfies CacheStore & { entries: Map<string, string> };
  return store;
}
