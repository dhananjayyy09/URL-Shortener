import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../src/types/ports.js";
import { UrlRepository } from "../src/urls/url.repository.js";

type QueryFn = (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;

function createDb(handler: QueryFn) {
  const query = vi.fn(handler);
  return { db: { query } as unknown as Queryable, query };
}

function uniqueViolation(): Error {
  return Object.assign(new Error("duplicate key value"), {
    code: "23505",
    constraint: "urls_code_key",
  });
}

describe("UrlRepository.create", () => {
  const createdAt = new Date("2026-11-21T10:00:00.000Z");

  it("derives the code from the database id and inserts with parameters", async () => {
    const { db, query } = createDb(async (text, values) => {
      if (text.includes("nextval")) {
        return { rows: [{ id: "9007199254740993" }] };
      }
      return {
        rows: [
          {
            id: values?.[0],
            code: values?.[1],
            original_url: values?.[2],
            created_at: createdAt,
          },
        ],
      };
    });

    const created = await new UrlRepository(db).create(
      "https://example.com/?q=1'; DROP TABLE urls;--",
    );

    expect(created).toEqual({
      id: "9007199254740993",
      code: "FfGNdXsE9",
      originalUrl: "https://example.com/?q=1'; DROP TABLE urls;--",
      createdAt,
    });

    const [insertSql, insertValues] = query.mock.calls[1] ?? [];
    expect(insertSql).toContain("VALUES ($1, $2, $3)");
    expect(insertSql).not.toContain("example.com");
    expect(insertValues).toEqual([
      "9007199254740993",
      "FfGNdXsE9",
      "https://example.com/?q=1'; DROP TABLE urls;--",
    ]);
  });

  it("retries with a fresh id when the code collides", async () => {
    const ids = ["1", "2"];
    let inserts = 0;
    const { db, query } = createDb(async (text, values) => {
      if (text.includes("nextval")) {
        return { rows: [{ id: ids.shift() }] };
      }
      inserts += 1;
      if (inserts === 1) {
        throw uniqueViolation();
      }
      return {
        rows: [
          {
            id: values?.[0],
            code: values?.[1],
            original_url: values?.[2],
            created_at: createdAt,
          },
        ],
      };
    });

    const created = await new UrlRepository(db).create("https://example.com");

    expect(created.code).toBe("2");
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("gives up after repeated collisions", async () => {
    let id = 0;
    const { db } = createDb(async (text) => {
      if (text.includes("nextval")) {
        id += 1;
        return { rows: [{ id: String(id) }] };
      }
      throw uniqueViolation();
    });

    await expect(
      new UrlRepository(db).create("https://example.com"),
    ).rejects.toMatchObject({ code: "23505" });
    expect(id).toBe(3);
  });

  it("does not retry other database errors", async () => {
    const { db, query } = createDb(async (text) => {
      if (text.includes("nextval")) {
        return { rows: [{ id: "1" }] };
      }
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    });

    await expect(
      new UrlRepository(db).create("https://example.com"),
    ).rejects.toThrow("connection lost");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
