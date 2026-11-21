import type { DatabasePort, RedisPort } from "./ports.js";

declare module "fastify" {
  interface FastifyInstance {
    db: DatabasePort;
    redis: RedisPort;
  }
}
