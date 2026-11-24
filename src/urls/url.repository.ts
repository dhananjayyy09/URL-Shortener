import type { Queryable } from "../types/ports.js";
import { generateShortCode } from "../utils/base62.js";

export interface CreatedUrl {
  id: string;
  code: string;
  originalUrl: string;
  createdAt: Date;
}

interface CreatedUrlRow extends Record<string, unknown> {
  id: string;
  code: string;
  original_url: string;
  created_at: Date;
}

export interface RedirectTarget {
  originalUrl: string;
  isActive: boolean;
  isExpired: boolean;
  expiresAt: Date | null;
  expiresInSeconds: number | null;
}

interface RedirectTargetRow extends Record<string, unknown> {
  original_url: string;
  is_active: boolean;
  is_expired: boolean;
  expires_at: Date | null;
  expires_in_seconds: number | null;
}

const UNIQUE_VIOLATION = "23505";
const MAX_CREATE_ATTEMPTS = 5;

function isUniqueCodeViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === "urls_code_key"
  );
}

export class UrlRepository {
  constructor(
    private readonly db: Queryable,
    private readonly generateCode: () => string = generateShortCode,
  ) {}

  // One INSERT per attempt; a random-code collision is retried with a new code.
  async create(originalUrl: string): Promise<CreatedUrl> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.db.query<CreatedUrlRow>(
          `INSERT INTO urls (code, original_url)
           VALUES ($1, $2)
           RETURNING id::text AS id, code, original_url, created_at`,
          [this.generateCode(), originalUrl],
        );

        const row = result.rows[0];
        if (!row) {
          throw new Error("URL insert returned no row");
        }

        return {
          id: row.id,
          code: row.code,
          originalUrl: row.original_url,
          createdAt: row.created_at,
        };
      } catch (error) {
        if (isUniqueCodeViolation(error) && attempt < MAX_CREATE_ATTEMPTS) {
          continue;
        }
        throw error;
      }
    }
  }

  // Expiration is evaluated with the database clock so every instance agrees.
  // An 'infinity' expires_at is reported as no expiration.
  async findRedirectTarget(code: string): Promise<RedirectTarget | null> {
    const { rows } = await this.db.query<RedirectTargetRow>(
      `SELECT original_url,
              is_active,
              (expires_at IS NOT NULL AND expires_at <= now()) AS is_expired,
              CASE WHEN isfinite(expires_at) THEN expires_at END AS expires_at,
              CASE WHEN isfinite(expires_at)
                   THEN extract(epoch FROM expires_at - now())::float8
              END AS expires_in_seconds
         FROM urls
        WHERE code = $1`,
      [code],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      originalUrl: row.original_url,
      isActive: row.is_active,
      isExpired: row.is_expired,
      expiresAt: row.expires_at,
      expiresInSeconds: row.expires_in_seconds,
    };
  }
}
