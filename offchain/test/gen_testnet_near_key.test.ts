// gen-testnet-near-key CLI (owner decisions D-14, D-16): a fresh ed25519 key for
// the testnet agent or guardian goes only into the env file (mode 600), never into any output or
// error, and its public key is the one setup:testnet derives. It runs only with NEAR_NETWORK=testnet
// set explicitly (D-16); a repeated --role is refused. When the file it writes says testnet and has
// no NEAR_RPC_URL of its own, it also writes the default testnet RPC (owner request after the
// 31 Oct 2026 rerun). The atomic write (D-15) is covered in envfile_atomic.test.ts. Everything runs
// in a temp dir, no network.
// No key-shaped value is committed here: every key is made at run time.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { KeyPair, KeyPairEd25519 } from "near-api-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorText } from "../src/cli/common.js";
import { NEAR_KEY_ROLES, main, planNearRpcUrl } from "../src/cli/gen_testnet_near_key.js";
import { AGENT_METHODS, GUARDIAN_METHODS } from "../src/cli/setup.js";
import { DEFAULT_ENV_FILE, DEFAULT_TESTNET_RPC_URL, ENV_EXAMPLE_FILE, assertNoMainnetUrl, loadConfig } from "../src/config.js";
import { envFileValue } from "../src/envfile.js";
import { signerFromKey } from "../src/near.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const KEY_LINE = "The server never holds mainnet keys or signs for users.";
const USAGE = "Usage: npm --prefix offchain run gen-testnet-near-key -- --role agent|guardian|owner [--force] [--replace-owner-key]";
const ROLES = ["agent", "guardian"] as const;
const ALL_ROLES = ["agent", "guardian", "owner"] as const;
const RPC_SET_LINE = (p: string): string =>
  `Set NEAR_RPC_URL=https://rpc.testnet.near.org in ${p} (it was not set): the NEAR testnet RPC that setup:testnet and the other CLIs will use. Replace it with another testnet RPC if you prefer.`;

/** Capture console output for the duration of a test. */
function captureConsole(): string[] {
  const out: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
  }
  return out;
}

/** Every form of a NEAR ed25519 secret that must never be shown: `ed25519:<64 bytes>`, its base58 part, the 32-byte seed. */
function secretForms(keyString: string): string[] {
  const pair = KeyPair.fromString(keyString as `ed25519:${string}`);
  if (!(pair instanceof KeyPairEd25519)) throw new Error("not an ed25519 key");
  return [keyString, keyString.slice("ed25519:".length), pair.secretKey];
}

function expectNoSecret(text: string, keyString: string): void {
  for (const form of secretForms(keyString)) expect(text).not.toContain(form);
}

function printedPublicKey(out: string[]): string {
  const line = out.find((l) => l.startsWith("Public key: "));
  if (line === undefined) throw new Error(`no "Public key:" line in:\n${out.join("\n")}`);
  return line.slice("Public key: ".length);
}

