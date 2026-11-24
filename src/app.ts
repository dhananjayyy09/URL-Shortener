import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { registerHealthRoutes } from "./routes/health.routes.js";
import { registerRedirectRoutes } from "./routes/redirect.routes.js";
import { registerUrlRoutes } from "./routes/url.routes.js";
import type { DatabasePort, RedisPort } from "./types/ports.js";
import type { UrlService } from "./urls/url.service.js";

export interface BuildAppOptions {
  db: DatabasePort;
  redis: RedisPort;
  urlService: UrlService;
  logger?: boolean | object;
  logLevel?: string;
}

function getErrorStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = error.statusCode;
    if (typeof statusCode === "number" && statusCode >= 400) {
      return statusCode;
    }
  }

  return 500;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger ??
      ({
        level: options.logLevel ?? "info",
        redact: {
          paths: [
            "req.headers.authorization",
            "DATABASE_URL",
            "REDIS_URL",
            "*.password",
            "*.connectionString",
          ],
          censor: "[redacted]",
        },
      } as const),
    requestIdHeader: "x-request-id",
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      if (typeof header === "string" && header.length > 0) {
        return header;
      }
      return randomUUID();
    },
  });

  app.decorate("db", options.db);
  app.decorate("redis", options.redis);

  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      statusCode: 404,
      error: "Not Found",
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "unhandled application error");

    const statusCode = getErrorStatusCode(error);

    if (statusCode >= 500) {
      void reply.status(statusCode).send({
        statusCode,
        error: "Internal Server Error",
        message: "An unexpected error occurred",
      });
      return;
    }

    void reply.status(statusCode).send({
      statusCode,
      error: "Error",
      message: "The request could not be processed",
    });
  });

  await registerHealthRoutes(app);
  await registerUrlRoutes(app, options.urlService);
  await registerRedirectRoutes(app, options.urlService);
  return app;
}
