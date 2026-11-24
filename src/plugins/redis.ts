import { Redis } from "ioredis";
import type { CacheStore, RedisPort } from "../types/ports.js";

const HEALTH_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Redis health check timed out"));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class RedisConnection implements RedisPort, CacheStore {
  private closed = false;

  constructor(private readonly client: Redis) {}

  static create(redisUrl: string): RedisConnection {
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 5_000,
      commandTimeout: HEALTH_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // Keep reconnecting so readiness and the URL cache recover when Redis returns.
      retryStrategy(times: number) {
        return Math.min(times * 150, 2_000);
      },
    });

    client.on("error", () => {
      // Connection errors are surfaced by ping/verify; avoid unhandled 'error' events.
    });

    return new RedisConnection(client);
  }

  async verify(): Promise<void> {
    if (this.client.status === "wait" || this.client.status === "end") {
      await this.client.connect();
    }

    const healthy = await this.ping();
    if (!healthy) {
      throw new Error("Redis is not reachable");
    }
  }

  async ping(): Promise<boolean> {
    try {
      if (this.client.status === "wait") {
        await withTimeout(this.client.connect(), HEALTH_TIMEOUT_MS);
      }

      const response = await withTimeout(this.client.ping(), HEALTH_TIMEOUT_MS);
      return response === "PONG";
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, "EX", ttlSeconds);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
