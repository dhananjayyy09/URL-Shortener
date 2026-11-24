import type { FastifyInstance, onRequestHookHandler } from "fastify";
import { createUrlBodySchema } from "../urls/url.schema.js";
import type { UrlService } from "../urls/url.service.js";

export async function registerUrlRoutes(
  app: FastifyInstance,
  urlService: UrlService,
  rateLimitHook?: onRequestHookHandler,
): Promise<void> {
  const onRequest = rateLimitHook ? [rateLimitHook] : [];

  app.post("/api/v1/urls", { onRequest }, async (request, reply) => {
    const parsed = createUrlBodySchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: parsed.error.issues[0]?.message ?? "Invalid request body",
      });
    }

    const shortUrl = await urlService.createShortUrl(parsed.data.url);
    return reply.status(201).send(shortUrl);
  });
}
