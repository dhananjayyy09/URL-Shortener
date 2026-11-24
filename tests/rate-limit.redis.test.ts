import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisConnection } from "../src/plugins/redis.js";

// Runs the real Lua script against Redis. Opt in with, for example:
//   REDIS_TEST_URL=redis://127.0.0.1:6379 npm test
const redisUrl = process.env.REDIS_TEST_URL;

describe.skipIf(!redisUrl)("rate limit script against real Redis", () => {
  const prefix = `scaleurl:test:ratelimit:${randomUUID()}:`;
  const connections: RedisConnection[] = [];
  let admin: Redis;

  beforeAll(async () => {
    admin = new Redis(redisUrl as string);
    for (let i = 0; i < 5; i += 1) {
      const connection = RedisConnection.create(redisUrl as string);
      await connection.verify();
      connections.push(connection);
    }
  });

  afterAll(async () => {
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length > 0) {
      await admin.del(...keys);
    }
    await admin.quit();
    await Promise.all(connections.map((connection) => connection.close()));
  });

  it("increments and sets the window TTL on the first hit only", async () => {
    const key = `${prefix}first`;
    const [connection] = connections;

    const first = await connection!.incrementWindow(key, 60_000);
    expect(first.count).toBe(1);
    expect(first.ttlMs).toBeGreaterThan(59_000);
    expect(first.ttlMs).toBeLessThanOrEqual(60_000);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await connection!.incrementWindow(key, 60_000);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeLessThan(first.ttlMs);
    expect(await admin.pttl(key)).toBeGreaterThan(0);
  });

  it("counts every concurrent request exactly once across connections", async () => {
    const key = `${prefix}concurrent`;
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        connections[i % connections.length]!.incrementWindow(key, 60_000),
      ),
    );

    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(await admin.get(key)).toBe("200");
    expect(await admin.pttl(key)).toBeGreaterThan(0);
  });

  it("starts a new window after expiry", async () => {
    const key = `${prefix}expiry`;
    const [connection] = connections;

    await connection!.incrementWindow(key, 200);
    await connection!.incrementWindow(key, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const next = await connection!.incrementWindow(key, 200);
    expect(next.count).toBe(1);
  });

  it("repairs a counter that has no TTL", async () => {
    const key = `${prefix}no-ttl`;
    await admin.set(key, "7");

    const result = await connections[0]!.incrementWindow(key, 60_000);
    expect(result.count).toBe(8);
    expect(result.ttlMs).toBe(60_000);
    expect(await admin.pttl(key)).toBeGreaterThan(0);
  });
});
