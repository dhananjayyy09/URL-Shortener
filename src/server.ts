import type { FastifyInstance } from "fastify";
import { loadLocalEnv, parseEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { Database } from "./plugins/database.js";
import { RedisConnection } from "./plugins/redis.js";

loadLocalEnv();

const env = parseEnv(process.env);

function redactErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }

  return error.message.replace(/:\/\/([^/\s]+)@/g, "://[redacted]@");
}

async function closeQuietly(
  resource: { close(): Promise<void> } | undefined,
): Promise<void> {
  if (!resource) {
    return;
  }

  try {
    await resource.close();
  } catch {
    // Shutdown must continue even if a single resource close fails.
  }
}

async function start(): Promise<void> {
  let db: Database | undefined;
  let redis: RedisConnection | undefined;
  let app: FastifyInstance | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app?.log.info({ signal }, "shutting down");

    await closeQuietly(app);
    await closeQuietly(redis);
    await closeQuietly(db);
  };

  try {
    db = Database.create(env.DATABASE_URL);
    redis = RedisConnection.create(env.REDIS_URL);

    await db.verify();
    await redis.verify();

    app = await buildApp({
      db,
      redis,
      logLevel: env.LOG_LEVEL,
    });

    const handleSignal = (signal: string): void => {
      void shutdown(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          console.error("Shutdown failed:", redactErrorMessage(error));
          process.exit(1);
        },
      );
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);

    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(
      { host: env.HOST, port: env.PORT, env: env.NODE_ENV },
      "ScaleURL listening",
    );
  } catch (error) {
    console.error("Failed to start ScaleURL:", redactErrorMessage(error));
    await closeQuietly(app);
    await closeQuietly(redis);
    await closeQuietly(db);
    process.exit(1);
  }
}

await start();
