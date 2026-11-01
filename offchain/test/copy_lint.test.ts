// scripts/copy_lint.sh: passes on the real tree, fails on planted banned
// copy. Planted files live in a temp dir created at runtime, and every banned word below is
// assembled from pieces, so this file itself commits no banned word.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/copy_lint.sh", import.meta.url));
const w = (...parts: string[]) => parts.join("");
const SAFE = w("sa", "fe");
const SCAM = w("sc", "am");
const USD = w("US", "D");

function lint(...paths: string[]) {
  const res = spawnSync("bash", [SCRIPT, ...paths], { encoding: "utf8", env: { ...process.env, NODE: process.execPath } });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "copy-lint-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
function plant(name: string, content: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("copy_lint.sh", () => {
  it("passes on the real tree", () => {
    const { code, out, err } = lint();
    expect(err).toBe("");
    expect(out).toMatch(/^copy_lint: OK \(\d+ files checked\)\n$/);
    expect(code).toBe(0);
  });

  it("fails on a planted banned word and prints file:line", () => {
    const file = plant("README.md", `# Title\nThis agent is ${SAFE} to use.\n`);
    const { code, out, err } = lint(file);
    expect(code).toBe(1);
    expect(out).toBe(`${file}:2: banned copy "${SAFE}": This agent is ${SAFE} to use.\n`);
    expect(err).toMatch(/1 banned word\(s\)/);
  });

  it("checks every banned word and pattern, case-insensitively, but not look-alikes", () => {
    const banned = [
      SAFE.toUpperCase(),
      SCAM,
      w("mali", "cious"),
      w("sec", "ure"),
      w("pre", "sale"),
      w("stak", "ing"),
      w("air", "drop"),
      w("$", "RCLAW"),
      w("$", "5"),
      USD,
      w("price", " target"),
    ];
    const file = plant("demo/copy.txt", banned.map((b) => `line with ${b} inside`).join("\n"));
    const { code, out } = lint(file);
    expect(code).toBe(1);
    expect(out.trim().split("\n")).toHaveLength(banned.length);
    banned.forEach((b, i) => expect(out).toContain(`${file}:${i + 1}: banned copy "${b}"`));

    const fine = plant("demo/fine.txt", `USDC, un${SAFE}, ${SAFE}ty, ${SAFE}_mode, ${SCAM}per, ${w("sec", "ured")}, $x\n`);
    expect(lint(fine)).toMatchObject({ code: 0 });
  });

  it("TypeScript: only string and template literals count, with the right line numbers", () => {
    const file = plant(
      "src/a.ts",
      [
        `// a ${SAFE} comment is not user-facing`,
        `/* neither is ${SAFE} here */`,
        `const ${SAFE}_flag = 1;`,
        `const msg = "Public signal: all good";`,
        `const bad = "this is ${SAFE}";`,
        "const t = `first line",
        `${SCAM} on the second line`,
        "${msg}`;",
      ].join("\n"),
    );
    const { code, out } = lint(file);
    expect(code).toBe(1);
    expect(out.trim().split("\n").map((l) => l.split(": banned")[0])).toEqual([`${file}:5`, `${file}:7`]);
  });

  it("docs/BASELINE.md may quote the official track brief, nothing else", () => {
    const quote = `Build spending limits, policy engines, sandboxed wallets, reputation and ${SCAM} detection.`;
    const file = plant("docs/BASELINE.md", `Official brief: "${quote}"\nOur own ${SCAM} line.\n`);
    const { code, out } = lint(file);
    expect(code).toBe(1);
    expect(out).toBe(`${file}:2: banned copy "${SCAM}": Our own ${SCAM} line.\n`);
    expect(lint(plant("docs/OTHER.md", `"${quote}"\n`)).code).toBe(1);
  });

  it("Rust: test modules (from #[cfg(test)]) are skipped", () => {
    const file = plant(
      "contracts/x/src/errors.rs",
      [`pub const M: &str = "Blocked by your rule: x";`, "#[cfg(test)]", "mod tests {", `    const BANNED: [&str; 1] = ["${SAFE}"];`, "}"].join("\n"),
    );
    expect(lint(file)).toMatchObject({ code: 0 });
    const leaky = plant("contracts/y/src/errors.rs", `pub const M: &str = "${SAFE} order";\n#[cfg(test)]\nmod tests {}\n`);
    expect(lint(leaky)).toMatchObject({ code: 1 });
  });

  // Regression: the default list missed contracts/mock-mpc/README.md and the messages printed by
  // the Makefile and the shell scripts.
  it("default list: every *.md, and quoted strings in Makefile, Dockerfile and scripts/*.sh", () => {
    const root = join(dir, "fake-repo");
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(root, "scripts", "copy_lint.sh"));
    const put = (name: string, content: string) => {
      mkdirSync(join(root, name, ".."), { recursive: true });
      writeFileSync(join(root, name), content);
    };
    const run = () => {
      const res = spawnSync("bash", [join(root, "scripts", "copy_lint.sh")], { encoding: "utf8", env: { ...process.env, NODE: process.execPath } });
      return { code: res.status, out: res.stdout };
    };
    put("README.md", "Public signal: new full-access key\n");
    put("contracts/mock-mpc/README.md", "Sandbox test key, worthless.\n");
    put("Makefile", ['# a comment may say the word ' + SAFE, "demo:", '\t@echo "make: usage $1 $${2} ok"', ""].join("\n"));
    put("scripts/sandbox_env.sh", ['#!/usr/bin/env bash', `# ${SAFE} in a comment is not printed`, 'echo "usage: $1 needs ${2:-x}" >&2', ""].join("\n"));
    put("target/x.md", `${SAFE}\n`);
    put("offchain/node_modules/p/readme.md", `${SAFE}\n`);
    expect(run()).toEqual({ code: 0, out: "copy_lint: OK (4 files checked)\n" });

    put("contracts/mock-mpc/README.md", `This mock is ${SAFE} to use.\n`);
    put("Makefile", ["demo:", `\t@echo "This target is ${w("sec", "ure")}."`, ""].join("\n"));
    put("scripts/sandbox_env.sh", ['#!/usr/bin/env bash', `echo "make: shim active (${SAFE}, sandbox only)" >&2`, `printf '%s\\n' 'costs ${w("$", "5")}'`, ""].join("\n"));
    put("Dockerfile", `LABEL description="${SCAM} free"\n`);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out.trim().split("\n").map((l) => l.split(": banned")[0]).sort()).toEqual([
      "Dockerfile:1",
      "Makefile:2",
      "contracts/mock-mpc/README.md:1",
      "scripts/sandbox_env.sh:2",
      "scripts/sandbox_env.sh:3",
    ]);
  });

  it("directories are walked (dependency folders skipped); a missing path is a usage error", () => {
    plant("tree/node_modules/pkg/readme.md", `${SAFE}\n`);
    plant("tree/ok.md", "Public signal: new full-access key on agent-1.test.near\n");
    expect(lint(join(dir, "tree"))).toMatchObject({ code: 0, out: "copy_lint: OK (1 files checked)\n" });
    const missing = lint(join(dir, "does-not-exist"));
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/no such file or directory/);
  });
});
