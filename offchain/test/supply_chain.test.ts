// Supply-chain pins (design question Q-32): near-sandbox 0.3.4 pins tar 7.5.13, which has
// published advisories up to 7.5.20 (GHSA-vmf3-w455-68vh, GHSA-w8wr-v893-vjvp, GHSA-23hp-3jrh-7fpw,
// GHSA-8x88-c5mf-7j5w, GHSA-gvwx-54wh-qm9j, GHSA-r292-9mhp-454m). package.json overrides it to tar
// 7.5.22 for near-sandbox only; these tests fail if the override or the lockfile entry goes away.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as Record<string, unknown>;

const pkg = readJson("../package.json") as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};
const lock = readJson("../package-lock.json") as { packages: Record<string, { version?: string }> };

/** Last tar version named by any advisory above (all ranges are "<= 7.5.x"). */
const LAST_AFFECTED_TAR = [7, 5, 20] as const;

const parse = (v: string): number[] => {
  expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  return v.split(".").map(Number);
};
const newerThan = (a: number[], b: readonly number[]): boolean => {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
};

describe("supply chain (Q-32)", () => {
  it("overrides tar for near-sandbox to the exact version 7.5.22", () => {
    expect(pkg.overrides).toEqual({ "near-sandbox": { tar: "7.5.22" } });
  });

  it("keeps near-sandbox pinned exactly, so the override is revisited when it changes", () => {
    expect(pkg.devDependencies?.["near-sandbox"] ?? pkg.dependencies?.["near-sandbox"]).toBe("0.3.4");
  });

  it("locks every tar in the tree to a version after the last affected one", () => {
    const tars = Object.entries(lock.packages).filter(([path]) => path === "node_modules/tar" || path.endsWith("/node_modules/tar"));
    expect(tars.length).toBeGreaterThan(0);
    for (const [path, entry] of tars) {
      expect(newerThan(parse(entry.version ?? ""), LAST_AFFECTED_TAR), `${path} ${entry.version}`).toBe(true);
    }
  });
});
