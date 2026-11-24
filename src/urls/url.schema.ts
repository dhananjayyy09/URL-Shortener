import { z } from "zod";

export const MAX_URL_LENGTH = 2048;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Whitespace and control characters are rejected rather than stripped so stored
// URLs match what the client sent and cannot inject headers on redirect.
const FORBIDDEN_CHARACTERS = /[\s\u0000-\u001f\u007f]/;

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export const createUrlBodySchema = z.object({
  url: z
    .string({ error: "url is required and must be a string" })
    .superRefine((value, ctx) => {
      if (value.trim().length === 0) {
        ctx.addIssue({ code: "custom", message: "url must not be empty" });
        return;
      }

      if (value.length > MAX_URL_LENGTH) {
        ctx.addIssue({
          code: "custom",
          message: `url must be at most ${MAX_URL_LENGTH} characters`,
        });
        return;
      }

      if (FORBIDDEN_CHARACTERS.test(value)) {
        ctx.addIssue({
          code: "custom",
          message: "url must not contain whitespace or control characters",
        });
        return;
      }

      const parsed = parseUrl(value);
      if (parsed && !ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        ctx.addIssue({
          code: "custom",
          message: "url must use the http or https protocol",
        });
        return;
      }

      if (!parsed || parsed.hostname.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "url must be a valid absolute URL",
        });
      }
    }),
});

export type CreateUrlBody = z.infer<typeof createUrlBodySchema>;
