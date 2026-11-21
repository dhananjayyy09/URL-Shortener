import type { DatabasePort, RedisPort } from "../src/types/ports.js";

export function createMockDatabase(healthy = true): DatabasePort {
  return {
    ping: async () => healthy,
    close: async () => undefined,
  };
}

export function createMockRedis(healthy = true): RedisPort {
  return {
    ping: async () => healthy,
    close: async () => undefined,
  };
}
