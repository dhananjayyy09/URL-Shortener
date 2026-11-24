# ScaleURL

ScaleURL is a production-oriented URL shortening service. The long-term goal is to support a defined high-throughput workload in later phases. This repository currently implements:

- **Phase 1:** a type-safe Fastify foundation, configuration, Dockerized PostgreSQL and Redis, health checks, and graceful shutdown.
- **Phase 2:** the URL creation pipeline: raw SQL migrations, the `urls` table, database-derived Base62 short codes, and `POST /api/v1/urls`.
- **Phase 3:** the redirect engine: `GET /:code` looks the code up in PostgreSQL and redirects with `302 Found`.
- **Phase 4:** Redis cache-aside for redirects, with PostgreSQL as the source of truth.
- **Phase 5:** Redis-backed, per-client-IP fixed-window rate limiting for URL creation and redirects.

The service does **not** yet record analytics, authenticate clients, or claim any requests-per-second capacity.

## Phase 1 scope

- Node.js + TypeScript (strict) backend bootstrap
- Fastify application factory suitable for tests (`inject()` without binding a port)
- Zod-validated environment configuration
- PostgreSQL connection pool (`pg.Pool`) with startup and readiness checks
- Redis client (`ioredis`) with startup and readiness checks
- Liveness and readiness HTTP endpoints
- Docker Compose development infrastructure
- Vitest unit tests with mocked dependencies

## Phase 2 scope

- Raw SQL migration system (`migrations/`, `npm run db:migrate`) on top of `pg`
- `urls` table with a PostgreSQL identity primary key and unique `code`
- Base62 encoding utility (`src/utils/base62.ts`) using `bigint`
- `POST /api/v1/urls` with Zod request validation
- Configurable `PUBLIC_BASE_URL` for returned short links

## Phase 3 scope

- `GET /:code` redirect endpoint backed only by PostgreSQL
- Short-code validation (Base62, 1-16 characters) before any database access
- Active, inactive and expired URL handling, evaluated with the database clock

## Phase 4 scope

- Redis cache-aside for `GET /:code`; PostgreSQL stays the source of truth
- Configurable cache TTL (`URL_CACHE_TTL_SECONDS`), capped by each URL's remaining lifetime
- Graceful fallback to PostgreSQL on any Redis failure or malformed cache entry

## Phase 5 scope

- Atomic Redis fixed-window rate limiting (one Lua script call per request)
- Separate configurable policies for `POST /api/v1/urls` and `GET /:code`; health endpoints are exempt
- `429 Too Many Requests` with `RateLimit-*` and `Retry-After` headers
- Explicit, validated reverse-proxy trust (`TRUST_PROXY`, off by default)
- Fail-open when Redis is unavailable

### Deferred to later phases

- Distributed rate limiting
- Production observability beyond structured logs
- Horizontal scaling and load testing
- Authentication, analytics, and background jobs

## Technology stack

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js | Required backend runtime |
| Language | TypeScript (strict) | Catch configuration and wiring mistakes early |
| HTTP | Fastify | Low-overhead HTTP with first-class logging and `inject()` testing |
| Database | PostgreSQL + `pg.Pool` | Durable storage for later URL data; bounded pool in this phase |
| Cache / coordination | Redis + `ioredis` | Ready for later caching and rate limiting; unused as a cache here |
| Config | Zod | Fail fast on invalid environment values |
| Tests | Vitest | Fast unit tests without requiring Docker |
| Containers | Docker Compose | Reproducible local PostgreSQL and Redis |

No ORM, frontend, message broker, or Kubernetes is included in this phase.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Docker Engine and Docker Compose (for PostgreSQL and Redis)

This project uses ESM (`"type": "module"`) with TypeScript `NodeNext` module resolution.

## Environment setup

1. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

   On Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Review `.env`. Values in `.env.example` are **placeholders** for local development, not production secrets.

