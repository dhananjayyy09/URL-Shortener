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
      URL_CACHE_TTL_SECONDS: 300,
      CREATE_URL_RATE_LIMIT_MAX: 20,
      CREATE_URL_RATE_LIMIT_WINDOW_SECONDS: 60,
      REDIRECT_RATE_LIMIT_MAX: 120,
      REDIRECT_RATE_LIMIT_WINDOW_SECONDS: 60,
      TRUST_PROXY: false,
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
    expect(env.URL_CACHE_TTL_SECONDS).toBe(300);
  });

  it("accepts a custom URL cache TTL", () => {
    expect(
      parseEnv({ ...validEnv, URL_CACHE_TTL_SECONDS: "60" }).URL_CACHE_TTL_SECONDS,
    ).toBe(60);
  });

  it("rejects URL cache TTLs that are not positive integers", () => {
    for (const value of ["0", "-5", "1.5", "abc"]) {
      expect(() =>
        parseEnv({ ...validEnv, URL_CACHE_TTL_SECONDS: value }),
      ).toThrow(/URL_CACHE_TTL_SECONDS must be a positive integer/);
    }
  });

  it("accepts custom rate-limit policies", () => {
    const env = parseEnv({
      ...validEnv,
      CREATE_URL_RATE_LIMIT_MAX: "5",
      CREATE_URL_RATE_LIMIT_WINDOW_SECONDS: "10",
      REDIRECT_RATE_LIMIT_MAX: "1000",
      REDIRECT_RATE_LIMIT_WINDOW_SECONDS: "1",
    });

    expect(env.CREATE_URL_RATE_LIMIT_MAX).toBe(5);
    expect(env.CREATE_URL_RATE_LIMIT_WINDOW_SECONDS).toBe(10);
    expect(env.REDIRECT_RATE_LIMIT_MAX).toBe(1000);
    expect(env.REDIRECT_RATE_LIMIT_WINDOW_SECONDS).toBe(1);
  });

  it("rejects rate-limit settings that are not positive integers", () => {
    for (const name of [
      "CREATE_URL_RATE_LIMIT_MAX",
      "CREATE_URL_RATE_LIMIT_WINDOW_SECONDS",
      "REDIRECT_RATE_LIMIT_MAX",
      "REDIRECT_RATE_LIMIT_WINDOW_SECONDS",
    ]) {
      for (const value of ["0", "-1", "2.5", "abc"]) {
        expect(() => parseEnv({ ...validEnv, [name]: value })).toThrow(
          new RegExp(`${name} must be a positive integer`),
        );
      }
    }
  });

  it("does not trust proxies by default", () => {
    expect(parseEnv(validEnv).TRUST_PROXY).toBe(false);
    expect(parseEnv({ ...validEnv, TRUST_PROXY: "" }).TRUST_PROXY).toBe(false);
    expect(parseEnv({ ...validEnv, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
  });

  it("accepts explicit trusted proxy addresses and ranges", () => {
    expect(
      parseEnv({
        ...validEnv,
        TRUST_PROXY: "10.0.0.5, 172.16.0.0/12,2001:db8::/32,loopback,UniqueLocal",
      }).TRUST_PROXY,
    ).toEqual([
      "10.0.0.5",
      "172.16.0.0/12",
      "2001:db8::/32",
      "loopback",
      "uniquelocal",
    ]);
  });

  it("rejects unrestricted or malformed proxy trust", () => {
    for (const value of [
      "true",
      "*",
      "1",
      "0.0.0.0/0",
      "::/0",
      "10.0.0.0/33",
      "10.0.0.0/abc",
      "example.com",
      "10.0.0.5,,10.0.0.6",
      "10.0.0.0/8/1",
    ]) {
      expect(() => parseEnv({ ...validEnv, TRUST_PROXY: value })).toThrow(
        /TRUST_PROXY must be false or a comma-separated list/,
      );
    }
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
    expect(() =>
      parseEnv({ ...validEnv, PUBLIC_BASE_URL: "https://user:secret@short.example" }),
    ).toThrow(/PUBLIC_BASE_URL must not contain credentials/);
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
