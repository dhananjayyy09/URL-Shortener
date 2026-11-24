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
    const migrated = postgres && (await app.db.migrationsApplied());

    const ready = postgres && redis && migrated;

    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ok" : "unavailable",
      checks: {
        postgres: postgres ? "up" : "down",
        migrations: postgres ? (migrated ? "applied" : "pending") : "unknown",
        redis: redis ? "up" : "down",
      },
    });
  });
}
