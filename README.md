# ScaleURL

ScaleURL is a production-oriented URL shortening service. The long-term goal is to support a defined high-throughput workload in later phases. This repository currently implements **Phase 1 only**: a type-safe Fastify foundation, configuration, Dockerized PostgreSQL and Redis, health checks, and graceful shutdown.

Phase 1 does **not** shorten URLs, cache redirects, rate-limit traffic, or claim any requests-per-second capacity.

## Current scope (Phase 1)

- Node.js + TypeScript (strict) backend bootstrap
- Fastify application factory suitable for tests (`inject()` without binding a port)
- Zod-validated environment configuration
- PostgreSQL connection pool (`pg.Pool`) with startup and readiness checks
- Redis client (`ioredis`) with startup and readiness checks
- Liveness and readiness HTTP endpoints
- Docker Compose development infrastructure
- Vitest unit tests with mocked dependencies

### Deferred to later phases

- URL creation, PostgreSQL URL schema, and Base62 short codes
- HTTP redirects
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

## Local development (API on the host)

Keep PostgreSQL and Redis running in Compose, then:

```bash
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

Unit tests mock PostgreSQL and Redis. They do not require Docker.

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

Phase 1 is a foundation. It does not implement URL shortening, redirects, caching, rate limiting, authentication, migrations, or load-test infrastructure. Do not treat this phase as evidence of 5,000 RPS capacity.
