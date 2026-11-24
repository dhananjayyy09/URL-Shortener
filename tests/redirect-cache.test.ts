import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { UrlCache, type CachedRedirect } from "../src/urls/url.cache.js";
import type { RedirectTarget } from "../src/urls/url.repository.js";
import {
  createMockCacheStore,
  createMockDatabase,
  createMockRedis,
  createMockUrlRepository,
  createUrlService,
} from "./helpers.js";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const KEY = "scaleurl:url:abc";

function target(overrides: Partial<RedirectTarget> = {}): RedirectTarget {
  return {
    originalUrl: "https://example.com/from-db",
    isActive: true,
    isExpired: false,
    expiresAt: null,
    expiresInSeconds: null,
    ...overrides,
  };
}

function cached(overrides: Partial<CachedRedirect> = {}): string {
  return JSON.stringify({
    originalUrl: "https://example.com/from-cache",
    isActive: true,
    expiresAt: null,
    ...overrides,
  });
}

describe("GET /:code with the Redis URL cache", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function createApp(options: {
    lookup?: (code: string) => Promise<RedirectTarget | null>;
    initial?: Record<string, string>;
    ttlSeconds?: number;
  } = {}) {
    const lookup = vi.fn(options.lookup ?? (async () => target()));
    const store = createMockCacheStore(options.initial);
    const cache = new UrlCache(store, options.ttlSeconds ?? 300, () => NOW);
    app = await buildApp({
      db: createMockDatabase(),
      redis: createMockRedis(),
      urlService: createUrlService(
        createMockUrlRepository({ findRedirectTarget: lookup }),
        cache,
      ),
      logger: false,
    });
    const get = (url = "/abc") => app!.inject({ method: "GET", url });
    return { get, lookup, store };
  }

  describe("cache hit", () => {
    it("redirects from Redis without querying PostgreSQL", async () => {
      const { get, lookup, store } = await createApp({
        initial: { [KEY]: cached() },
      });

      const response = await get();

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://example.com/from-cache");
      expect(store.get).toHaveBeenCalledWith(KEY);
      expect(lookup).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
    });
  });

  describe("cache miss", () => {
    it("queries PostgreSQL, caches the mapping with the configured TTL and redirects", async () => {
      const { get, lookup, store } = await createApp({ ttlSeconds: 120 });

      const response = await get();

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://example.com/from-db");
      expect(lookup).toHaveBeenCalledWith("abc");
      expect(store.set).toHaveBeenCalledWith(
        KEY,
        JSON.stringify({
          originalUrl: "https://example.com/from-db",
          isActive: true,
          expiresAt: null,
        }),
        120,
      );
    });

    it("serves the second request from Redis", async () => {
      const { get, lookup } = await createApp();

      await get();
      const second = await get();

      expect(second.statusCode).toBe(302);
      expect(second.headers.location).toBe("https://example.com/from-db");
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("shortens the TTL when the URL expires sooner", async () => {
      const expiresAt = new Date(NOW + 60_000);
      const { get, store } = await createApp({
        lookup: async () => target({ expiresAt, expiresInSeconds: 60.4 }),
      });

      await get();

      expect(store.set).toHaveBeenCalledWith(
        KEY,
        JSON.stringify({
          originalUrl: "https://example.com/from-db",
          isActive: true,
          expiresAt: expiresAt.toISOString(),
        }),
        60,
      );
    });

    const uncacheable: Array<
      [string, () => Promise<RedirectTarget | null>, number]
    > = [
      ["unknown codes", async () => null, 404],
      ["inactive URLs", async () => target({ isActive: false }), 404],
      ["expired URLs", async () => target({ isExpired: true, expiresInSeconds: -5 }), 410],
    ];

    it.each(uncacheable)("does not cache %s", async (_label, lookup, status) => {
      const { get, store } = await createApp({ lookup });

      const response = await get();

      expect(response.statusCode).toBe(status);
      expect(store.set).not.toHaveBeenCalled();
    });

    it("does not cache database failures", async () => {
      const { get, store } = await createApp({
        lookup: async () => {
          throw new Error("connection terminated");
        },
      });

      const response = await get();

      expect(response.statusCode).toBe(500);
      expect(store.set).not.toHaveBeenCalled();
    });

    it("skips Redis entirely for malformed codes", async () => {
      const { get, store, lookup } = await createApp();

      const response = await get("/not-base62!");

      expect(response.statusCode).toBe(404);
      expect(store.get).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe("cached expiration", () => {
    it("does not redirect from an expired cached entry and does not re-cache it", async () => {
      const { get, lookup, store } = await createApp({
        initial: { [KEY]: cached({ expiresAt: new Date(NOW - 1_000).toISOString() }) },
        lookup: async () =>
          target({
            isExpired: true,
            expiresAt: new Date(NOW - 1_000),
            expiresInSeconds: -1,
          }),
      });

      const response = await get();

      expect(response.statusCode).toBe(410);
      expect(response.headers.location).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(store.set).not.toHaveBeenCalled();
    });

    it("re-checks PostgreSQL for a cached inactive entry", async () => {
      const { get, lookup } = await createApp({
        initial: { [KEY]: cached({ isActive: false }) },
        lookup: async () => target({ isActive: false }),
      });

      const response = await get();

      expect(response.statusCode).toBe(404);
      expect(lookup).toHaveBeenCalledTimes(1);
    });
  });

  describe("Redis failures", () => {
    it("falls back to PostgreSQL when GET fails", async () => {
      const { get, lookup, store } = await createApp();
      store.get.mockRejectedValue(new Error("Connection is closed."));

      const response = await get();

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://example.com/from-db");
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("still redirects when SET fails", async () => {
      const { get, store } = await createApp();
      store.set.mockRejectedValue(new Error("Command timed out"));

      const response = await get();

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://example.com/from-db");
    });

    it("redirects when both GET and SET fail", async () => {
      const { get, store } = await createApp();
      store.get.mockRejectedValue(new Error("down"));
      store.set.mockRejectedValue(new Error("down"));

      const response = await get();

      expect(response.statusCode).toBe(302);
      expect(response.body).not.toContain("down");
    });

    it.each([
      ["malformed JSON", "{oops"],
      ["an invalid structure", JSON.stringify({ originalUrl: 42 })],
    ])("recovers from %s via PostgreSQL and overwrites the entry", async (_label, raw) => {
      const { get, lookup, store } = await createApp({ initial: { [KEY]: raw } });

      const response = await get();

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://example.com/from-db");
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(store.set).toHaveBeenCalledTimes(1);
      expect(JSON.parse(store.entries.get(KEY) ?? "null")).toEqual({
        originalUrl: "https://example.com/from-db",
        isActive: true,
        expiresAt: null,
      });
    });
  });
});
