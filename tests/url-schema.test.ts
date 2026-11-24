import { describe, expect, it } from "vitest";
import {
  createUrlBodySchema,
  isValidShortCode,
  MAX_CODE_LENGTH,
  MAX_URL_LENGTH,
} from "../src/urls/url.schema.js";

function firstIssue(body: unknown): string | undefined {
  const result = createUrlBodySchema.safeParse(body);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe("URL creation body schema", () => {
  it("accepts http and https URLs unchanged", () => {
    for (const url of [
      "http://example.com",
      "https://example.com/some/long/path?q=1&r=two#frag",
    ]) {
      const result = createUrlBodySchema.safeParse({ url });
      expect(result.success).toBe(true);
      expect(result.data?.url).toBe(url);
    }
  });

  it("rejects a missing or non-string url", () => {
    expect(firstIssue({})).toMatch(/url is required/);
    expect(firstIssue({ url: 42 })).toMatch(/must be a string/);
  });

  it("rejects empty and whitespace-only urls", () => {
    expect(firstIssue({ url: "" })).toMatch(/must not be empty/);
    expect(firstIssue({ url: "   " })).toMatch(/must not be empty/);
  });

  it("rejects urls with surrounding or embedded whitespace/control characters", () => {
    expect(firstIssue({ url: " https://example.com" })).toMatch(/whitespace/);
    expect(firstIssue({ url: "https://exa\nmple.com" })).toMatch(/whitespace/);
    expect(firstIssue({ url: "https://example.com/\u0000" })).toMatch(
      /control/,
    );
  });

  it("rejects malformed and relative urls", () => {
    expect(firstIssue({ url: "not a url" })).toBeDefined();
    expect(firstIssue({ url: "example.com" })).toMatch(/valid absolute URL/);
    expect(firstIssue({ url: "/relative/path" })).toMatch(/valid absolute URL/);
    expect(firstIssue({ url: "https://" })).toMatch(/valid absolute URL/);
  });

  it("rejects unsupported protocols", () => {
    for (const url of [
      "ftp://example.com/file",
      "javascript:alert(1)",
      "mailto:someone@example.com",
      "file:///etc/passwd",
    ]) {
      expect(firstIssue({ url })).toBeDefined();
    }
    expect(firstIssue({ url: "ftp://example.com/file" })).toMatch(
      /http or https/,
    );
  });

  it("enforces the maximum url length", () => {
    const base = "https://example.com/";
    const atLimit = base + "a".repeat(MAX_URL_LENGTH - base.length);
    expect(createUrlBodySchema.safeParse({ url: atLimit }).success).toBe(true);
    expect(firstIssue({ url: `${atLimit}a` })).toMatch(/at most/);
  });
});

describe("short code validation", () => {
  it("accepts Base62 codes up to the column length", () => {
    expect(MAX_CODE_LENGTH).toBe(16);
    expect(isValidShortCode("1")).toBe(true);
    expect(isValidShortCode("aZ09")).toBe(true);
    expect(isValidShortCode("a".repeat(16))).toBe(true);
  });

  it("rejects empty, too long and non-Base62 codes", () => {
    expect(isValidShortCode("")).toBe(false);
    expect(isValidShortCode("a".repeat(17))).toBe(false);
    for (const code of ["abc-1", "a b", "a/b", "ünï", "a.b", "a%20"]) {
      expect(isValidShortCode(code)).toBe(false);
    }
  });
});
