import type { FastifyInstance } from "fastify";
import type { UrlService } from "../urls/url.service.js";

// WHATWG serialization yields an ASCII header value with an explicit "//"
// authority, Punycode IDN hosts and percent-encoded non-ASCII path/query characters.
function toLocationHeader(url: string): string {
  return new URL(url).href;
}

export async function registerRedirectRoutes(
  app: FastifyInstance,
  urlService: UrlService,
): Promise<void> {
  app.get<{ Params: { code: string } }>("/:code", async (request, reply) => {
    const result = await urlService.resolveRedirect(request.params.code);

    switch (result.status) {
      case "found":
        return reply.redirect(toLocationHeader(result.originalUrl), 302);
      case "expired":
        return reply.status(410).send({
          statusCode: 410,
          error: "Gone",
          message: "This short URL has expired",
        });
      // Malformed codes share the not-found response so this catch-all route keeps
      // unknown single-segment paths returning 404, as before it existed.
      case "invalid_code":
      case "not_found":
      case "inactive":
        return reply.status(404).send({
          statusCode: 404,
          error: "Not Found",
          message: "Short URL not found",
        });
    }
  });
}
