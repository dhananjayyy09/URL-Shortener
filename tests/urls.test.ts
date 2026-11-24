import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  createMockDatabase,
  createMockRedis,
  createMockUrlRepository,
  createUrlService,
  type UrlRepositoryStub,
} from "./helpers.js";

describe("POST /api/v1/urls", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function createApp(repository?: UrlRepositoryStub) {
    app = await buildApp({
      db: createMockDatabase(),
      redis: createMockRedis(),
      urlService: createUrlService(repository),
      logger: false,
    });
    return app;
  }

  it("creates a short URL and returns 201 with the documented fields", async () => {
    const create = vi.fn(createMockUrlRepository().create);
    const server = await createApp({ create });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/urls",
      payload: { url: "https://example.com/some/long/path" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      code: "21",
      originalUrl: "https://example.com/some/long/path",
      shortUrl: "http://localhost:3000/21",
      createdAt: "2026-11-21T10:00:00.000Z",
    });
    expect(create).toHaveBeenCalledWith("https://example.com/some/long/path");
  });

  it.each([
    [{}, /url is required/],
    [{ url: "" }, /must not be empty/],
    [{ url: "not a url" }, /url must/],
    [{ url: "ftp://example.com" }, /http or https/],
    [{ url: "javascript:alert(1)" }, /http or https/],
  ])("returns 400 for invalid body %j", async (payload, message) => {
    const create = vi.fn();
    const server = await createApp({ create });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/urls",
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      statusCode: 400,
      error: "Bad Request",
    });
    expect(response.json().message).toMatch(message);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const server = await createApp();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/urls",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns a safe 500 when the database fails", async () => {
    const server = await createApp({
      create: async () => {
        throw Object.assign(
          new Error(
            'relation "urls" does not exist postgresql://scaleurl:supersecret@db/scaleurl',
          ),
          { code: "42P01" },
        );
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/urls",
      payload: { url: "https://example.com" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
    expect(response.body).not.toContain("supersecret");
    expect(response.body).not.toContain("relation");
  });
});