let dir: string;
let envPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawguard-nearkey-"));
  envPath = join(dir, ".env");
  // Isolate from any developer shell: the real environment wins over the env file. D-16: the
  // command needs NEAR_NETWORK=testnet; tests of the refusal change or remove this.
  vi.stubEnv("NEAR_NETWORK", "testnet");
  for (const name of ["NEAR_RPC_URL", "CLAWGUARD_CONTRACT_ID", "AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY", "GUARDIAN_ACCOUNT_ID", "GUARDIAN_PRIVATE_KEY", "OWNER_ACCOUNT_ID", "OWNER_PRIVATE_KEY"]) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("gen-testnet-near-key CLI", () => {
  it.each(ROLES)("--role %s: writes only its variable (mode 600), prints only the public key", async (roleName) => {
    const role = NEAR_KEY_ROLES[roleName];
    const other = NEAR_KEY_ROLES[roleName === "agent" ? "guardian" : "agent"];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = captureConsole();
    expect(existsSync(envPath)).toBe(false); // .env does not exist yet: made from .env.example (testnet from the shell)
    await expect(main(["--role", roleName], envPath)).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    const template = readFileSync(ENV_EXAMPLE_FILE, "utf8");
    const written = readFileSync(envPath, "utf8");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    // Exactly three lines differ from the template (inline comments kept): NEAR_NETWORK, set to the
    // shell's testnet (D-16), NEAR_RPC_URL (the template's is empty) and the role's key line.
    const before = template.split("\n");
    const after = written.split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.flatMap((line, i) => (line === before[i] ? [] : [i]));
    expect(changed).toHaveLength(3);
    expect(after[changed[0] ?? -1]).toMatch(/^NEAR_NETWORK=testnet\s+#/);
    expect(after[changed[1] ?? -1]).toMatch(/^NEAR_RPC_URL=https:\/\/rpc\.testnet\.near\.org\s+#/);
    expect(after[changed[2] ?? -1]).toMatch(new RegExp(`^${role.keyName}=ed25519:[1-9A-HJ-NP-Za-km-z]+\\s+#`));
    expect(envFileValue(written, "NEAR_NETWORK")).toBe("testnet");
    expect(envFileValue(written, "NEAR_RPC_URL")).toBe(DEFAULT_TESTNET_RPC_URL);
    expect(envFileValue(written, other.keyName)).toBeUndefined();
    expect(envFileValue(written, "OWNER_PRIVATE_KEY")).toBeUndefined();

    // The key parses with near-api-js; its public key is the printed one and the one setup derives.
    const key = envFileValue(written, role.keyName) ?? "";
    const pair = KeyPair.fromString(key as `ed25519:${string}`);
    expect(pair).toBeInstanceOf(KeyPairEd25519);
    const printed = printedPublicKey(out);
    expect(printed).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(pair.getPublicKey().toString()).toBe(printed);
    expect((await signerFromKey(key).getPublicKey()).toString()).toBe(printed);
    // A signature made with it verifies under the printed public key.
    const message = new TextEncoder().encode("claw-guard test message");
    expect(pair.verify(message, pair.sign(message).signature)).toBe(true);

    const text = out.join("\n");
    expectNoSecret(text, key);
    expect(text).toContain(`Created ${envPath} from .env.example and set NEAR_NETWORK=testnet in it (it came from this shell)`);
    expect(out).toContain(RPC_SET_LINE(envPath));
    expect(text).toContain(`(${role.keyName}, file mode 600)`);
    expect(text).toContain(`as its ONLY key: a function-call key limited to the claw-guard contract (CLAWGUARD_CONTRACT_ID) and the method ${role.methods.join(", ")}. It is never a full-access key.`);
    expect(text).toContain(`${role.accountName} (e.g. ${role.accountExample})`);
    expect(out).toContain(KEY_LINE);
  });

  it("role methods match what setup:testnet puts on the keys", () => {
    expect(NEAR_KEY_ROLES.agent.methods).toEqual([...AGENT_METHODS]);
    expect(NEAR_KEY_ROLES.guardian.methods).toEqual([...GUARDIAN_METHODS]);
  });

  it("keeps every other value of an existing .env, and names the configured accounts", async () => {
    vi.stubEnv("NEAR_NETWORK", undefined); // testnet comes from the file (D-16)
    writeFileSync(
      envPath,
      "# my testnet settings\nNEAR_NETWORK=testnet\nOWNER_ACCOUNT_ID=owner.testnet\nCLAWGUARD_CONTRACT_ID=clawguard.owner.testnet\nAGENT_ACCOUNT_ID=agent-1.owner.testnet\n",
      { mode: 0o644 },
    );
    chmodSync(envPath, 0o644);
    const out = captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    await expect(main(["--role", "guardian"], envPath)).resolves.toBe(0);

    const written = readFileSync(envPath, "utf8");
    expect(statSync(envPath).mode & 0o777).toBe(0o600); // tightened from 644
    const lines = written.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "# my testnet settings",
      "NEAR_NETWORK=testnet",
      "OWNER_ACCOUNT_ID=owner.testnet",
      "CLAWGUARD_CONTRACT_ID=clawguard.owner.testnet",
      "AGENT_ACCOUNT_ID=agent-1.owner.testnet",
    ]);
    // The file had no NEAR_RPC_URL: the first run appends the default after its key; the second keeps it.
    expect(lines.slice(5)).toEqual([
      `AGENT_PRIVATE_KEY=${envFileValue(written, "AGENT_PRIVATE_KEY") ?? "missing"}`,
      "NEAR_RPC_URL=https://rpc.testnet.near.org",
      `GUARDIAN_PRIVATE_KEY=${envFileValue(written, "GUARDIAN_PRIVATE_KEY") ?? "missing"}`,
      "",
    ]);
    expect(out.filter((l) => l.startsWith("Set NEAR_RPC_URL="))).toEqual([RPC_SET_LINE(envPath)]); // once, first run only
    expect(envFileValue(written, "AGENT_PRIVATE_KEY")).not.toBe(envFileValue(written, "GUARDIAN_PRIVATE_KEY"));

    const text = out.join("\n");
    expectNoSecret(text, envFileValue(written, "AGENT_PRIVATE_KEY") ?? "");
    expectNoSecret(text, envFileValue(written, "GUARDIAN_PRIVATE_KEY") ?? "");
    expect(text).toContain("to agent-1.owner.testnet as its ONLY key: a function-call key limited to clawguard.owner.testnet and the method propose_order.");
    expect(text).toContain("to GUARDIAN_ACCOUNT_ID (e.g. guardian.<owner>.testnet) as its ONLY key: a function-call key limited to clawguard.owner.testnet and the method pause.");
    expect(text).toContain("setup:testnet creates the guardian only when GUARDIAN_ACCOUNT_ID is set");
    expect(text).not.toContain("Created "); // the file existed
    expect(text).not.toContain("Note: NEAR_NETWORK=testnet comes from this shell"); // the file says testnet
  });

  it("refuses to replace an existing key without --force (exit 1, names the variable); --force replaces it", async () => {
    const out = captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    await expect(main(["--role", "guardian"], envPath)).resolves.toBe(0);
    const first = readFileSync(envPath, "utf8");
    const firstAgent = envFileValue(first, "AGENT_PRIVATE_KEY");

    out.length = 0;
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe(first);
    expect(out.join("\n")).toContain(`AGENT_PRIVATE_KEY is already set in ${envPath}; pass --force to replace it.`);
    expectNoSecret(out.join("\n"), firstAgent ?? "");

    await expect(main(["--role", "agent", "--force"], envPath)).resolves.toBe(0);
    const second = readFileSync(envPath, "utf8");
    expect(envFileValue(second, "AGENT_PRIVATE_KEY")).not.toBe(firstAgent);
    expect(envFileValue(second, "GUARDIAN_PRIVATE_KEY")).toBe(envFileValue(first, "GUARDIAN_PRIVATE_KEY"));
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(printedPublicKey(out.slice(out.findIndex((l) => l.startsWith("Wrote"))))).toBe(
      KeyPair.fromString((envFileValue(second, "AGENT_PRIVATE_KEY") ?? "") as `ed25519:${string}`).getPublicKey().toString(),
    );
  });

  it("refuses a missing or unknown role and writes nothing", async () => {
    const out = captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    await expect(main([], envPath)).resolves.toBe(2);
    await expect(main(["--role", "Owner"], envPath)).resolves.toBe(2);
    await expect(main(["--role", "Agent"], envPath)).resolves.toBe(2);
    await expect(main(["--role"], envPath)).rejects.toThrow(/argument missing/);
    await expect(main(["--role", "agent", "--network", "testnet"], envPath)).rejects.toThrow(/Unknown option/);
    expect(out.join("\n")).toContain("--role must be agent, guardian or owner");
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(envPath)).toBe(false);
  });

  it("refuses NEAR_NETWORK=mainnet (ERR_MAINNET_REFUSED) before generating or writing anything", async () => {
    const out = captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    vi.stubEnv("NEAR_NETWORK", "mainnet");
    await expect(main(["--role", "agent"], envPath)).rejects.toThrow(/^ERR_MAINNET_REFUSED/);
    expect(existsSync(envPath)).toBe(false);
    expect(out.join("\n")).toContain("needs NEAR_NETWORK=testnet"); // D-16 hint, besides the refusal

    // From the env file too, and a mainnet URL anywhere: the file is left exactly as it was.
    vi.stubEnv("NEAR_NETWORK", undefined);
    for (const content of ["NEAR_NETWORK=mainnet\n", "NEAR_NETWORK=testnet\nEXTRA_RPC_URL=https://rpc.mainnet.near.org\n"]) {
      writeFileSync(envPath, content);
      await expect(main(["--role", "guardian", "--force"], envPath)).rejects.toThrow(/^ERR_MAINNET_REFUSED/);
      expect(readFileSync(envPath, "utf8")).toBe(content);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses when the variable is set in the shell (it would win over the file) and does not echo it", async () => {
    const out = captureConsole();
    const shellValue = "shell-value-for-this-test-only";
    vi.stubEnv("GUARDIAN_PRIVATE_KEY", shellValue);
    await expect(main(["--role", "guardian", "--force"], envPath)).resolves.toBe(1);
    expect(existsSync(envPath)).toBe(false);
    const text = out.join("\n");
    expect(text).toContain("GUARDIAN_PRIVATE_KEY is set in this shell's environment");
    expect(text).not.toContain(shellValue);
  });

  it.each(["", "   "])("refuses an empty or blank shell value %j too (it still hides the file's key from setup)", async (shellValue) => {
    const out = captureConsole();
    vi.stubEnv("AGENT_PRIVATE_KEY", shellValue);
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(1);
    expect(existsSync(envPath)).toBe(false);
    expect(out.join("\n")).toContain("AGENT_PRIVATE_KEY is set in this shell's environment");
  });

  it("never replaces an existing key without --force when a later empty line hides it (fails closed, file unchanged)", async () => {
    captureConsole();
    const existing = KeyPair.fromRandom("ed25519").toString(); // made at run time, never committed
    const content = `NEAR_NETWORK=testnet\nAGENT_PRIVATE_KEY=${existing}\nAGENT_PRIVATE_KEY=\n`;
    writeFileSync(envPath, content, { mode: 0o600 });
    const spy = vi.spyOn(KeyPair, "fromRandom");
    const err = await main(["--role", "agent"], envPath).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("AGENT_PRIVATE_KEY would not read back");
    expect(readFileSync(envPath, "utf8")).toBe(content);
    const made = (spy.mock.results[0]?.value as KeyPair).toString();
    expectNoSecret(errorText(err), made);
    expectNoSecret(errorText(err), existing);
  });

  it("never puts the secret into a thrown error (write fails after the key was made)", async () => {
    const out = captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    const missingDir = join(dir, "no-such-dir", ".env");
    const err = await main(["--role", "agent"], missingDir).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(spy).toHaveBeenCalledTimes(1);
    const made = spy.mock.results[0]?.value as KeyPair;
    const key = made.toString();
    const error = err as Error;
    for (const text of [error.message, String(error.stack), inspect(error), JSON.stringify(error), errorText(error), out.join("\n")]) {
      expectNoSecret(text, key);
    }
    expect(existsSync(missingDir)).toBe(false);
  });

  const inGitCheckout = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO_ROOT, encoding: "utf8" }).status === 0;
  it.skipIf(!inGitCheckout)("the default target offchain/.env and its temp files are git-ignored (.env.example is not)", () => {
    const rel = relative(REPO_ROOT, DEFAULT_ENV_FILE);
    expect(rel).toBe(join("offchain", ".env"));
    expect(spawnSync("git", ["check-ignore", "-q", rel], { cwd: REPO_ROOT }).status).toBe(0);
    // D-15: a temp file a crash might leave behind (`.env.tmp-<random>`, next to the target)
    const temp = join("offchain", ".env.tmp-0123456789abcdef01234567");
    expect(spawnSync("git", ["check-ignore", "-q", temp], { cwd: REPO_ROOT }).status).toBe(0);
    expect(spawnSync("git", ["check-ignore", "-q", join("offchain", ".env.example")], { cwd: REPO_ROOT }).status).toBe(1);
  });
});

