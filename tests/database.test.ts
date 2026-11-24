import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { Database } from "../src/plugins/database.js";

function createPool(query: (text: string) => Promise<unknown>) {
  const fn = vi.fn(query);
  return { pool: { query: fn } as unknown as pg.Pool, query: fn };
}

describe("Database.migrationsApplied", () => {
  const expected = ["0001_create_urls.sql", "0002_next.sql"];

  it("is true only when every expected migration is recorded, then caches it", async () => {
    let names = ["0001_create_urls.sql"];
    const { pool, query } = createPool(async () => ({
      rows: names.map((name) => ({ name })),
    }));
    const db = new Database(pool, expected);

    await expect(db.migrationsApplied()).resolves.toBe(false);
    names = [...expected];
    await expect(db.migrationsApplied()).resolves.toBe(true);
    await expect(db.migrationsApplied()).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("is false when the tracking table does not exist", async () => {
    const { pool } = createPool(async () => {
      throw Object.assign(new Error('relation "schema_migrations" does not exist'), {
        code: "42P01",
      });
    });

    await expect(new Database(pool, expected).migrationsApplied()).resolves.toBe(false);
  });
});
