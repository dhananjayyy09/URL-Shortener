import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createMockDatabase, createMockRedis } from "./helpers.js";

describe("application factory and health routes", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("creates a Fastify instance", async () => {
    app = await buildApp({
      db: createMockDatabase(),
      redis: createMockRedis(),
      logger: false,
    });

    expect(app).toBeDefined();
    expect(typeof app.inject).toBe("function");
  });

  it("returns 200 JSON from GET /health/live without dependency checks", async () => {
    const db = createMockDatabase(false);
    const redis = createMockRedis(false);
    app = await buildApp({ db, redis, logger: false });

    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      checks: { live: true },
    });
  });

  it("returns 200 from GET /health/ready when both dependencies are healthy", async () => {
    app = await buildApp({
      db: createMockDatabase(true),
      redis: createMockRedis(true),
      logger: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      checks: {
        postgres: "up",
        redis: "up",
      },
    });
  });

  it("returns 503 from GET /health/ready when PostgreSQL is unhealthy", async () => {
    app = await buildApp({
      db: createMockDatabase(false),
      redis: createMockRedis(true),
      logger: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "unavailable",
      checks: {
        postgres: "down",
        redis: "up",
      },
    });
    expect(response.body).not.toMatch(/postgresql:\/\//i);
  });

  it("returns 503 from GET /health/ready when Redis is unhealthy", async () => {
    app = await buildApp({
      db: createMockDatabase(true),
      redis: createMockRedis(false),
      logger: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "unavailable",
      checks: {
        postgres: "up",
        redis: "down",
      },
    });
  });

  it("returns 404 for unknown endpoints", async () => {
    app = await buildApp({
      db: createMockDatabase(),
      redis: createMockRedis(),
      logger: false,
    });

    const response = await app.inject({
      method: "GET",
      url: "/does-not-exist",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      statusCode: 404,
      error: "Not Found",
    });
  });

  it("does not leak stack traces or credentials in error responses", async () => {
    app = await buildApp({
      db: createMockDatabase(),
      redis: createMockRedis(),
      logger: false,
    });

    app.get("/boom", async () => {
      throw new Error(
        "secret stack postgresql://scaleurl:supersecret@127.0.0.1:5432/scaleurl",
      );
    });

    const response = await app.inject({
      method: "GET",
      url: "/boom",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred",
    });
    expect(response.body).not.toContain("supersecret");
    expect(response.body).not.toContain("secret stack");
    expect(response.body).not.toMatch(/at\s+/);
  });
});
