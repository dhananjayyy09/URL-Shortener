# ScaleURL

ScaleURL is a production-oriented URL shortening service. The long-term goal is to support a defined high-throughput workload in later phases. This repository currently implements:

- **Phase 1:** a type-safe Fastify foundation, configuration, Dockerized PostgreSQL and Redis, health checks, and graceful shutdown.
- **Phase 2:** the URL creation pipeline: raw SQL migrations, the `urls` table, database-derived Base62 short codes, and `POST /api/v1/urls`.

The service does **not** yet redirect short codes, cache, rate-limit traffic, or claim any requests-per-second capacity.

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

### Deferred to later phases

- HTTP redirects (`GET /:code`)
- Redis caching
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

Unit tests mock PostgreSQL and Redis. They do not require Docker. They cover environment validation, health routes, Base62 encoding, URL validation, the URL creation API, the URL repository (with a mocked query client), and the migration runner.

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

## Limitations

- Redirects (`GET /:code`), caching, rate limiting, authentication, analytics, custom aliases, expiration cleanup, and load-test infrastructure are not implemented.
- Codes are sequential (`1`, `2`, ... `10`, ...), so they are short but enumerable. Do not treat short codes as secrets.
- Creating a URL takes two database round trips (`nextval` and `INSERT`).
- No performance numbers have been measured. Do not treat the current phases as evidence of 5,000 RPS capacity.
