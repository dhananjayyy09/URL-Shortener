import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv, parseDatabaseEnv } from "../config/env.js";
import { loadMigrations, runMigrations } from "../db/migrator.js";
import { redactErrorMessage } from "../utils/redact.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

async function main(): Promise<void> {
  loadLocalEnv();
  const { DATABASE_URL } = parseDatabaseEnv(process.env);

  const client = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  client.on("error", () => {
    // Errors surface through the awaited queries below.
  });

  try {
    await client.connect();
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    const applied = await runMigrations(client, migrations, {
      info: (message) => console.log(message),
    });

    console.log(
      applied.length === 0
        ? "Database schema is up to date"
        : `Applied ${applied.length} migration(s)`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed:", redactErrorMessage(error));
  process.exit(1);
});
