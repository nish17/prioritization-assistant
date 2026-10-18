import { createHash, timingSafeEqual } from "node:crypto";

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Returns a matcher that compares candidates against the configured secret in constant time.
 * Both sides are hashed first, so a candidate of the wrong length is a plain mismatch, not an error.
 */
export function secretMatcher(secret: string): (candidate: unknown) => boolean {
  const expected = sha256(secret);
  return (candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 512) return false;
    return timingSafeEqual(sha256(candidate), expected);
  };
}
