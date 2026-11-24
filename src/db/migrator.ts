import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface MigrationClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationLogger {
  info(message: string): void;
}

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

// Arbitrary constant shared by every migration runner so concurrent runs serialize.
const MIGRATION_LOCK_ID = 704_451_201;

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory);
  const files = entries.filter((entry) => entry.endsWith(".sql")).sort();

  const invalid = files.filter((file) => !MIGRATION_FILE_PATTERN.test(file));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid migration file name(s): ${invalid.join(", ")}. Expected NNNN_description.sql`,
    );
  }

  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(directory, file), "utf8");
      return {
        name: file,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function runMigrations(
  client: MigrationClient,
  migrations: Migration[],
  logger: MigrationLogger,
): Promise<string[]> {
  const applied: string[] = [];

  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const result = await client.query(
      "SELECT name, checksum FROM schema_migrations",
    );
    const existing = new Map(
      (result.rows as { name: string; checksum: string }[]).map((row) => [
        row.name,
        row.checksum,
      ]),
    );

    for (const migration of migrations) {
      const existingChecksum = existing.get(migration.name);

      if (existingChecksum !== undefined) {
        if (existingChecksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} was modified after it was applied`,
          );
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${migration.name} failed: ${error instanceof Error ? error.message : "unknown error"}`,
          { cause: error },
        );
      }

      logger.info(`Applied migration ${migration.name}`);
      applied.push(migration.name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  }

  return applied;
}
