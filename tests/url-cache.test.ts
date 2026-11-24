import { describe, expect, it, vi } from "vitest";
import {
  URL_CACHE_KEY_PREFIX,
  UrlCache,
  urlCacheKey,
  type CachedRedirect,
} from "../src/urls/url.cache.js";
import { createMockCacheStore } from "./helpers.js";

const NOW = Date.parse("2026-11-24T12:00:00.000Z");

function entry(overrides: Partial<CachedRedirect> = {}): CachedRedirect {
  return {
    originalUrl: "https://example.com/path",
    isActive: true,
    expiresAt: null,
    ...overrides,
  };
}

function createLog() {
  return { warn: vi.fn() };
}

describe("urlCacheKey", () => {
  it("namespaces keys by short code", () => {
    expect(URL_CACHE_KEY_PREFIX).toBe("scaleurl:url:");
    expect(urlCacheKey("abc123")).toBe("scaleurl:url:abc123");
  });
});

describe("UrlCache", () => {
  it("round-trips a cached mapping as JSON", async () => {
    const store = createMockCacheStore();
    const cache = new UrlCache(store, 300, () => NOW);
    const log = createLog();
    const value = entry({ expiresAt: "2026-11-24T12:05:00.000Z" });

    await cache.set("abc", value, 300, log);

    expect(store.set).toHaveBeenCalledWith(
      "scaleurl:url:abc",
      JSON.stringify(value),
      300,
    );
    await expect(cache.get("abc", log)).resolves.toEqual(value);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns null on a miss", async () => {
    const cache = new UrlCache(createMockCacheStore(), 300);
    await expect(cache.get("abc", createLog())).resolves.toBeNull();
  });

  describe("TTL", () => {
    const cache = new UrlCache(createMockCacheStore(), 300);

    it("uses the configured TTL for URLs without an expiration", () => {
      expect(cache.ttlFor(null)).toBe(300);
    });

    it("uses the configured TTL when the URL expires later", () => {
      expect(cache.ttlFor(3_600)).toBe(300);
    });

    it("shortens the TTL to the URL's remaining lifetime", () => {
      expect(cache.ttlFor(60.9)).toBe(60);
    });

    it("does not cache URLs with less than one second left", async () => {
      const store = createMockCacheStore();
      const shortCache = new UrlCache(store, 300);

      await shortCache.set("abc", entry(), 0.5, createLog());
      await shortCache.set("abc", entry(), -10, createLog());

      expect(store.set).not.toHaveBeenCalled();
    });
  });

  describe("usability", () => {
    const cache = new UrlCache(createMockCacheStore(), 300, () => NOW);

    it("accepts active entries without or before expiration", () => {
      expect(cache.isUsable(entry())).toBe(true);
      expect(
        cache.isUsable(entry({ expiresAt: "2026-11-24T12:00:01.000Z" })),
      ).toBe(true);
    });

    it("rejects expired or inactive entries", () => {
      expect(
        cache.isUsable(entry({ expiresAt: "2026-11-24T12:00:00.000Z" })),
      ).toBe(false);
      expect(cache.isUsable(entry({ isActive: false }))).toBe(false);
    });
  });

  describe("malformed entries", () => {
    it.each([
      ["invalid JSON", "{not json"],
      ["a non-object", JSON.stringify("https://example.com")],
      ["a missing field", JSON.stringify({ originalUrl: "https://example.com", isActive: true })],
      ["a wrong type", JSON.stringify({ ...entry(), isActive: "yes" })],
      ["a non-http URL", JSON.stringify({ ...entry(), originalUrl: "javascript:alert(1)" })],
      ["an invalid date", JSON.stringify({ ...entry(), expiresAt: "soon" })],
    ])("treats %s as a miss and logs it", async (_label, raw) => {
      const cache = new UrlCache(
        createMockCacheStore({ "scaleurl:url:abc": raw }),
        300,
      );
      const log = createLog();

      await expect(cache.get("abc", log)).resolves.toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        { cacheKey: "scaleurl:url:abc" },
        "ignoring malformed URL cache entry",
      );
    });
  });

  describe("Redis failures", () => {
    it("treats GET failures as a miss without throwing", async () => {
      const store = createMockCacheStore();
      store.get.mockRejectedValue(new Error("Connection is closed."));
      const log = createLog();

      await expect(new UrlCache(store, 300).get("abc", log)).resolves.toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "get", error: "Connection is closed." }),
        "URL cache unavailable; falling back to PostgreSQL",
      );
    });

    it("swallows SET failures", async () => {
      const store = createMockCacheStore();
      store.set.mockRejectedValue(new Error("Command timed out"));
      const log = createLog();

      await expect(
        new UrlCache(store, 300).set("abc", entry(), null, log),
      ).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "set" }),
        "URL cache unavailable; falling back to PostgreSQL",
      );
    });

    it("throttles repeated failure logs", async () => {
      let now = NOW;
      const store = createMockCacheStore();
      store.get.mockRejectedValue(new Error("down"));
      const cache = new UrlCache(store, 300, () => now);
      const log = createLog();

      await cache.get("a", log);
      await cache.get("b", log);
      await cache.get("c", log);
      expect(log.warn).toHaveBeenCalledTimes(1);

      now += 30_000;
      await cache.get("d", log);
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ suppressedSinceLastLog: 2 }),
        expect.any(String),
      );
    });

    it("redacts credentials in logged errors", async () => {
      const store = createMockCacheStore();
      store.get.mockRejectedValue(
        new Error("connect failed redis://user:secret@redis:6379"),
      );
      const log = createLog();

      await new UrlCache(store, 300).get("abc", log);

      expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret");
    });
  });
});
