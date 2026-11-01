// Snapshot helpers shared by the Claw Watch sources: canonical JSON and its sha256.
//
// A snapshot's `snapshot_sha256` is the sha256 of the canonical JSON of the watched content, so
// two polls that saw the same keys / API wallets have the same hash, and a stored baseline can be
// checked for corruption before it is trusted.
import { createHash } from "node:crypto";

/** JSON with object keys sorted at every level (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function snapshotSha256(content: unknown): string {
  return sha256Hex(canonicalJson(content));
}

/** Compare by code unit, independent of locale (stable sort order for snapshot lists). */
export function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
