import { describe, expect, it } from "vitest";
import {
  BASE62_ALPHABET,
  decodeBase62,
  encodeBase62,
  isBase62,
} from "../src/utils/base62.js";

describe("base62", () => {
  it("uses the documented 62-character alphabet", () => {
    expect(BASE62_ALPHABET).toBe(
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    );
    expect(new Set(BASE62_ALPHABET).size).toBe(62);
  });

  it.each([
    [0n, "0"],
    [1n, "1"],
    [10n, "a"],
    [36n, "A"],
    [61n, "Z"],
    [62n, "10"],
    [125n, "21"],
    [3844n, "100"],
    [1_000_000n, "4c92"],
  ])("encodes %s as %s", (value, expected) => {
    expect(encodeBase62(value)).toBe(expected);
    expect(decodeBase62(expected)).toBe(value);
  });

  it("encodes values beyond Number.MAX_SAFE_INTEGER without precision loss", () => {
    expect(encodeBase62(2n ** 53n + 1n)).toBe("FfGNdXsE9");
    expect(encodeBase62(9_223_372_036_854_775_807n)).toBe("aZl8N0y58M7");
  });

  it("produces at most 11 characters for any PostgreSQL BIGINT", () => {
    expect(encodeBase62(9_223_372_036_854_775_807n)).toHaveLength(11);
  });

  it("round-trips a range of values", () => {
    const values = [2n, 63n, 99_999n, 2n ** 32n, 2n ** 62n + 12_345n];
    for (const value of values) {
      expect(decodeBase62(encodeBase62(value))).toBe(value);
    }
  });

  it("rejects negative values", () => {
    expect(() => encodeBase62(-1n)).toThrow(RangeError);
  });

  it("validates Base62 strings", () => {
    expect(isBase62("abcXYZ019")).toBe(true);
    expect(isBase62("")).toBe(false);
    expect(isBase62("abc-def")).toBe(false);
    expect(isBase62("abc def")).toBe(false);
    expect(() => decodeBase62("ab_c")).toThrow(RangeError);
  });
});
