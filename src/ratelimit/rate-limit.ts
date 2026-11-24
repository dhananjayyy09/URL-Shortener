import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateLimitStore } from "../types/ports.js";
import { redactErrorMessage } from "../utils/redact.js";
import { ThrottledWarning, type WarnLogger } from "../utils/throttled-warning.js";

export const RATE_LIMIT_KEY_PREFIX = "scaleurl:ratelimit:";

export type RateLimitPolicyName = "create-url" | "redirect";

export interface RateLimitPolicy {
  name: RateLimitPolicyName;
  max: number;
  windowSeconds: number;
}

export interface RateLimitPolicies {
  createUrl: RateLimitPolicy;
  redirect: RateLimitPolicy;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

const UNKNOWN_CLIENT = "unknown";
const ERROR_LOG_INTERVAL_MS = 30_000;

// Reduces equivalent spellings of one address to a single key component.
// Anything that is not an IP address shares the "unknown" bucket.
export function normalizeClientId(ip: string | undefined): string {
  if (!ip) {
    return UNKNOWN_CLIENT;
  }

  let value = ip.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) {
    value = value.slice(0, zoneIndex);
  }

  switch (isIP(value)) {
    case 4:
      return value;
    case 6:
      return unmapIpv4(new URL(`http://[${value}]/`).hostname.slice(1, -1));
    default:
      return UNKNOWN_CLIENT;
  }
}

// Canonical IPv6 writes IPv4-mapped addresses in hex (::ffff:cb00:7107).
function unmapIpv4(canonicalIpv6: string): string {
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonicalIpv6);
  if (!mapped?.[1] || !mapped[2]) {
    return canonicalIpv6;
  }

  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

export function rateLimitKey(
  policy: RateLimitPolicyName,
  clientId: string,
): string {
  return `${RATE_LIMIT_KEY_PREFIX}${policy}:${clientId}`;
}

// Fails open: when Redis cannot answer, the request is allowed and the failure logged.
export class RateLimiter {
  private readonly errorLog: ThrottledWarning;

  constructor(
    private readonly store: RateLimitStore,
    now: () => number = Date.now,
  ) {
    this.errorLog = new ThrottledWarning(
      "rate limiter unavailable; allowing request",
      ERROR_LOG_INTERVAL_MS,
      now,
    );
  }

  async consume(
    policy: RateLimitPolicy,
    clientId: string,
    log: WarnLogger,
  ): Promise<RateLimitDecision | null> {
    try {
      const { count, ttlMs } = await this.store.incrementWindow(
        rateLimitKey(policy.name, clientId),
        policy.windowSeconds * 1000,
      );

      return {
        allowed: count <= policy.max,
        limit: policy.max,
        remaining: Math.max(0, policy.max - count),
        resetSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
      };
    } catch (error) {
      this.errorLog.log(log, {
        policy: policy.name,
        error: redactErrorMessage(error),
      });
      return null;
    }
  }
}

export function createRateLimitHook(
  limiter: RateLimiter,
  policy: RateLimitPolicy,
) {
  return async function rateLimitHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const decision = await limiter.consume(
      policy,
      normalizeClientId(request.ip),
      request.log,
    );
    if (!decision) {
      return undefined;
    }

    void reply.headers({
      "ratelimit-limit": decision.limit,
      "ratelimit-remaining": decision.remaining,
      "ratelimit-reset": decision.resetSeconds,
    });

    if (!decision.allowed) {
      return reply
        .header("retry-after", decision.resetSeconds)
        .status(429)
        .send({
          statusCode: 429,
          error: "Too Many Requests",
          message: `Rate limit exceeded. Try again in ${decision.resetSeconds} seconds.`,
        });
    }
    return undefined;
  };
}