describe("gen-testnet-near-key: only with NEAR_NETWORK=testnet set explicitly (D-16), one --role", () => {
  /** Run main, expect it to refuse with `code` before any key is made, and the file as it was. */
  async function expectRefused(argv: string[], code: number, fileBefore: string | undefined): Promise<string> {
    const out = captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    await expect(main(argv, envPath)).resolves.toBe(code);
    expect(spy).not.toHaveBeenCalled();
    if (fileBefore === undefined) {
      expect(readdirSync(dir)).toEqual([]);
    } else {
      expect(readFileSync(envPath, "utf8")).toBe(fileBefore);
      expect(readdirSync(dir)).toEqual([".env"]);
    }
    return out.join("\n");
  }

  it("NEAR_NETWORK not set anywhere (the config default, sandbox): refused, exit 1, nothing made or written", async () => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    const text = await expectRefused(["--role", "agent"], 1, undefined);
    expect(text).toContain(`NEAR_NETWORK is not set in this shell or in ${envPath}, so it reads as sandbox (the default).`);
    expect(text).toContain("gen-testnet-near-key makes NEAR testnet keys only and needs NEAR_NETWORK=testnet, set explicitly.");
    expect(text).toContain(`Set NEAR_NETWORK=testnet in ${envPath} (or export it in this shell), then run it again.`);
    expect(text).toContain("Nothing was generated or written.");
  });

  it("NEAR_NETWORK missing from an existing .env (and the shell): refused, the file is left as it was", async () => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    const content = "# mine\nOWNER_ACCOUNT_ID=owner.testnet\nNEAR_NETWORK=\n";
    writeFileSync(envPath, content, { mode: 0o600 });
    const text = await expectRefused(["--role", "guardian"], 1, content);
    expect(text).toContain(`NEAR_NETWORK is not set in this shell or in ${envPath}`);
  });

  const SANDBOX_CASES: ReadonlyArray<{ name: string; shell: string | undefined; file: string | undefined; says: (p: string) => string; fix: string }> = [
    {
      name: "sandbox in the shell",
      shell: "sandbox",
      file: undefined,
      says: (p) => `NEAR_NETWORK is "sandbox" in this shell's environment, which wins over ${p}.`,
      fix: "Run `export NEAR_NETWORK=testnet`",
    },
    {
      name: "sandbox in .env",
      shell: undefined,
      file: "# mine\nNEAR_NETWORK=sandbox\n",
      says: (p) => `NEAR_NETWORK is "sandbox" in ${p}.`,
      fix: "Set NEAR_NETWORK=testnet in",
    },
    {
      name: "sandbox in the shell over testnet in .env (the shell wins)",
      shell: "sandbox",
      file: "NEAR_NETWORK=testnet\n",
      says: (p) => `NEAR_NETWORK is "sandbox" in this shell's environment, which wins over ${p}.`,
      fix: "`unset NEAR_NETWORK` and put NEAR_NETWORK=testnet in",
    },
    {
      name: "an empty shell value over testnet in .env",
      shell: "",
      file: "NEAR_NETWORK=testnet\n",
      says: (p) => `NEAR_NETWORK is set but empty in this shell's environment, which wins over ${p}, so it reads as sandbox (the default).`,
      fix: "Run `export NEAR_NETWORK=testnet`",
    },
    {
      name: "a blank (spaces only) shell value over testnet in .env",
      shell: "   ",
      file: "NEAR_NETWORK=testnet\n",
      says: (p) => `NEAR_NETWORK is set but empty in this shell's environment, which wins over ${p}, so it reads as sandbox (the default).`,
      fix: "Run `export NEAR_NETWORK=testnet`",
    },
    {
      name: "a blank quoted value in .env",
      shell: undefined,
      file: 'NEAR_NETWORK="  "\n',
      says: (p) => `NEAR_NETWORK is not set in this shell or in ${p}, so it reads as sandbox (the default).`,
      fix: "Set NEAR_NETWORK=testnet in",
    },
  ];
  it.each(SANDBOX_CASES)("$name: refused, exit 1, nothing made or written", async ({ shell, file, says, fix }) => {
    vi.stubEnv("NEAR_NETWORK", shell);
    if (file !== undefined) writeFileSync(envPath, file, { mode: 0o600 });
    const text = await expectRefused(["--role", "agent"], 1, file);
    expect(text).toContain(says(envPath));
    expect(text).toContain(fix);
    expect(text).toContain("needs NEAR_NETWORK=testnet, set explicitly");
  });

  it.each(["mainnet", "devnet", "Testnet", "TESTNET", "test net"])(
    "NEAR_NETWORK=%s (shell or .env) stays ERR_MAINNET_REFUSED, with the testnet hint; nothing made or written",
    async (value) => {
      const out = captureConsole();
      const spy = vi.spyOn(KeyPair, "fromRandom");
      vi.stubEnv("NEAR_NETWORK", value);
      await expect(main(["--role", "agent"], envPath)).rejects.toThrow(/^ERR_MAINNET_REFUSED: NEAR_NETWORK must be/);
      expect(readdirSync(dir)).toEqual([]);
      expect(out.join("\n")).toContain(`NEAR_NETWORK is "${value}" in this shell's environment`);

      vi.stubEnv("NEAR_NETWORK", undefined);
      const content = `NEAR_NETWORK=${value}\n`;
      writeFileSync(envPath, content, { mode: 0o600 });
      out.length = 0;
      await expect(main(["--role", "agent"], envPath)).rejects.toThrow(/^ERR_MAINNET_REFUSED/);
      expect(readFileSync(envPath, "utf8")).toBe(content);
      expect(out.join("\n")).toContain(`NEAR_NETWORK is "${value}" in ${envPath}. gen-testnet-near-key makes NEAR testnet keys only`);
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("NEAR_NETWORK=testnet from .env (shell unset): runs, and the file keeps its own NEAR_NETWORK line", async () => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    writeFileSync(envPath, "NEAR_NETWORK=testnet   # mine\n", { mode: 0o600 });
    const out = captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    expect(written.split("\n")[0]).toBe("NEAR_NETWORK=testnet   # mine");
    expect(envFileValue(written, "AGENT_PRIVATE_KEY")).toMatch(/^ed25519:/);
    expect(out.join("\n")).not.toContain("Note: NEAR_NETWORK");
  });

  it("NEAR_NETWORK=testnet from the shell and no .env: creates .env with NEAR_NETWORK=testnet, so later runs read testnet from it", async () => {
    const out = captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    expect(envFileValue(written, "NEAR_NETWORK")).toBe("testnet");
    expect(out.join("\n")).toContain(
      `Created ${envPath} from .env.example and set NEAR_NETWORK=testnet in it (it came from this shell), so setup:testnet reads the same network.`,
    );
    // Without the shell value, the file alone now says testnet (what setup:testnet reads)...
    vi.stubEnv("NEAR_NETWORK", undefined);
    expect(loadConfig({ envFile: envPath, env: {} }).nearNetwork).toBe("testnet");
    // ...and the next key can be made from it.
    await expect(main(["--role", "guardian"], envPath)).resolves.toBe(0);
    expect(envFileValue(readFileSync(envPath, "utf8"), "GUARDIAN_PRIVATE_KEY")).toMatch(/^ed25519:/);
  });

  it("a padded shell value ' testnet ' reads as testnet (as loadConfig and setup:testnet read it): the new .env says exactly NEAR_NETWORK=testnet", async () => {
    vi.stubEnv("NEAR_NETWORK", " testnet ");
    captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    expect(written.split("\n").filter((l) => /^\s*NEAR_NETWORK\s*=/.test(l))).toHaveLength(1);
    expect(written).toMatch(/^NEAR_NETWORK=testnet\s+#/m);
    expect(loadConfig({ envFile: envPath, env: {} }).nearNetwork).toBe("testnet"); // the file alone, no shell
  });

  it("NEAR_NETWORK=testnet from the shell over sandbox in an existing .env: runs, leaves the file's line, and says so", async () => {
    writeFileSync(envPath, "NEAR_NETWORK=sandbox\n", { mode: 0o600 });
    const out = captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    expect(written.split("\n")[0]).toBe("NEAR_NETWORK=sandbox"); // an existing value is the owner's: not changed
    expect(out.join("\n")).toContain(`Note: NEAR_NETWORK=testnet comes from this shell; ${envPath} does not say testnet.`);
  });

  it.each([
    [["--role", "agent", "--role", "guardian"]],
    [["--role", "agent", "--role", "agent"]],
    [["--role=guardian", "--role", "agent"]],
    [["--role", "agent", "--force", "--role", "agent"]],
    [["--role", "agent", "--role="]],
    [["--role=agent", "--role=guardian"]],
  ])("a repeated --role is refused (exit 2, usage line), not the last one taken: %j", async (argv) => {
    const text = await expectRefused(argv, 2, undefined);
    expect(text).toContain(USAGE);
    expect(text).toContain("--role was given 2 times; pass it exactly once.");
  });

  it.each([[["-r", "agent"]], [["--role", "agent", "-r", "guardian"]], [["--role", "agent", "guardian"]]])(
    "no short form or extra value sneaks a role in: %j is refused before any key is made",
    async (argv) => {
      captureConsole();
      const spy = vi.spyOn(KeyPair, "fromRandom");
      await expect(main(argv, envPath)).rejects.toThrow(/Unknown option|Unexpected argument/);
      expect(spy).not.toHaveBeenCalled();
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it("a repeated --role is refused before the network check (exit 2 even with NEAR_NETWORK unset)", async () => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    const text = await expectRefused(["--role", "agent", "--role", "guardian"], 2, undefined);
    expect(text).toContain(USAGE);
  });

  it.each([true, false])("a symlinked .env (target exists: %s) is refused before a key is made (D-15: never followed)", async (targetExists) => {
    const real = join(dir, "real.env");
    if (targetExists) writeFileSync(real, "NEAR_NETWORK=testnet\n", { mode: 0o600 });
    symlinkSync("real.env", envPath);
    captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    await expect(main(["--role", "agent"], envPath)).rejects.toThrow(/is a symbolic link; the key commands never write through a link/);
    expect(spy).not.toHaveBeenCalled();
    expect(readdirSync(dir).sort()).toEqual(targetExists ? [".env", "real.env"] : [".env"]);
    if (targetExists) expect(readFileSync(real, "utf8")).toBe("NEAR_NETWORK=testnet\n");
  });
});

describe("gen-testnet-near-key --role owner (owner approval, 31 Oct 2026): testnet full-access key, same guards", () => {
  it("writes only OWNER_PRIVATE_KEY (mode 600), prints only the public key, sends nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = captureConsole();
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const written = readFileSync(envPath, "utf8");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(envFileValue(written, "NEAR_NETWORK")).toBe("testnet");
    expect(envFileValue(written, "AGENT_PRIVATE_KEY")).toBeUndefined();
    expect(envFileValue(written, "GUARDIAN_PRIVATE_KEY")).toBeUndefined();
    const key = envFileValue(written, "OWNER_PRIVATE_KEY") ?? "";
    const pair = KeyPair.fromString(key as `ed25519:${string}`);
    expect(pair).toBeInstanceOf(KeyPairEd25519);
    const printed = printedPublicKey(out);
    expect(pair.getPublicKey().toString()).toBe(printed);
    expect((await signerFromKey(key).getPublicKey()).toString()).toBe(printed);
    // loadConfig (what setup:testnet uses) reads the same owner key back.
    expect(loadConfig({ envFile: envPath }).ownerPrivateKey).toBeDefined();
    const text = out.join("\n");
    expectNoSecret(text, key);
    expect(text).toContain("(OWNER_PRIVATE_KEY, file mode 600)");
    expect(text).toContain("OWNER_ACCOUNT_ID (e.g. <name>.testnet) on NEAR testnet with this public key as its full-access key");
    expect(text).toContain("Testnet only: never reuse this key on mainnet.");
    expect(text).not.toContain("function-call key limited to");
    expect(out).toContain(KEY_LINE);
  });

  it("refuses NEAR_NETWORK=mainnet (ERR_MAINNET_REFUSED) and sandbox/unset before a key is made", async () => {
    captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    vi.stubEnv("NEAR_NETWORK", "mainnet");
    await expect(main(["--role", "owner"], envPath)).rejects.toThrow(/^ERR_MAINNET_REFUSED/);
    vi.stubEnv("NEAR_NETWORK", "sandbox");
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(1);
    vi.stubEnv("NEAR_NETWORK", undefined);
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(envPath)).toBe(false);
  });

  it("refuses a symlinked .env before a key is made and never writes through it", async () => {
    captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    const target = join(dir, "real.env");
    writeFileSync(target, "NEAR_NETWORK=testnet\n");
    symlinkSync(target, envPath);
    await expect(main(["--role", "owner"], envPath)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(readFileSync(target, "utf8")).toBe("NEAR_NETWORK=testnet\n");
  });

  it("refuses to replace an existing OWNER_PRIVATE_KEY without --force, and when it is set in the shell", async () => {
    captureConsole();
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(0);
    const first = readFileSync(envPath, "utf8");
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe(first);
    vi.stubEnv("OWNER_PRIVATE_KEY", "");
    // Even with both explicit flags, a key set in the shell (it wins over the file) is refused.
    await expect(main(["--role", "owner", "--force", "--replace-owner-key"], envPath)).resolves.toBe(1);
    expect(readFileSync(envPath, "utf8")).toBe(first);
  });

  it("names --force --replace-owner-key (not --force alone) when OWNER_PRIVATE_KEY is already set", async () => {
    const out = captureConsole();
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(0);
    out.length = 0;
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(1);
    expect(out.join("\n")).toContain("Pass --force --replace-owner-key to replace it.");
  });
});

