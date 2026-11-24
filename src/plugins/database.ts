import pg from "pg";
import type { DatabasePort, Queryable } from "../types/ports.js";

const HEALTH_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("PostgreSQL health check timed out"));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class Database implements DatabasePort, Queryable {
  private closed = false;
  private migrated = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly expectedMigrations: readonly string[] = [],
  ) {}

  static create(
    databaseUrl: string,
    expectedMigrations: readonly string[] = [],
  ): Database {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });

    pool.on("error", () => {
      // Idle-client disconnects must not crash the process; readiness reports them.
    });

    return new Database(pool, expectedMigrations);
  }

  query<R extends pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  async verify(): Promise<void> {
    const healthy = await this.ping();
    if (!healthy) {
      throw new Error("PostgreSQL is not reachable");
    }
  }

  async ping(): Promise<boolean> {
    try {
      await withTimeout(this.pool.query("SELECT 1"), HEALTH_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  // Applied migrations never disappear, so a positive result is cached.
  async migrationsApplied(): Promise<boolean> {
    if (this.migrated) {
      return true;
    }

    try {
      const { rows } = await withTimeout(
        this.pool.query<{ name: string }>("SELECT name FROM schema_migrations"),
        HEALTH_TIMEOUT_MS,
      );
      const applied = new Set(rows.map((row) => row.name));
      this.migrated = this.expectedMigrations.every((name) => applied.has(name));
      return this.migrated;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.pool.end();
  }
}
