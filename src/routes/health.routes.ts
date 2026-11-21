import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health/live", async () => ({
    status: "ok",
    checks: {
      live: true,
    },
  }));

  app.get("/health/ready", async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      app.db.ping(),
      app.redis.ping(),
    ]);

    const ready = postgres && redis;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ok" : "unavailable",
      checks: {
        postgres: postgres ? "up" : "down",
        redis: redis ? "up" : "down",
      },
    });
  });
}
