import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  RateLimiter,
  type RateLimitPolicies,
} from "../src/ratelimit/rate-limit.js";
import type { RateLimitStore } from "../src/types/ports.js";
import type { RedirectTarget } from "../src/urls/url.repository.js";
import {
  createMockDatabase,
  createMockRateLimitStore,
  createMockRedis,
  createMockUrlRepository,
  createUrlService,
} from "./helpers.js";

const policies: RateLimitPolicies = {
  createUrl: { name: "create-url", max: 2, windowSeconds: 60 },
  redirect: { name: "redirect", max: 3, windowSeconds: 30 },
};

const target: RedirectTarget = {
  originalUrl: "https://example.com/docs",
  isActive: true,
  isExpired: false,
  expiresAt: null,
  expiresInSeconds: null,
};

describe("rate limiting", () => {
  let app: FastifyInstance | undefined;
  let now = 1_000_000;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    now = 1_000_000;
  });

  async function createApp(
    store: RateLimitStore = createMockRateLimitStore(() => now),
    trustProxy: false | string[] = false,
  ) {
    app = await buildApp({
      db: createMockDatabase(),
      redis: createMockRedis(),
      urlService: createUrlService(
        createMockUrlRepository({ findRedirectTarget: async () => target }),
      ),
      rateLimit: { limiter: new RateLimiter(store, () => now), policies },
      trustProxy,
      logger: false,
    });
    return app;
  }

  const createUrl = (
    instance: FastifyInstance,
    options: { remoteAddress?: string; headers?: Record<string, string> } = {},
  ) =>
    instance.inject({
      method: "POST",
      url: "/api/v1/urls",
      payload: { url: "https://example.com" },
      ...options,
    });

  describe("normal requests", () => {
    it("allows URL creation below the limit and sends rate-limit headers", async () => {
      const instance = await createApp();
      const response = await createUrl(instance);

      expect(response.statusCode).toBe(201);
      expect(response.headers["ratelimit-limit"]).toBe("2");
      expect(response.headers["ratelimit-remaining"]).toBe("1");
      expect(response.headers["ratelimit-reset"]).toBe("60");
      expect(response.headers["retry-after"]).toBeUndefined();
    });

    it("applies the create-url policy to POST /api/v1/urls", async () => {
      const store = createMockRateLimitStore(() => now);
      const instance = await createApp(store);
      await createUrl(instance);

      expect(store.incrementWindow).toHaveBeenCalledWith(
        "scaleurl:ratelimit:create-url:127.0.0.1",
        60_000,
      );
    });

    it("applies the redirect policy to GET /:code", async () => {
      const store = createMockRateLimitStore(() => now);
      const instance = await createApp(store);
      const response = await instance.inject({ method: "GET", url: "/abc" });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://example.com/docs");
      expect(response.headers["ratelimit-limit"]).toBe("3");
      expect(response.headers["ratelimit-reset"]).toBe("30");
      expect(store.incrementWindow).toHaveBeenCalledWith(
        "scaleurl:ratelimit:redirect:127.0.0.1",
        30_000,
      );
    });

    it("keeps separate counters for URL creation and redirects", async () => {
      const instance = await createApp();
      await createUrl(instance);
      await createUrl(instance);
      expect((await createUrl(instance)).statusCode).toBe(429);

      const redirect = await instance.inject({ method: "GET", url: "/abc" });
      expect(redirect.statusCode).toBe(302);
      expect(redirect.headers["ratelimit-remaining"]).toBe("2");
    });

    it.each(["/health/live", "/health/ready"])(
      "does not rate-limit %s",
      async (url) => {
        const store = createMockRateLimitStore(() => now);
        const instance = await createApp(store);

        for (let i = 0; i < 10; i += 1) {
          const response = await instance.inject({ method: "GET", url });
          expect(response.statusCode).toBe(200);
          expect(response.headers["ratelimit-limit"]).toBeUndefined();
        }
        expect(store.incrementWindow).not.toHaveBeenCalled();
      },
    );

    it("is disabled when buildApp receives no rate limiter", async () => {
      app = await buildApp({
        db: createMockDatabase(),
        redis: createMockRedis(),
        urlService: createUrlService(),
        logger: false,
      });

      for (let i = 0; i < 5; i += 1) {
        const response = await createUrl(app);
        expect(response.statusCode).toBe(201);
        expect(response.headers["ratelimit-limit"]).toBeUndefined();
      }
    });
  });

  describe("limit exceeded", () => {
    it("returns 429 with headers, Retry-After and the standard error body", async () => {
      const instance = await createApp();
      await createUrl(instance);
      await createUrl(instance);

      now += 15_500;
      const response = await createUrl(instance);

      expect(response.statusCode).toBe(429);
      expect(response.headers["ratelimit-limit"]).toBe("2");
      expect(response.headers["ratelimit-remaining"]).toBe("0");
      expect(response.headers["ratelimit-reset"]).toBe("45");
      expect(response.headers["retry-after"]).toBe("45");
      expect(response.headers["x-request-id"]).toBeDefined();
      expect(response.json()).toEqual({
        statusCode: 429,
        error: "Too Many Requests",
        message: "Rate limit exceeded. Try again in 45 seconds.",
      });
    });

    it("does not run the route handler for rejected requests", async () => {
      const create = vi.fn(async () => ({
        id: "1",
        code: "1",
        originalUrl: "https://example.com",
        createdAt: new Date(),
      }));
      app = await buildApp({
        db: createMockDatabase(),
        redis: createMockRedis(),
        urlService: createUrlService(createMockUrlRepository({ create })),
        rateLimit: {
          limiter: new RateLimiter(createMockRateLimitStore(() => now)),
          policies,
        },
        logger: false,
      });

      for (let i = 0; i < 4; i += 1) {
        await createUrl(app);
      }
      expect(create).toHaveBeenCalledTimes(2);
    });

    it("allows requests again once the window expires", async () => {
      const instance = await createApp();
      for (let i = 0; i < 3; i += 1) {
        await instance.inject({ method: "GET", url: "/abc" });
      }
      expect((await instance.inject({ method: "GET", url: "/abc" })).statusCode).toBe(429);

      now += 30_000;
      const response = await instance.inject({ method: "GET", url: "/abc" });
      expect(response.statusCode).toBe(302);
      expect(response.headers["ratelimit-remaining"]).toBe("2");
    });

    it("does not let concurrent requests exceed the limit", async () => {
      const instance = await createApp();
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => createUrl(instance)),
      );
      const statuses = responses.map((r) => r.statusCode);

      expect(statuses.filter((s) => s === 201)).toHaveLength(2);
      expect(statuses.filter((s) => s === 429)).toHaveLength(18);
    });
  });

  describe("client identity", () => {
    it("keeps separate counters per client IP", async () => {
      const instance = await createApp();
      await createUrl(instance, { remoteAddress: "203.0.113.1" });
      await createUrl(instance, { remoteAddress: "203.0.113.1" });
      expect(
        (await createUrl(instance, { remoteAddress: "203.0.113.1" })).statusCode,
      ).toBe(429);

      const other = await createUrl(instance, { remoteAddress: "203.0.113.2" });
      expect(other.statusCode).toBe(201);
      expect(other.headers["ratelimit-remaining"]).toBe("1");
    });

    it("treats IPv4-mapped IPv6 and plain IPv4 as one client", async () => {
      const instance = await createApp();
      await createUrl(instance, { remoteAddress: "::ffff:203.0.113.1" });
      await createUrl(instance, { remoteAddress: "203.0.113.1" });
      expect(
        (await createUrl(instance, { remoteAddress: "::ffff:203.0.113.1" })).statusCode,
      ).toBe(429);
    });

    it("ignores X-Forwarded-For by default", async () => {
      const store = createMockRateLimitStore(() => now);
      const instance = await createApp(store);

      for (const forwarded of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
        await createUrl(instance, {
          remoteAddress: "203.0.113.9",
          headers: { "x-forwarded-for": forwarded },
        });
      }

      const keys = store.incrementWindow.mock.calls.map(([key]) => key);
      expect(new Set(keys)).toEqual(
        new Set(["scaleurl:ratelimit:create-url:203.0.113.9"]),
      );
    });

    it("uses X-Forwarded-For only when the peer is a configured trusted proxy", async () => {
      const store = createMockRateLimitStore(() => now);
      const instance = await createApp(store, ["10.0.0.5"]);

      await createUrl(instance, {
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "198.51.100.1" },
      });
      await createUrl(instance, {
        remoteAddress: "203.0.113.9",
        headers: { "x-forwarded-for": "198.51.100.2" },
      });

      expect(store.incrementWindow.mock.calls.map(([key]) => key)).toEqual([
        "scaleurl:ratelimit:create-url:198.51.100.1",
        "scaleurl:ratelimit:create-url:203.0.113.9",
      ]);
    });

    it("does not let a client behind a trusted proxy spoof extra hops", async () => {
      const store = createMockRateLimitStore(() => now);
      const instance = await createApp(store, ["10.0.0.5"]);

      await createUrl(instance, {
        remoteAddress: "10.0.0.5",
        headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.1" },
      });

      expect(store.incrementWindow).toHaveBeenCalledWith(
        "scaleurl:ratelimit:create-url:198.51.100.1",
        60_000,
      );
    });
  });

  describe("Redis failure", () => {
    const failingStore: RateLimitStore = {
      incrementWindow: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379 (redis internals)");
      },
    };

    it("fails open for URL creation without rate-limit headers", async () => {
      const instance = await createApp(failingStore);

      for (let i = 0; i < 5; i += 1) {
        const response = await createUrl(instance);
        expect(response.statusCode).toBe(201);
        expect(response.headers["ratelimit-limit"]).toBeUndefined();
        expect(response.body).not.toMatch(/ECONNREFUSED|redis|6379/i);
      }
    });

    it("fails open for redirects", async () => {
      const instance = await createApp(failingStore);

      for (let i = 0; i < 5; i += 1) {
        const response = await instance.inject({ method: "GET", url: "/abc" });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe("https://example.com/docs");
      }
    });
  });
});
