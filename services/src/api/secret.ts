import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Compares a presented token with the real one in constant time, so response timing reveals nothing about it. */
export function sameSecret(presented: string | undefined | null, real: string | undefined | null): boolean {
  if (!presented || !real) return false;
  return timingSafeEqual(digest(presented), digest(real));
}
