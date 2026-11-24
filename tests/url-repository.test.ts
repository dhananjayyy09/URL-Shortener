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

  function insertedRow(values?: unknown[]) {
    return {
      rows: [
        {
          id: "42",
          code: values?.[0],
          original_url: values?.[1],
          created_at: createdAt,
        },
      ],
    };
  }

  it("inserts a generated code in a single parameterized statement", async () => {
    const { db, query } = createDb(async (_text, values) => insertedRow(values));

    const created = await new UrlRepository(db, () => "aB3dE5g").create(
      "https://example.com/?q=1'; DROP TABLE urls;--",
    );

    expect(created).toEqual({
      id: "42",
      code: "aB3dE5g",
      originalUrl: "https://example.com/?q=1'; DROP TABLE urls;--",
      createdAt,
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [insertSql, insertValues] = query.mock.calls[0] ?? [];
    expect(insertSql).toContain("VALUES ($1, $2)");
    expect(insertSql).not.toMatch(/nextval|OVERRIDING/);
    expect(insertSql).not.toContain("example.com");
    expect(insertValues).toEqual([
      "aB3dE5g",
      "https://example.com/?q=1'; DROP TABLE urls;--",
    ]);
  });

  it("uses random 7-character Base62 codes by default", async () => {
    const { db } = createDb(async (_text, values) => insertedRow(values));
    const repository = new UrlRepository(db);

    const codes = await Promise.all(
      Array.from({ length: 50 }, () => repository.create("https://example.com")),
    );

    for (const { code } of codes) {
      expect(code).toMatch(/^[0-9a-zA-Z]{7}$/);
    }
    expect(new Set(codes.map(({ code }) => code)).size).toBe(50);
  });

  it("retries with a new code when the code collides", async () => {
    const codes = ["collide", "fresh01"];
    const { db, query } = createDb(async (_text, values) => {
      if (values?.[0] === "collide") {
        throw uniqueViolation();
      }
      return insertedRow(values);
    });

    const created = await new UrlRepository(db, () => codes.shift() ?? "x").create(
      "https://example.com",
    );

    expect(created.code).toBe("fresh01");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("gives up after repeated collisions", async () => {
    const { db, query } = createDb(async () => {
      throw uniqueViolation();
    });

    await expect(
      new UrlRepository(db, () => "same000").create("https://example.com"),
    ).rejects.toMatchObject({ code: "23505" });
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("does not retry other database errors", async () => {
    const { db, query } = createDb(async () => {
      throw Object.assign(new Error("connection lost"), { code: "08006" });
    });

    await expect(
      new UrlRepository(db).create("https://example.com"),
    ).rejects.toThrow("connection lost");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("UrlRepository.findRedirectTarget", () => {
  it("runs a single parameterized lookup by code using the database clock", async () => {
    const { db, query } = createDb(async () => ({
      rows: [
        {
          original_url: "https://example.com/path?q=1",
          is_active: true,
          is_expired: false,
          expires_at: new Date("2030-01-01T00:00:00.000Z"),
          expires_in_seconds: 120.5,
        },
      ],
    }));

    const result = await new UrlRepository(db).findRedirectTarget("abc123");

    expect(result).toEqual({
      originalUrl: "https://example.com/path?q=1",
      isActive: true,
      isExpired: false,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      expiresInSeconds: 120.5,
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(sql).toMatch(/WHERE code = \$1/);
    expect(sql).toContain("expires_at <= now()");
    expect(sql).toContain("expires_at - now()");
    expect(sql).toMatch(/CASE WHEN isfinite\(expires_at\)/);
    expect(sql).not.toMatch(/JOIN|SELECT \*/i);
    expect(sql).not.toContain("abc123");
    expect(values).toEqual(["abc123"]);
  });

  it("returns null when no row matches", async () => {
    const { db } = createDb(async () => ({ rows: [] }));

    await expect(
      new UrlRepository(db).findRedirectTarget("missing"),
    ).resolves.toBeNull();
  });

  it("propagates database errors", async () => {
    const { db } = createDb(async () => {
      throw new Error("connection terminated");
    });

    await expect(
      new UrlRepository(db).findRedirectTarget("abc"),
    ).rejects.toThrow("connection terminated");
  });
});
