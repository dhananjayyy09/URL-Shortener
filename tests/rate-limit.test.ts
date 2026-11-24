import { describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_KEY_PREFIX,
  RateLimiter,
  normalizeClientId,
  rateLimitKey,
  type RateLimitPolicy,
} from "../src/ratelimit/rate-limit.js";
import { URL_CACHE_KEY_PREFIX } from "../src/urls/url.cache.js";
import { createMockRateLimitStore } from "./helpers.js";

const policy: RateLimitPolicy = { name: "create-url", max: 3, windowSeconds: 60 };

function createLogger() {
  return { warn: vi.fn() };
}

describe("rate limit keys", () => {
  it("namespaces keys by policy and client", () => {
    expect(rateLimitKey("create-url", "203.0.113.7")).toBe(
      "scaleurl:ratelimit:create-url:203.0.113.7",
    );
    expect(rateLimitKey("redirect", "203.0.113.7")).toBe(
      "scaleurl:ratelimit:redirect:203.0.113.7",
    );
  });

  it("does not share a prefix with URL cache keys", () => {
    expect(RATE_LIMIT_KEY_PREFIX.startsWith(URL_CACHE_KEY_PREFIX)).toBe(false);
    expect(URL_CACHE_KEY_PREFIX.startsWith(RATE_LIMIT_KEY_PREFIX)).toBe(false);
  });
});

describe("normalizeClientId", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    [" 203.0.113.7 ", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::FFFF:203.0.113.7", "203.0.113.7"],
    ["::ffff:cb00:7107", "203.0.113.7"],
    ["0:0:0:0:0:ffff:cb00:7107", "203.0.113.7"],
    ["::ffff:0:1", "0.0.0.1"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:0db8::0001", "2001:db8::1"],
    ["[2001:db8::1]", "2001:db8::1"],
    ["fe80::1%eth0", "fe80::1"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeClientId(input)).toBe(expected);
  });

  it.each([undefined, "", "not-an-ip", "203.0.113.7:8080", "scaleurl:url:abc", "*"])(
    "maps %j to the shared unknown bucket",
    (input) => {
      expect(normalizeClientId(input)).toBe("unknown");
    },
  );
});

describe("RateLimiter", () => {
  it("allows requests up to the limit and reports remaining capacity", async () => {
    const limiter = new RateLimiter(createMockRateLimitStore());
    const log = createLogger();

    const decisions = [];
    for (let i = 0; i < 4; i += 1) {
      decisions.push(await limiter.consume(policy, "203.0.113.7", log));
    }

    expect(decisions.map((d) => d?.allowed)).toEqual([true, true, true, false]);
    expect(decisions.map((d) => d?.remaining)).toEqual([2, 1, 0, 0]);
    expect(decisions.every((d) => d?.limit === 3)).toBe(true);
  });

  it("passes the policy key and window in milliseconds to the store", async () => {
    const store = createMockRateLimitStore();
    await new RateLimiter(store).consume(policy, "203.0.113.7", createLogger());

    expect(store.incrementWindow).toHaveBeenCalledWith(
      "scaleurl:ratelimit:create-url:203.0.113.7",
      60_000,
    );
  });

  it("rounds the reset time up to whole seconds and never reports 0", async () => {
    const limiter = (ttlMs: number) =>
      new RateLimiter({ incrementWindow: async () => ({ count: 1, ttlMs }) });

    const log = createLogger();
    expect((await limiter(59_001).consume(policy, "a", log))?.resetSeconds).toBe(60);
    expect((await limiter(60_000).consume(policy, "a", log))?.resetSeconds).toBe(60);
    expect((await limiter(1).consume(policy, "a", log))?.resetSeconds).toBe(1);
    expect((await limiter(0).consume(policy, "a", log))?.resetSeconds).toBe(1);
  });

  it("starts a new window after the previous one expires", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(createMockRateLimitStore(() => now));
    const log = createLogger();

    for (let i = 0; i < 3; i += 1) {
      await limiter.consume(policy, "c", log);
    }
    expect((await limiter.consume(policy, "c", log))?.allowed).toBe(false);

    now += 60_000;
    const fresh = await limiter.consume(policy, "c", log);
    expect(fresh).toMatchObject({ allowed: true, remaining: 2, resetSeconds: 60 });
  });

  it("fails open with null when the store throws", async () => {
    const limiter = new RateLimiter({
      incrementWindow: async () => {
        throw new Error("connect ECONNREFUSED redis://admin:secret@redis:6379");
      },
    });
    const log = createLogger();

    await expect(limiter.consume(policy, "c", log)).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: "create-url",
        error: "connect ECONNREFUSED redis://[redacted]@redis:6379",
      }),
      "rate limiter unavailable; allowing request",
    );
  });

  it("throttles repeated failure logs", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      {
        incrementWindow: async () => {
          throw new Error("down");
        },
      },
      () => now,
    );
    const log = createLogger();

    for (let i = 0; i < 5; i += 1) {
      await limiter.consume(policy, "c", log);
    }
    expect(log.warn).toHaveBeenCalledTimes(1);

    now += 30_000;
    await limiter.consume(policy, "c", log);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ suppressedSinceLastLog: 4 }),
      expect.any(String),
    );
  });
});