3. `.env` is gitignored. Docker Compose reads the same file for container credentials. The API process running on your host uses `DATABASE_URL` and `REDIS_URL` pointing at `127.0.0.1`. The Compose `api` service overrides those URLs to the Docker network hostnames `postgres` and `redis`.

Required variables:

- `NODE_ENV`
- `HOST`
- `PORT`
- `DATABASE_URL`
- `REDIS_URL`
- `PUBLIC_BASE_URL`: absolute `http(s)` URL used to build `shortUrl` in API responses (for example `http://localhost:3000` or `https://sho.rt`). A path prefix is allowed; query strings and fragments are rejected; trailing slashes are removed.
- `URL_CACHE_TTL_SECONDS`: redirect cache TTL in seconds (positive integer, default `300`). Invalid values fail startup validation.
- `CREATE_URL_RATE_LIMIT_MAX`, `CREATE_URL_RATE_LIMIT_WINDOW_SECONDS`, `REDIRECT_RATE_LIMIT_MAX`, `REDIRECT_RATE_LIMIT_WINDOW_SECONDS`: rate-limit policies (positive integers). See [Rate limiting](#rate-limiting-phase-5).
- `TRUST_PROXY`: reverse proxies whose `X-Forwarded-For` is trusted (default `false`). See [Client identity and proxies](#client-identity-and-proxies).
- `LOG_LEVEL`

Compose also uses `POSTGRES_*` and `APP_DB_*` to create a non-superuser application role the first time the PostgreSQL volume is initialized.

## Install dependencies

```bash
npm install
```

## Start PostgreSQL and Redis

From the project root, with `.env` present:

```bash
docker compose up -d postgres redis
docker compose ps
```

Wait until both services report healthy. The first start creates the `scaleurl` database and application user via `docker/postgres/init-app-user.sh`. That script runs only on an empty volume.

## Database migrations

Migrations are plain SQL files in `migrations/`, named `NNNN_description.sql` and applied in lexical order. Apply pending migrations with:

```bash
npm run db:migrate          # development (tsx, loads .env)
npm run db:migrate:prod     # after npm run build (node dist/scripts/migrate.js)
```

The runner:

- creates a `schema_migrations` tracking table (name, SHA-256 checksum, applied time)
- takes a PostgreSQL advisory lock so concurrent runs are serialized
- applies each pending migration and its tracking row in one transaction
- skips migrations that are already recorded, so it is safe to run repeatedly
- fails if an applied migration file was modified, or if a migration fails (that migration is rolled back and later ones are not run)

The Compose `api` service runs `node dist/scripts/migrate.js` before starting the server.

### Schema: `urls`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `BIGINT` | `GENERATED ALWAYS AS IDENTITY` primary key |
| `code` | `VARCHAR(16)` | Not null, unique (`urls_code_key`), non-empty |
| `original_url` | `TEXT` | Not null, must not be blank |
| `created_at` | `TIMESTAMPTZ` | Not null, default `now()` |
| `expires_at` | `TIMESTAMPTZ` | Nullable; when set must be later than `created_at` |
| `user_id` | `UUID` | Nullable, reserved for future authentication |
| `is_active` | `BOOLEAN` | Not null, default `true` |

The unique constraint on `code` provides the index for code lookups. No `created_at` index is created because no current query filters or sorts by it.

## Local development (API on the host)

Keep PostgreSQL and Redis running in Compose, apply migrations, then start the dev server:

```bash
npm run db:migrate
npm run dev
```

The development server loads `.env` without overwriting variables already present in the process environment.

## Docker Compose API (optional)

Build and start the API container together with its dependencies:

```bash
docker compose up --build
```

The API container starts only after PostgreSQL and Redis pass their container health checks. Application-level readiness is still reported by `GET /health/ready`.

## Build, type-check, and production start

```bash
npm run typecheck
npm run build
npm start
```

`npm start` runs `node dist/server.js` and does not use development-only loaders. PostgreSQL and Redis must already be reachable with the configured URLs.

## Tests

```bash
npm test
npm run test:watch
```

Unit tests mock PostgreSQL and Redis. They do not require Docker. They cover environment validation, health routes, Base62 encoding, URL and short-code validation, the URL creation API, the redirect endpoint, the URL repository (with a mocked query client), the migration runner, the redirect cache, and rate limiting.

`tests/rate-limit.redis.test.ts` runs the rate-limit Lua script against a real Redis, including 200 concurrent increments over 5 connections. It is skipped unless `REDIS_TEST_URL` is set:

```bash
docker compose up -d redis
REDIS_TEST_URL=redis://127.0.0.1:6379 npm test
```

It only touches keys under `scaleurl:test:ratelimit:<random-uuid>:` and deletes them afterwards.

## Create a short URL

`POST /api/v1/urls`

```bash
curl -i -X POST http://127.0.0.1:3000/api/v1/urls \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/some/long/path"}'
```

`201 Created`:

```json
{
  "code": "1",
  "originalUrl": "https://example.com/some/long/path",
  "shortUrl": "http://localhost:3000/1",
  "createdAt": "2026-11-21T10:00:00.000Z"
}
```

### Validation rules

The body must be JSON with a `url` string that:

- is not empty or whitespace-only
- is at most 2048 characters
- contains no whitespace or control characters (they are rejected, not stripped)
- parses as an absolute URL with a host
- uses `http:` or `https:` (`ftp:`, `javascript:`, `mailto:`, `file:` and others are rejected)

The URL is stored exactly as sent; it is not normalized.

Invalid input returns `400`:

```json
{ "statusCode": 400, "error": "Bad Request", "message": "url must use the http or https protocol" }
```

Database or unexpected failures return a generic `500` (`"An unexpected error occurred"`); details are only written to the server log.

### How short codes are generated

1. `SELECT nextval(...)` reserves the next value of the `urls.id` identity sequence.
2. The id (handled as a string / `bigint`, never a JavaScript `number`) is Base62-encoded with the alphabet `0-9a-zA-Z`.
3. A single `INSERT ... OVERRIDING SYSTEM VALUE` writes the row with its id and final code.

Because the row is inserted with its code in one statement, no partially created row is ever visible, so no explicit transaction is needed. Uniqueness comes from the database sequence and the `urls_code_key` constraint, not from Base62 itself. If an insert still hits a `code` unique violation (for example a manually inserted row), the repository retries with a fresh id up to 3 times, then returns a `500`. A failed insert leaves a gap in the id sequence, which is harmless.

Any `BIGINT` encodes to at most 11 characters, within `VARCHAR(16)`.

## Health endpoints

Liveness (process is running; dependencies are not required):

```bash
curl http://127.0.0.1:3000/health/live
```

Example:

```json
{ "status": "ok", "checks": { "live": true } }
```

Readiness (PostgreSQL `SELECT 1` and Redis `PING` both succeed):

```bash
curl http://127.0.0.1:3000/health/ready
```

Healthy example:

```json
{ "status": "ok", "checks": { "postgres": "up", "redis": "up" } }
```

If either dependency is down, the response is HTTP 503 with the corresponding check marked `down`. Responses do not include connection strings or driver internals.

## Stop services

Local API: press `Ctrl+C`. The process handles `SIGINT`/`SIGTERM`, stops accepting new HTTP requests, and closes Fastify, the PostgreSQL pool, and Redis.

Compose:

```bash
docker compose down
```

Data in the named `postgres_data` volume is kept. To remove the volume as well (this deletes local database data):

```bash
docker compose down -v
```

## Troubleshooting

**Readiness returns 503 or the API exits at startup**

- Confirm Compose services are healthy: `docker compose ps`
- Confirm `.env` `DATABASE_URL` and `REDIS_URL` match the published host ports
- If the API runs on the host, use `127.0.0.1`, not the Docker service names
- If the API runs in Compose, do not point `DATABASE_URL` at `127.0.0.1` inside the container
- Changing `APP_DB_USER` / `APP_DB_PASSWORD` after the volume already exists does not re-run init scripts. Either keep the original credentials or recreate the volume with `docker compose down -v`

**Port already in use**

- Change `PORT`, `POSTGRES_PORT`, or `REDIS_PORT` in `.env`
- Host mappings bind PostgreSQL and Redis to `127.0.0.1` only

**Invalid environment configuration**

- The process exits before listening if `PORT` is out of range or a URL is malformed
- Error messages are written without echoing credentials

## Redirect a short URL

`GET /:code`

```bash
curl -i http://127.0.0.1:3000/1
```

```text
HTTP/1.1 302 Found
location: https://example.com/some/long/path
```

The destination is always the `original_url` stored in PostgreSQL. Query strings on the short URL are ignored, and nothing in the request can change the destination. The `Location` header is the WHATWG serialization of the stored URL (`new URL(original_url).href`): internationalized hosts become Punycode, other non-ASCII characters are percent-encoded, and forms like `http:example.com` gain the `//` authority delimiter.

`302 Found` is used instead of `301 Moved Permanently` because browsers and proxies cache permanent redirects, which would prevent later phases from changing redirect behavior.

### Status codes

| Condition | Status | Body `message` |
| --- | --- | --- |
| Code exists, `is_active = true`, `expires_at` is `NULL` or in the future | `302 Found` | (empty, `Location` header set) |
| Unknown code | `404 Not Found` | `Short URL not found` |
| Malformed code (empty, non-Base62, longer than 16 characters) | `404 Not Found` | `Short URL not found` |
| `is_active = false` (whether or not it has expired) | `404 Not Found` | `Short URL not found` |
| Active but `expires_at <= now()` | `410 Gone` | `This short URL has expired` |
| Path segment longer than Fastify's `maxParamLength` (100) | `414 URI Too Long` | (Fastify default) |
| Database failure | `500 Internal Server Error` | `An unexpected error occurred` |

Design decisions:

- **Malformed codes return 404, not 400.** `GET /:code` catches every single-segment path, so returning 404 keeps unknown paths such as `/does-not-exist` behaving as they did before the route existed. Malformed codes are rejected before any database query.
- **Inactive URLs return 404** so a disabled link is indistinguishable from one that never existed.
- **Expired URLs return 410** so clients can tell that the link existed but is no longer valid. Expired rows are not deleted during a redirect.
- **Expiration uses the database clock.** The lookup computes `expires_at IS NOT NULL AND expires_at <= now()` in SQL, so all API instances agree regardless of host clock drift.

Error bodies use the same `{ statusCode, error, message }` shape as the rest of the API and never include SQL, connection details, or stack traces. Failures are logged through Fastify's logger.

### Lookup query

Each redirect runs one parameterized query that selects only the redirect fields:

```sql
SELECT original_url,
       is_active,
       (expires_at IS NOT NULL AND expires_at <= now()) AS is_expired,
       CASE WHEN isfinite(expires_at) THEN expires_at END AS expires_at,
       CASE WHEN isfinite(expires_at)
            THEN extract(epoch FROM expires_at - now())::float8
       END AS expires_in_seconds
  FROM urls
 WHERE code = $1
```

This query only runs on a cache miss (see [Redirect cache](#redirect-cache-phase-4)). `expires_in_seconds` is computed by PostgreSQL and is used to cap the cache TTL. An `infinity` expiry is treated as no expiry.

`EXPLAIN` shows an `Index Scan using urls_code_key`. The unique constraint already provides this index, so no new index was added. No latency or throughput numbers have been measured.

### Test redirects locally

With PostgreSQL and Redis running and migrations applied:

```bash
npm run dev

# create a URL and copy the returned code
curl -s -X POST http://127.0.0.1:3000/api/v1/urls \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/docs?x=1#top"}'

curl -i http://127.0.0.1:3000/<code>     # 302 with location header
curl -i http://127.0.0.1:3000/zzzzzz     # 404 unknown code
curl -i http://127.0.0.1:3000/abc-123    # 404 malformed code
```

To try the inactive and expired paths, update a row directly:

```bash
docker compose exec postgres psql -U scaleurl -d scaleurl \
  -c "UPDATE urls SET is_active = false WHERE code = '<code>'"   # now 404

docker compose exec postgres psql -U scaleurl -d scaleurl \
  -c "INSERT INTO urls (code, original_url, created_at, expires_at) VALUES ('expd1', 'https://example.com', now() - interval '2 days', now() - interval '1 day')"
curl -i http://127.0.0.1:3000/expd1      # 410
```

Redirect behavior is covered by unit tests in `tests/redirect.test.ts` and `tests/url-repository.test.ts` with mocked dependencies. No live PostgreSQL is needed for `npm test`.

## Redirect cache (Phase 4)

Redirects use a cache-aside strategy in Redis (`src/urls/url.cache.ts`):

1. Validate the short code. Malformed codes return 404 without touching Redis or PostgreSQL.
2. `GET scaleurl:url:<code>` from Redis. A valid, active, unexpired entry redirects immediately with no database query.
3. On a miss, or when the entry is malformed, inactive or past its `expiresAt`, query PostgreSQL.
4. If PostgreSQL returns an active, unexpired URL, `SET scaleurl:url:<code> <json> EX <ttl>` and redirect.
5. Unknown, inactive and expired URLs and database errors are never cached.

**Key format:** `scaleurl:url:<code>`. It is built only by `urlCacheKey()`; the `scaleurl:url:` namespace keeps it apart from future Redis features such as rate limiting.

**Value format:** JSON containing only what a redirect needs. No IDs, user IDs or timestamps other than the expiry are cached.

```json
{ "originalUrl": "https://example.com/path", "isActive": true, "expiresAt": null }
```

`expiresAt` is an ISO-8601 string or `null`. Each read is validated with Zod: the URL must be http(s), `isActive` must be a boolean, and `expiresAt` must be a date or `null`. Anything else is logged and treated as a miss, and the next PostgreSQL result overwrites it.

**TTL and expiration:**

- Every entry is written with `EX`; there are no permanent keys.
- TTL = `min(URL_CACHE_TTL_SECONDS, floor(expires_in_seconds))`, where `expires_in_seconds` comes from PostgreSQL's clock. A URL that expires in 60 seconds is cached for at most 60 seconds even when the configured TTL is 300.
- URLs with less than one second left, or already expired, are not cached.
- On a cache hit, `expiresAt` is also checked against the API host clock. An entry past its expiry falls through to PostgreSQL, which makes the final decision.

**Invalidation and consistency:** the API currently has no operation that updates, deactivates or deletes URLs, so no invalidation code exists yet. A future mutation must delete `scaleurl:url:<code>` after its database transaction commits. Until then, a row changed directly in PostgreSQL (for example `UPDATE urls SET is_active = false`) can still redirect from Redis until its cache entry expires, at most `URL_CACHE_TTL_SECONDS`. To force it, run `redis-cli DEL scaleurl:url:<code>`.

**Redis failures:** Redis is an optimization for redirects, not a requirement:

- GET errors, timeouts or a disconnected client are treated as a miss, and the request is served from PostgreSQL.
- SET errors are swallowed after logging, and the redirect still succeeds.
- Errors are logged at `warn` with credentials redacted. Logs are throttled to one line per 30 seconds per process, with a count of suppressed errors, so an outage does not flood the logs.
- Clients never see Redis errors.
- The Redis client fails commands immediately while disconnected (offline queue disabled; 2-second command timeout) and keeps reconnecting with capped backoff. Both the cache and `/health/ready` recover on their own when Redis returns. Readiness semantics are unchanged: `/health/ready` still reports 503 while Redis is down, even though redirects keep working.

Run with `LOG_LEVEL=debug` to see a `redirect resolved` log line with `"source":"cache"` or `"source":"database"` for each redirect.

### Test caching locally

```bash
LOG_LEVEL=debug npm run dev

curl -s -X POST http://127.0.0.1:3000/api/v1/urls \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'

curl -i http://127.0.0.1:3000/<code>    # 1st: "source":"database" in the logs
curl -i http://127.0.0.1:3000/<code>    # 2nd: "source":"cache"

docker compose exec redis redis-cli GET scaleurl:url:<code>
docker compose exec redis redis-cli TTL scaleurl:url:<code>   # <= URL_CACHE_TTL_SECONDS

docker compose stop redis
curl -i http://127.0.0.1:3000/<code>    # still 302, served from PostgreSQL
curl -i http://127.0.0.1:3000/health/ready   # 503 (Redis is still a readiness dependency)
docker compose start redis
```

Cache behavior is unit-tested with mocked Redis and PostgreSQL in `tests/url-cache.test.ts` and `tests/redirect-cache.test.ts`.

## Rate limiting (Phase 5)

### Algorithm

Each request to a limited route runs one atomic Redis Lua script (`RATE_LIMIT_SCRIPT` in `src/plugins/redis.ts`, sent with `EVALSHA`):

```lua
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end  -- window starts on first hit
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end  -- repair a key with no TTL
return {count, ttl}
```

The request is allowed when `count <= max`. Because Redis runs the script atomically, concurrent requests on any number of API instances each get a distinct count, so they cannot get past the limit together. There is one Redis round trip per request and no database access. The hook runs in `onRequest`, before body parsing and the route handler.

This is a **fixed window anchored at each client's first request**, not a sliding window. A client can send up to `2 × max` requests in a short burst that spans the end of one window and the start of the next. Rejected requests still increment the counter, but they do not extend the window.

### Policies

| Route | Policy name | Default | Variables |
| --- | --- | --- | --- |
| `POST /api/v1/urls` | `create-url` | 20 requests / 60 s per client IP | `CREATE_URL_RATE_LIMIT_MAX`, `CREATE_URL_RATE_LIMIT_WINDOW_SECONDS` |
| `GET /:code` | `redirect` | 120 requests / 60 s per client IP | `REDIRECT_RATE_LIMIT_MAX`, `REDIRECT_RATE_LIMIT_WINDOW_SECONDS` |
| `/health/live`, `/health/ready` | none | not limited | none |

URL creation is stricter because each request writes to PostgreSQL. These are development defaults, not tuned production values. Adjust them for real traffic, especially for many users behind one NAT, which share one IP. All four values must be positive integers; anything else fails startup validation. `GET /:code` matches every single-segment path, so unknown and malformed codes count against the redirect policy too.

### Redis key format

```
scaleurl:ratelimit:<policy>:<client-id>
e.g. scaleurl:ratelimit:create-url:203.0.113.7
     scaleurl:ratelimit:redirect:2001:db8::1
```

- Keys are built only by `rateLimitKey()`. The `scaleurl:ratelimit:` prefix keeps them separate from `scaleurl:url:` cache keys.
- The value is just the integer counter. Its TTL is the time left in the window.
- `<client-id>` is the normalized client IP. IPv4-mapped IPv6 (`::ffff:203.0.113.7`) becomes plain IPv4, IPv6 is lowercased and compressed, and zone IDs are dropped.
- A value that is not a valid IP maps to `unknown`. This means user-controlled text never reaches the key, so no hashing is needed.

### Client identity and proxies

The client identity is Fastify's `request.ip`. By default (`TRUST_PROXY=false`), this is the TCP peer address and `X-Forwarded-For` is ignored, so clients cannot pick their own identity.

When the API runs behind a reverse proxy or load balancer, every request appears to come from the proxy's IP. In that case, set `TRUST_PROXY` to the proxy's addresses:

```dotenv
TRUST_PROXY=10.0.0.5                 # a single proxy
TRUST_PROXY=10.0.0.0/8,172.16.0.0/12 # proxy subnets
TRUST_PROXY=loopback                 # proxy on the same host (127.0.0.1/8, ::1)
```

- Fastify then reads `X-Forwarded-For` from right to left, skipping trusted hops. The first untrusted address becomes the client IP, so a client cannot spoof extra hops in front of the proxy.
- Accepted values are `false`, or a comma-separated list of IPs, CIDR ranges with a prefix of 1 or more, `loopback`, `linklocal` or `uniquelocal`.
- `true`, `*`, hop counts and `/0` ranges are rejected, because they would trust headers from any client.
- Only list addresses that really are your proxies. The proxy must overwrite or append `X-Forwarded-For`, not pass a client-supplied value through unchanged.

### Response headers

Every limited response, allowed or rejected, includes:

| Header | Meaning |
| --- | --- |
| `RateLimit-Limit` | `max` for this route's policy |
| `RateLimit-Remaining` | requests left in the current window (never negative) |
| `RateLimit-Reset` | seconds until the window resets (rounded up, at least 1) |
| `Retry-After` | only on 429; same value as `RateLimit-Reset` |

Rejected requests get `429 Too Many Requests` with the standard error body. The route handler does not run, so a rejected `POST` never touches PostgreSQL.

```json
{ "statusCode": 429, "error": "Too Many Requests", "message": "Rate limit exceeded. Try again in 42 seconds." }
```

### Redis outages: fail-open

If the script fails (Redis down, timeout or unexpected reply), the request is **allowed** without `RateLimit-*` headers. Clients never see Redis errors.

- A warning (`rate limiter unavailable; allowing request`) is logged with credentials redacted. Logs are throttled to one line per 30 seconds with a suppressed-error count.
- This trade-off favors availability over protection: **rate limiting is bypassed while Redis is unavailable**.
- `/health/ready` reports 503 during the outage, so a load balancer can still react.
- The redirect cache keeps its Phase 4 fallback behavior.

### Test rate limiting locally

```bash
CREATE_URL_RATE_LIMIT_MAX=3 npm run dev

for i in 1 2 3 4; do
  curl -s -o /dev/null -D - -X POST http://127.0.0.1:3000/api/v1/urls \
    -H 'content-type: application/json' -d '{"url":"https://example.com"}' \
    | grep -iE '^HTTP|^ratelimit|^retry-after'
done                                   # 4th request: HTTP/1.1 429 + Retry-After

docker compose exec redis redis-cli --scan --pattern 'scaleurl:ratelimit:*'
docker compose exec redis redis-cli TTL scaleurl:ratelimit:create-url:127.0.0.1
docker compose exec redis redis-cli DEL scaleurl:ratelimit:create-url:127.0.0.1   # reset

docker compose stop redis              # requests now succeed without RateLimit-* headers
docker compose start redis
```

## Limitations

- Authentication, API keys, analytics, custom aliases, expiration cleanup, and load-test infrastructure are not implemented.
- Codes are sequential (`1`, `2`, ... `10`, ...), so they are short but enumerable. Do not treat short codes as secrets.
- Creating a URL takes two database round trips (`nextval` and `INSERT`). Redirects query PostgreSQL only on a cache miss.
- Cache entries are not invalidated automatically yet (no URL mutation API exists). Rows changed directly in the database can be served stale from Redis for up to `URL_CACHE_TTL_SECONDS`.
- There is no protection against a burst of concurrent misses for one code (no locking or request coalescing). Each miss queries PostgreSQL once.
- Rate limiting is a per-IP fixed window. It allows bursts of up to twice the limit across a window boundary, it treats clients behind one NAT as a single client, and limiting per IPv6 address is weak because one user often controls a whole /64. It is bypassed while Redis is down.
- No performance numbers (RPS, latency, hit rate) have been measured. Do not treat the current phases as evidence of 5,000 RPS capacity.
