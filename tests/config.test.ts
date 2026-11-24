import { describe, expect, it } from "vitest";
import { parseDatabaseEnv, parseEnv } from "../src/config/env.js";

const validEnv = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: "3000",
  DATABASE_URL: "postgresql://scaleurl:supersecret@127.0.0.1:5432/scaleurl",
  REDIS_URL: "redis://127.0.0.1:6379",
  PUBLIC_BASE_URL: "http://localhost:3000",
  LOG_LEVEL: "info",
};

describe("environment configuration", () => {
  it("accepts valid environment configuration", () => {
    const env = parseEnv(validEnv);

    expect(env).toEqual({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: 3000,
      DATABASE_URL: validEnv.DATABASE_URL,
      REDIS_URL: validEnv.REDIS_URL,
      PUBLIC_BASE_URL: "http://localhost:3000",
      LOG_LEVEL: "info",
    });
  });

  it("applies safe defaults for optional values", () => {
    const env = parseEnv({
      DATABASE_URL: validEnv.DATABASE_URL,
      REDIS_URL: validEnv.REDIS_URL,
      PUBLIC_BASE_URL: validEnv.PUBLIC_BASE_URL,
    });

    expect(env.NODE_ENV).toBe("development");
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rejects invalid ports", () => {
    expect(() => parseEnv({ ...validEnv, PORT: "0" })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => parseEnv({ ...validEnv, PORT: "70000" })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => parseEnv({ ...validEnv, PORT: "abc" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("rejects invalid URLs", () => {
    expect(() =>
      parseEnv({ ...validEnv, DATABASE_URL: "not-a-url" }),
    ).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ ...validEnv, REDIS_URL: "redis" })).toThrow(
      /REDIS_URL/,
    );
  });

  it("rejects missing required configuration", () => {
    const { DATABASE_URL: _databaseUrl, ...withoutDatabase } = validEnv;
    const { REDIS_URL: _redisUrl, ...withoutRedis } = validEnv;

    expect(() => parseEnv(withoutDatabase)).toThrow(/DATABASE_URL/);
    expect(() => parseEnv(withoutRedis)).toThrow(/REDIS_URL/);
  });

  it("requires a valid http(s) PUBLIC_BASE_URL and strips trailing slashes", () => {
    const { PUBLIC_BASE_URL: _base, ...withoutBase } = validEnv;

    expect(() => parseEnv(withoutBase)).toThrow(/PUBLIC_BASE_URL/);
    expect(() =>
      parseEnv({ ...validEnv, PUBLIC_BASE_URL: "ftp://short.example" }),
    ).toThrow(/PUBLIC_BASE_URL/);
    expect(() =>
      parseEnv({ ...validEnv, PUBLIC_BASE_URL: "https://short.example/?a=1" }),
    ).toThrow(/PUBLIC_BASE_URL/);
    expect(
      parseEnv({ ...validEnv, PUBLIC_BASE_URL: "https://short.example/s/" })
        .PUBLIC_BASE_URL,
    ).toBe("https://short.example/s");
  });

  it("parses only the database configuration for migrations", () => {
    expect(parseDatabaseEnv({ DATABASE_URL: validEnv.DATABASE_URL })).toEqual({
      DATABASE_URL: validEnv.DATABASE_URL,
    });
    expect(() => parseDatabaseEnv({})).toThrow(/DATABASE_URL/);
  });

  it("does not include secrets in validation error messages", () => {
    expect(() => parseEnv({ ...validEnv, PORT: "not-a-port" })).toThrow();

    try {
      parseEnv({ ...validEnv, PORT: "not-a-port" });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).not.toContain("supersecret");
      expect(message).not.toContain(validEnv.DATABASE_URL);
    }
  });
});
