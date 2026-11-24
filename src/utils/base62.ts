import { randomInt } from "node:crypto";

export const BASE62_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const BASE = BigInt(BASE62_ALPHABET.length);

const CHAR_VALUES = new Map<string, bigint>(
  Array.from(BASE62_ALPHABET, (char, index) => [char, BigInt(index)]),
);

export function isBase62(value: string): boolean {
  if (value.length === 0) {
    return false;
  }

  for (const char of value) {
    if (!CHAR_VALUES.has(char)) {
      return false;
    }
  }

  return true;
}

export function encodeBase62(value: bigint): string {
  if (value < 0n) {
    throw new RangeError("Base62 encoding requires a non-negative integer");
  }

  if (value === 0n) {
    return BASE62_ALPHABET.charAt(0);
  }

  let remaining = value;
  let encoded = "";

  while (remaining > 0n) {
    encoded = BASE62_ALPHABET.charAt(Number(remaining % BASE)) + encoded;
    remaining /= BASE;
  }

  return encoded;
}

export const SHORT_CODE_LENGTH = 7;

// 62^7 ≈ 3.5 trillion codes drawn from a CSPRNG, so codes are not enumerable.
export function generateShortCode(
  length: number = SHORT_CODE_LENGTH,
  nextIndex: (max: number) => number = randomInt,
): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += BASE62_ALPHABET.charAt(nextIndex(BASE62_ALPHABET.length));
  }
  return code;
}

export function decodeBase62(value: string): bigint {
  if (!isBase62(value)) {
    throw new RangeError("Value is not a valid Base62 string");
  }

  let decoded = 0n;
  for (const char of value) {
    decoded = decoded * BASE + (CHAR_VALUES.get(char) ?? 0n);
  }

  return decoded;
}
