import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMigrations,
  runMigrations,
  type Migration,
  type MigrationClient,
} from "../src/db/migrator.js";

const logger = { info: () => undefined };

function createClient(
  applied: { name: string; checksum: string }[] = [],
  failOn?: string,
) {
  const statements: string[] = [];
  const client: MigrationClient = {
    async query(text) {
      statements.push(text.trim());
      if (text.startsWith("SELECT name, checksum")) {
        return { rows: applied };
      }
      if (failOn && text === failOn) {
        throw new Error("syntax error");
      }
      return { rows: [] };
    },
  };
  return { client, statements };
}

const migrations: Migration[] = [
  { name: "0001_a.sql", sql: "CREATE TABLE a ()", checksum: "c1" },
  { name: "0002_b.sql", sql: "CREATE TABLE b ()", checksum: "c2" },
];

describe("migration runner", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("loads the bundled migrations in order", async () => {
    const dir = fileURLToPath(new URL("../migrations", import.meta.url));
    const loaded = await loadMigrations(dir);

    expect(loaded.map((m) => m.name)).toEqual(["0001_create_urls.sql"]);
    expect(loaded[0]?.sql).toContain("CREATE TABLE urls");
    expect(loaded[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sorts files deterministically and rejects bad names", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "scaleurl-migrations-"));
    await writeFile(path.join(tempDir, "0002_second.sql"), "SELECT 2");
    await writeFile(path.join(tempDir, "0001_first.sql"), "SELECT 1");
    await writeFile(path.join(tempDir, "README.txt"), "ignored");

    expect((await loadMigrations(tempDir)).map((m) => m.name)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);

    await writeFile(path.join(tempDir, "bad name.sql"), "SELECT 3");
    await expect(loadMigrations(tempDir)).rejects.toThrow(
      /Invalid migration file name/,
    );
  });

  it("applies pending migrations in transactions under an advisory lock", async () => {
    const { client, statements } = createClient();

    const applied = await runMigrations(client, migrations, logger);

    expect(applied).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(statements[0]).toContain("pg_advisory_lock");
    expect(statements.at(-1)).toContain("pg_advisory_unlock");
    const body = statements.filter(
      (s) =>
        !s.includes("advisory") && !s.startsWith("CREATE TABLE IF NOT EXISTS"),
    );
    expect(body.slice(1)).toEqual([
      "BEGIN",
      "CREATE TABLE a ()",
      "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
      "COMMIT",
      "BEGIN",
      "CREATE TABLE b ()",
      "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
      "COMMIT",
    ]);
  });

  it("skips migrations that were already applied", async () => {
    const { client, statements } = createClient([
      { name: "0001_a.sql", checksum: "c1" },
    ]);

    const applied = await runMigrations(client, migrations, logger);

    expect(applied).toEqual(["0002_b.sql"]);
    expect(statements).not.toContain("CREATE TABLE a ()");
  });

  it("fails if an applied migration was modified", async () => {
    const { client, statements } = createClient([
      { name: "0001_a.sql", checksum: "changed" },
    ]);

    await expect(runMigrations(client, migrations, logger)).rejects.toThrow(
      /modified after it was applied/,
    );
    expect(statements.at(-1)).toContain("pg_advisory_unlock");
  });

  it("rolls back and stops when a migration fails", async () => {
    const { client, statements } = createClient([], "CREATE TABLE a ()");

    await expect(runMigrations(client, migrations, logger)).rejects.toThrow(
      /Migration 0001_a.sql failed: syntax error/,
    );
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("CREATE TABLE b ()");
    expect(statements.at(-1)).toContain("pg_advisory_unlock");
  });
});
