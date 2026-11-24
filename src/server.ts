import type { FastifyInstance } from "fastify";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./db/migrator.js";
import { loadLocalEnv, parseEnv } from "./config/env.js";
import { buildApp } from "./app.js";
import { Database } from "./plugins/database.js";
import { RedisConnection } from "./plugins/redis.js";
import { RateLimiter } from "./ratelimit/rate-limit.js";
import { UrlCache } from "./urls/url.cache.js";
import { UrlRepository } from "./urls/url.repository.js";
import { UrlService } from "./urls/url.service.js";
import { redactErrorMessage } from "./utils/redact.js";

loadLocalEnv();

const env = parseEnv(process.env);

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

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
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    db = Database.create(
      env.DATABASE_URL,
      migrations.map((migration) => migration.name),
    );
    redis = RedisConnection.create(env.REDIS_URL);

    await db.verify();
    await redis.verify();

    app = await buildApp({
      db,
      redis,
      urlService: new UrlService(
        new UrlRepository(db),
        env.PUBLIC_BASE_URL,
        new UrlCache(redis, env.URL_CACHE_TTL_SECONDS),
      ),
      rateLimit: {
        limiter: new RateLimiter(redis),
        policies: {
          createUrl: {
            name: "create-url",
            max: env.CREATE_URL_RATE_LIMIT_MAX,
            windowSeconds: env.CREATE_URL_RATE_LIMIT_WINDOW_SECONDS,
          },
          redirect: {
            name: "redirect",
            max: env.REDIRECT_RATE_LIMIT_MAX,
            windowSeconds: env.REDIRECT_RATE_LIMIT_WINDOW_SECONDS,
          },
        },
      },
      trustProxy: env.TRUST_PROXY,
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
