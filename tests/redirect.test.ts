import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { RedirectTarget } from "../src/urls/url.repository.js";
import {
  createMockDatabase,
  createMockRedis,
  createMockUrlRepository,
  createUrlService,
} from "./helpers.js";

function target(overrides: Partial<RedirectTarget> = {}): RedirectTarget {
  return {
    originalUrl: "https://example.com/some/long/path",
    isActive: true,
    isExpired: false,
    expiresAt: null,
    expiresInSeconds: null,
    ...overrides,
  };
}

describe("GET /:code", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function createApp(
    findRedirectTarget: (code: string) => Promise<RedirectTarget | null>,
  ) {
    const lookup = vi.fn(findRedirectTarget);
    app = await buildApp({
      db: createMockDatabase(),
      redis: createMockRedis(),
      urlService: createUrlService(
        createMockUrlRepository({ findRedirectTarget: lookup }),
      ),
      logger: false,
    });
    return { server: app, lookup };
  }

  describe("redirect success", () => {
    it("redirects an active code with 302 to the stored URL", async () => {
      const { server, lookup } = await createApp(async () => target());

      const response = await server.inject({ method: "GET", url: "/abc123" });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        "https://example.com/some/long/path",
      );
      expect(lookup).toHaveBeenCalledWith("abc123");
    });

    it("preserves paths, query strings and fragments", async () => {
      const originalUrl =
        "https://example.com/a/b/c.html?utm_source=x&q=%20encoded&arr[]=1#section-2";
      const { server } = await createApp(async () => target({ originalUrl }));

      const response = await server.inject({ method: "GET", url: "/Zz9" });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(originalUrl);
    });

    it("ignores query strings on the short URL and uses only the stored destination", async () => {
      const { server, lookup } = await createApp(async () => target());

      const response = await server.inject({
        method: "GET",
        url: "/abc123?next=https://evil.example&url=https://evil.example",
      });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        "https://example.com/some/long/path",
      );
      expect(lookup).toHaveBeenCalledWith("abc123");
    });

    it("serializes non-ASCII destinations as Punycode hosts and percent-encoded paths", async () => {
      const { server } = await createApp(async () =>
        target({ originalUrl: "https://例え.jp/パス?q=ü" }),
      );

      const response = await server.inject({ method: "GET", url: "/abc" });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        "https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9?q=%C3%BC",
      );
    });

    it("adds the authority delimiter for destinations stored without '//'", async () => {
      const { server } = await createApp(async () =>
        target({ originalUrl: "http:example.com/docs" }),
      );

      const response = await server.inject({ method: "GET", url: "/abc" });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("http://example.com/docs");
    });
  });

  describe("invalid and missing codes", () => {
    it("returns 404 for an unknown code", async () => {
      const { server } = await createApp(async () => null);

      const response = await server.inject({ method: "GET", url: "/unknown1" });

      expect(response.statusCode).toBe(404);
      expect(response.headers.location).toBeUndefined();
      expect(response.json()).toEqual({
        statusCode: 404,
        error: "Not Found",
        message: "Short URL not found",
      });
    });

    it("returns 404 for an empty code without querying", async () => {
      const { server, lookup } = await createApp(async () => target());

      const response = await server.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(404);
      expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
      ["/abc-123"],
      ["/abc_123"],
      ["/abc%20123"],
      ["/%27%3B%20DROP%20TABLE%20urls%3B--"],
      ["/caf%C3%A9"],
      ["/abc.def"],
    ])(
      "returns 404 for non-Base62 code %s without querying",
      async (url) => {
        const { server, lookup } = await createApp(async () => target());

        const response = await server.inject({ method: "GET", url });

        expect(response.statusCode).toBe(404);
        expect(response.headers.location).toBeUndefined();
        expect(response.json()).toEqual({
          statusCode: 404,
          error: "Not Found",
          message: "Short URL not found",
        });
        expect(lookup).not.toHaveBeenCalled();
      },
    );

    it("accepts a 16-character code and rejects a 17-character code", async () => {
      const { server, lookup } = await createApp(async () => target());

      const ok = await server.inject({ method: "GET", url: `/${"a".repeat(16)}` });
      expect(ok.statusCode).toBe(302);

      const tooLong = await server.inject({
        method: "GET",
        url: `/${"a".repeat(17)}`,
      });
      expect(tooLong.statusCode).toBe(404);
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("rejects paths longer than Fastify's maxParamLength with 414", async () => {
      const { server, lookup } = await createApp(async () => target());

      const response = await server.inject({
        method: "GET",
        url: `/${"a".repeat(500)}`,
      });

      expect(response.statusCode).toBe(414);
      expect(response.headers.location).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    });

    it("does not match multi-segment paths", async () => {
      const { server, lookup } = await createApp(async () => target());

      const response = await server.inject({ method: "GET", url: "/abc/def" });

      expect(response.statusCode).toBe(404);
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe("URL state", () => {
    it("returns 404 for an inactive URL", async () => {
      const { server } = await createApp(async () =>
        target({ isActive: false }),
      );

      const response = await server.inject({ method: "GET", url: "/abc" });

      expect(response.statusCode).toBe(404);
      expect(response.headers.location).toBeUndefined();
      expect(response.json().message).toBe("Short URL not found");
    });

    it("returns 404 for a URL that is both inactive and expired", async () => {
      const { server } = await createApp(async () =>
        target({ isActive: false, isExpired: true }),
      );

      const response = await server.inject({ method: "GET", url: "/abc" });

      expect(response.statusCode).toBe(404);
    });

    it("returns 410 for an expired URL", async () => {
      const { server } = await createApp(async () =>
        target({ isExpired: true }),
      );

      const response = await server.inject({ method: "GET", url: "/abc" });

      expect(response.statusCode).toBe(410);
      expect(response.headers.location).toBeUndefined();
      expect(response.json()).toEqual({
        statusCode: 410,
        error: "Gone",
        message: "This short URL has expired",
      });
    });

    it("redirects a URL with no expiration or a future expiration", async () => {
      // isExpired is computed by PostgreSQL; false covers both NULL and future expires_at.
      const { server } = await createApp(async () =>
        target({ isExpired: false }),
      );

      const response = await server.inject({ method: "GET", url: "/abc" });

      expect(response.statusCode).toBe(302);
    });
  });

  describe("failure handling", () => {
    it("returns a safe 500 when the database lookup fails", async () => {
      const { server } = await createApp(async () => {
        throw Object.assign(
          new Error(
            "connect ECONNREFUSED postgresql://scaleurl:supersecret@127.0.0.1:5432/scaleurl SELECT original_url FROM urls",
          ),
          { code: "ECONNREFUSED" },
        );
      });

      const response = await server.inject({ method: "GET", url: "/abc" });

      expect(response.statusCode).toBe(500);
      expect(response.headers.location).toBeUndefined();
      expect(response.json()).toEqual({
        statusCode: 500,
        error: "Internal Server Error",
        message: "An unexpected error occurred",
      });
      expect(response.body).not.toContain("supersecret");
      expect(response.body).not.toContain("SELECT");
      expect(response.body).not.toContain("ECONNREFUSED");
    });

    it("keeps health endpoints reachable alongside the redirect route", async () => {
      const { server, lookup } = await createApp(async () => target());

      const live = await server.inject({ method: "GET", url: "/health/live" });
      const ready = await server.inject({ method: "GET", url: "/health/ready" });

      expect(live.statusCode).toBe(200);
      expect(ready.statusCode).toBe(200);
      expect(lookup).not.toHaveBeenCalled();
    });
  });
});