describe("gen-testnet-near-key --role owner --force: refused without --replace-owner-key (ERR_OWNER_FORCE_REFUSED)", () => {
  it("--force alone is refused before any key is made, with or without an existing owner key", async () => {
    const out = captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    // No env file yet: still refused, nothing created.
    await expect(main(["--role", "owner", "--force"], envPath)).resolves.toBe(1);
    expect(existsSync(envPath)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    // An existing owner key stays exactly as it was.
    spy.mockRestore();
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(0);
    const first = readFileSync(envPath, "utf8");
    const firstKey = envFileValue(first, "OWNER_PRIVATE_KEY") ?? "";
    const spy2 = vi.spyOn(KeyPair, "fromRandom");
    out.length = 0;
    await expect(main(["--role", "owner", "--force"], envPath)).resolves.toBe(1);
    expect(spy2).not.toHaveBeenCalled();
    expect(readFileSync(envPath, "utf8")).toBe(first);
    expect(readdirSync(dir).sort()).toEqual([".env"]);
    const text = out.join("\n");
    expect(text).toMatch(/^ERR_OWNER_FORCE_REFUSED: /m);
    expect(text).toContain("--force --replace-owner-key");
    expectNoSecret(text, firstKey);
  });

  it("--force --replace-owner-key replaces the owner key atomically (mode 600, other values kept, secrets not printed)", async () => {
    const out = captureConsole();
    await expect(main(["--role", "owner"], envPath)).resolves.toBe(0);
    const before = readFileSync(envPath, "utf8");
    const oldKey = envFileValue(before, "OWNER_PRIVATE_KEY") ?? "";
    out.length = 0;
    await expect(main(["--role", "owner", "--force", "--replace-owner-key"], envPath)).resolves.toBe(0);
    const after = readFileSync(envPath, "utf8");
    const newKey = envFileValue(after, "OWNER_PRIVATE_KEY") ?? "";
    expect(newKey).not.toBe(oldKey);
    expect(KeyPair.fromString(newKey as `ed25519:${string}`)).toBeInstanceOf(KeyPairEd25519);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual([".env"]);
    expect(envFileValue(after, "NEAR_NETWORK")).toBe("testnet");
    expect(after.replace(newKey, "<key>")).toBe(before.replace(oldKey, "<key>"));
    expect(KeyPair.fromString(newKey as `ed25519:${string}`).getPublicKey().toString()).toBe(printedPublicKey(out));
    const text = out.join("\n");
    expectNoSecret(text, oldKey);
    expectNoSecret(text, newKey);
  });

  it("--replace-owner-key needs --force and applies to --role owner only (exit 2, nothing written)", async () => {
    const out = captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    await expect(main(["--role", "owner", "--replace-owner-key"], envPath)).resolves.toBe(2);
    for (const roleName of ROLES) {
      await expect(main(["--role", roleName, "--force", "--replace-owner-key"], envPath)).resolves.toBe(2);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(envPath)).toBe(false);
    const text = out.join("\n");
    expect(text).toContain("--replace-owner-key works only together with --force.");
    expect(text).toContain("--replace-owner-key applies to --role owner only.");
  });
});

describe("gen-testnet-near-key: NEAR_RPC_URL default (owner request after the 31 Oct 2026 rerun)", () => {
  it("the default is a testnet URL that passes every mainnet URL guard", () => {
    expect(DEFAULT_TESTNET_RPC_URL).toBe("https://rpc.testnet.near.org");
    expect(assertNoMainnetUrl(DEFAULT_TESTNET_RPC_URL, "NEAR_RPC_URL")).toBe(DEFAULT_TESTNET_RPC_URL);
    expect(loadConfig({ envFile: false, env: { NEAR_NETWORK: "testnet", NEAR_RPC_URL: DEFAULT_TESTNET_RPC_URL } }).nearRpcUrl).toBe(
      DEFAULT_TESTNET_RPC_URL,
    );
  });

  it.each(ALL_ROLES)("--role %s, no .env yet: the new file has NEAR_NETWORK=testnet and the default RPC; loadConfig reads both", async (roleName) => {
    const out = captureConsole();
    await expect(main(["--role", roleName], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    expect(envFileValue(written, "NEAR_NETWORK")).toBe("testnet");
    expect(envFileValue(written, "NEAR_RPC_URL")).toBe(DEFAULT_TESTNET_RPC_URL);
    expect(written.split("\n").filter((l) => /^\s*NEAR_RPC_URL\s*=/.test(l))).toHaveLength(1);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(out.filter((l) => l.includes("NEAR_RPC_URL"))).toEqual([RPC_SET_LINE(envPath)]); // exactly one line about it
    vi.stubEnv("NEAR_NETWORK", undefined);
    const config = loadConfig({ envFile: envPath, env: {} }); // the file alone, as setup:testnet reads it
    expect(config.nearNetwork).toBe("testnet");
    expect(config.nearRpcUrl).toBe(DEFAULT_TESTNET_RPC_URL);
  });

  it.each(ALL_ROLES)("--role %s, existing .env with an empty NEAR_RPC_URL (comment kept): it gets the default", async (roleName) => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    const content = "# mine\nNEAR_NETWORK=testnet\nNEAR_RPC_URL=     # my comment\nOWNER_ACCOUNT_ID=me.testnet\n";
    writeFileSync(envPath, content, { mode: 0o600 });
    const out = captureConsole();
    await expect(main(["--role", roleName], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    const lines = written.split("\n");
    expect(lines.slice(0, 4)).toEqual(["# mine", "NEAR_NETWORK=testnet", "NEAR_RPC_URL=https://rpc.testnet.near.org     # my comment", "OWNER_ACCOUNT_ID=me.testnet"]);
    expect(lines.slice(4, 5)).toEqual([`${NEAR_KEY_ROLES[roleName].keyName}=${envFileValue(written, NEAR_KEY_ROLES[roleName].keyName) ?? "missing"}`]);
    expect(out).toContain(RPC_SET_LINE(envPath));
  });

  it.each([
    ['NEAR_RPC_URL=""', "NEAR_RPC_URL=https://rpc.testnet.near.org"],
    ["NEAR_RPC_URL=", "NEAR_RPC_URL=https://rpc.testnet.near.org"],
    ["NEAR_RPC_URL=   # later", "NEAR_RPC_URL=https://rpc.testnet.near.org   # later"],
  ])("an empty value written as %j counts as unset", async (line, expected) => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    writeFileSync(envPath, `NEAR_NETWORK=testnet\n${line}\n`, { mode: 0o600 });
    captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    expect(written.split("\n")[1]).toBe(expected);
    expect(envFileValue(written, "NEAR_RPC_URL")).toBe(DEFAULT_TESTNET_RPC_URL);
  });

  it("a spaces-only NEAR_RPC_URL (Node's parseEnv then reads the next line as its value) fails closed: nothing written", async () => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    const content = "NEAR_NETWORK=testnet\nNEAR_RPC_URL=   \n";
    writeFileSync(envPath, content, { mode: 0o600 });
    captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    const err = await main(["--role", "agent"], envPath).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain("AGENT_PRIVATE_KEY would not read back");
    expect(readFileSync(envPath, "utf8")).toBe(content);
    expect(readdirSync(dir)).toEqual([".env"]);
    expectNoSecret(errorText(err), (spy.mock.results[0]?.value as KeyPair).toString());
  });

  it.each(ALL_ROLES)("--role %s, existing non-empty NEAR_RPC_URL: kept byte for byte, nothing said about it", async (roleName) => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    const rpcLine = "  NEAR_RPC_URL = https://near-testnet.drpc.org   # the owner's choice";
    const content = `NEAR_NETWORK=testnet\n${rpcLine}\n`;
    writeFileSync(envPath, content, { mode: 0o600 });
    const out = captureConsole();
    await expect(main(["--role", roleName], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    expect(written.startsWith(content)).toBe(true); // every byte of the old file is still there, in place
    expect(written.split("\n")[1]).toBe(rpcLine);
    expect(envFileValue(written, "NEAR_RPC_URL")).toBe("https://near-testnet.drpc.org");
    expect(written).not.toContain("rpc.testnet.near.org");
    expect(out.join("\n")).not.toContain("NEAR_RPC_URL");
  });

  it.each(ALL_ROLES)("--role %s, NEAR_RPC_URL set in the shell: the file's NEAR_RPC_URL is left alone and the shell value is used", async (roleName) => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    vi.stubEnv("NEAR_RPC_URL", "https://testnet-rpc.example.test/near");
    for (const fileRpc of ["", "https://near-testnet.drpc.org"]) {
      const content = `NEAR_NETWORK=testnet\nNEAR_RPC_URL=${fileRpc}\n`;
      writeFileSync(envPath, content, { mode: 0o600 });
      const out = captureConsole();
      await expect(main(["--role", roleName], envPath)).resolves.toBe(0);
      const written = readFileSync(envPath, "utf8");
      expect(written.startsWith(content)).toBe(true);
      expect(written.split("\n")[1]).toBe(`NEAR_RPC_URL=${fileRpc}`);
      const text = out.join("\n");
      expect(text).toContain(
        `NEAR_RPC_URL is set in this shell's environment; that value is used (it wins over ${envPath}), and the file's NEAR_RPC_URL was left as it is.`,
      );
      expect(text).not.toContain("testnet-rpc.example.test"); // the shell value is not echoed
      vi.restoreAllMocks();
      rmSync(envPath);
    }
  });

  it("no .env yet and NEAR_RPC_URL set in the shell: the new file keeps the template's empty NEAR_RPC_URL", async () => {
    vi.stubEnv("NEAR_RPC_URL", "https://testnet-rpc.example.test");
    captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    const template = readFileSync(ENV_EXAMPLE_FILE, "utf8");
    const rpc = (text: string): string | undefined => text.split("\n").find((l) => l.startsWith("NEAR_RPC_URL="));
    expect(rpc(written)).toBe(rpc(template));
    expect(envFileValue(written, "NEAR_RPC_URL")).toBeUndefined();
  });

  it.each(["", "   "])("an empty shell NEAR_RPC_URL %j still wins over the file: the file is left alone, with a warning", async (shellValue) => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    vi.stubEnv("NEAR_RPC_URL", shellValue);
    const content = "NEAR_NETWORK=testnet\nNEAR_RPC_URL=\n";
    writeFileSync(envPath, content, { mode: 0o600 });
    const out = captureConsole();
    await expect(main(["--role", "guardian"], envPath)).resolves.toBe(0);
    expect(readFileSync(envPath, "utf8").startsWith(content)).toBe(true);
    expect(out.join("\n")).toContain(
      `NEAR_RPC_URL is set but empty in this shell's environment, which wins over ${envPath}, so setup:testnet would find no RPC URL; the file's NEAR_RPC_URL was left as it is.`,
    );
  });

  it("the file does not say NEAR_NETWORK=testnet (testnet only from the shell): no testnet RPC is written into it", async () => {
    for (const content of ["NEAR_NETWORK=sandbox\nNEAR_RPC_URL=\n", "OWNER_ACCOUNT_ID=me.testnet\n"]) {
      writeFileSync(envPath, content, { mode: 0o600 });
      const out = captureConsole();
      await expect(main(["--role", "agent", "--force"], envPath)).resolves.toBe(0);
      const written = readFileSync(envPath, "utf8");
      expect(written.startsWith(content)).toBe(true);
      expect(envFileValue(written, "NEAR_RPC_URL")).toBeUndefined();
      const text = out.join("\n");
      expect(text).toContain(`NEAR_RPC_URL was not written: ${envPath} does not say NEAR_NETWORK=testnet.`);
      expect(text).toContain("Note: NEAR_NETWORK=testnet comes from this shell");
      vi.restoreAllMocks();
    }
  });

  it("NEAR_RPC_URL listed twice (the last one empty): a non-empty line is never overwritten; nothing written for it", async () => {
    vi.stubEnv("NEAR_NETWORK", undefined);
    const content = "NEAR_NETWORK=testnet\nNEAR_RPC_URL=https://near-testnet.drpc.org\nNEAR_RPC_URL=\n";
    writeFileSync(envPath, content, { mode: 0o600 });
    const out = captureConsole();
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(0);
    const written = readFileSync(envPath, "utf8");
    expect(written.startsWith(content)).toBe(true);
    expect(envFileValue(written, "AGENT_PRIVATE_KEY")).toMatch(/^ed25519:/);
    expect(out.join("\n")).toContain(`NEAR_RPC_URL was not written: in ${envPath} it would not read back (is NEAR_RPC_URL listed more than once?).`);
  });

  it("every refusal still comes first: nothing is written for NEAR_RPC_URL when the command refuses", async () => {
    captureConsole();
    const spy = vi.spyOn(KeyPair, "fromRandom");
    // ERR_OWNER_FORCE_REFUSED, D-16 (sandbox), a key set in the shell, a symlinked .env.
    await expect(main(["--role", "owner", "--force"], envPath)).resolves.toBe(1);
    vi.stubEnv("NEAR_NETWORK", "sandbox");
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(1);
    vi.stubEnv("NEAR_NETWORK", "testnet");
    vi.stubEnv("AGENT_PRIVATE_KEY", "");
    await expect(main(["--role", "agent"], envPath)).resolves.toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    vi.stubEnv("AGENT_PRIVATE_KEY", undefined);
    writeFileSync(join(dir, "real.env"), "NEAR_NETWORK=testnet\n");
    symlinkSync("real.env", envPath);
    await expect(main(["--role", "agent"], envPath)).rejects.toThrow(/is a symbolic link/);
    expect(readFileSync(join(dir, "real.env"), "utf8")).toBe("NEAR_NETWORK=testnet\n");
    expect(spy).not.toHaveBeenCalled();
  });

  it("planNearRpcUrl: the five outcomes (pure)", () => {
    expect(planNearRpcUrl("NEAR_NETWORK=testnet\n", "https://x.example.test")).toEqual({ action: "shell", empty: false });
    expect(planNearRpcUrl("NEAR_NETWORK=testnet\n", " ")).toEqual({ action: "shell", empty: true });
    expect(planNearRpcUrl("NEAR_NETWORK=testnet\nNEAR_RPC_URL=https://a.example.test\n", undefined)).toEqual({ action: "keep" });
    expect(planNearRpcUrl("NEAR_NETWORK=sandbox\n", undefined)).toEqual({ action: "not-testnet" });
    expect(planNearRpcUrl("NEAR_RPC_URL=\n", undefined)).toEqual({ action: "not-testnet" });
    expect(planNearRpcUrl("NEAR_NETWORK=testnet\nNEAR_RPC_URL=https://a.example.test\nNEAR_RPC_URL=\n", undefined)).toEqual({ action: "unclear" });
    expect(planNearRpcUrl("NEAR_NETWORK=testnet\n", undefined)).toEqual({
      action: "set",
      content: "NEAR_NETWORK=testnet\nNEAR_RPC_URL=https://rpc.testnet.near.org\n",
    });
  });
});
