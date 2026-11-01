// Atomic .env writes (owner decision D-15) for gen-testnet-near-key and
// gen-testnet-evm-key: a temp file `.env.tmp-<random>` made exclusively at mode 0600 next to the
// target, fsynced, read back and renamed over it. On any error the old file stays byte for byte,
// no temp file is left and no secret reaches the output or the error. A symlinked .env is refused
// and never followed (D-15): nothing is written through it, the link and its target stay as they were.
// Everything runs in a temp dir, no network. No key-shaped value is committed: keys are made at run time.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { KeyPair } from "near-api-js";
import type * as ViemAccounts from "viem/accounts";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorText } from "../src/cli/common.js";
import { main as evmMain } from "../src/cli/gen_testnet_evm_key.js";
import { main as nearMain } from "../src/cli/gen_testnet_near_key.js";
import { ConfigError } from "../src/config.js";
import { ENV_TEMP_PREFIX, type EnvFileIo, envFileIo, envFileValue, writeEnvFileAtomic } from "../src/envfile.js";

// gen-testnet-evm-key's key generator, wrapped (same behaviour) so a test can see whether a key
// was made at all. vi.restoreAllMocks does not undo a vi.fn made here; counts are taken as deltas.
vi.mock("viem/accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof ViemAccounts>();
  return { ...actual, generatePrivateKey: vi.fn(actual.generatePrivateKey) };
});

const TEMP_NAME = /^\.env\.tmp-[0-9a-f]{24}$/;
const ENVFILE_MODULE = fileURLToPath(new URL("../src/envfile.ts", import.meta.url));
/** tsx's loader, by absolute URL, so a child `node --import <it>` runs a .ts file directly (no wrapper process). */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

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

/** Run `fn` with the process umask set to `mask` (vitest runs each file in a forked process). */
async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  const old = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(old);
  }
}

/** A umask test case, labelled in octal (vitest's %o would print it in decimal). */
function umaskCase(mask: number): { mask: number; label: string } {
  return { mask, label: mask.toString(8).padStart(3, "0") };
}

/** A Node-style fs error with a code, as the injected failure. */
function fsError(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected failure, ${syscall}`), { code, syscall });
}

/** Run `fn` and return what it threw (or undefined). */
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => undefined,
    (e: unknown) => e,
  );
}

/** Every text an error can turn into when printed or logged. */
function errorTexts(err: unknown): string[] {
  const e = err as Error;
  return [e.message, String(e.stack), inspect(e), JSON.stringify(e), errorText(e)];
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clawguard-atomic-"));
  // Isolate from any developer shell: the real environment wins over the env file.
  vi.stubEnv("NEAR_NETWORK", "testnet");
  for (const name of [
    "NEAR_RPC_URL",
    "CLAWGUARD_CONTRACT_ID",
    "OWNER_ACCOUNT_ID",
    "AGENT_ACCOUNT_ID",
    "AGENT_PRIVATE_KEY",
    "GUARDIAN_ACCOUNT_ID",
    "GUARDIAN_PRIVATE_KEY",
    "HL_MASTER_ADDRESS",
    "HL_MASTER_TESTNET_PRIVATE_KEY",
  ]) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The helper itself
// ---------------------------------------------------------------------------

describe("writeEnvFileAtomic", () => {
  const CONTENT = "NEAR_NETWORK=testnet\nSOME_VALUE=abc   # a comment\n";

  it.each([0o000, 0o022, 0o277].map(umaskCase))("creates a missing file at mode 0600 with umask $label, and leaves only that file", async ({ mask }) => {
    const path = join(dir, ".env");
    await withUmask(mask, () => Promise.resolve(writeEnvFileAtomic(path, CONTENT)));
    expect(readFileSync(path, "utf8")).toBe(CONTENT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([".env"]);
  });

  it("replaces an existing file by rename (a new inode, mode 0600 from 0644), through an exclusive 0600 temp file", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "OLD=1\n", { mode: 0o644 });
    const before = statSync(path);
    expect(before.mode & 0o777).toBe(0o644);
    const open = vi.spyOn(envFileIo, "openSync");
    const rename = vi.spyOn(envFileIo, "renameSync");

    writeEnvFileAtomic(path, CONTENT);

    const after = statSync(path);
    expect(readFileSync(path, "utf8")).toBe(CONTENT);
    expect(after.mode & 0o777).toBe(0o600);
    expect(after.ino).not.toBe(before.ino); // replaced, not rewritten in place
    expect(readdirSync(dir)).toEqual([".env"]);
    // The temp file: same folder, `.env.tmp-<random>`, O_CREAT|O_EXCL ("wx"), mode 0600.
    const [tempPath, flags, mode] = open.mock.calls[0] ?? [];
    expect(dirname(tempPath ?? "")).toBe(dir);
    expect(basename(tempPath ?? "")).toMatch(TEMP_NAME);
    expect(basename(tempPath ?? "").startsWith(ENV_TEMP_PREFIX)).toBe(true);
    expect(flags).toBe("wx");
    expect(mode).toBe(0o600);
    expect(rename).toHaveBeenCalledWith(tempPath, path);
    // Then the folder is fsynced (opened read-only).
    expect(open.mock.calls[1]?.slice(0, 2)).toEqual([dir, "r"]);
  });

  it("uses a new random temp name each time", () => {
    const path = join(dir, ".env");
    const open = vi.spyOn(envFileIo, "openSync");
    writeEnvFileAtomic(path, "A=1\n");
    writeEnvFileAtomic(path, "A=2\n");
    const temps = open.mock.calls.map((c) => c[0]).filter((p) => TEMP_NAME.test(basename(p)));
    expect(temps).toHaveLength(2);
    expect(temps[0]).not.toBe(temps[1]);
  });

  const fail = (code: string, syscall: string) => (): never => {
    throw fsError(code, syscall);
  };
  const STEPS: ReadonlyArray<[string, (io: EnvFileIo) => void]> = [
    ["open (no space for the temp file)", (io) => vi.spyOn(io, "openSync").mockImplementationOnce(fail("ENOSPC", "open"))],
    ["fchmod", (io) => vi.spyOn(io, "fchmodSync").mockImplementation(fail("EPERM", "fchmod"))],
    [
      "write (disk full half way)",
      (io) =>
        vi.spyOn(io, "writeFileSync").mockImplementation((fd, data) => {
          writeSync(fd, data.slice(0, Math.floor(data.length / 2))); // a truncated temp file now exists
          throw fsError("ENOSPC", "write");
        }),
    ],
    ["fsync", (io) => vi.spyOn(io, "fsyncSync").mockImplementation(fail("EIO", "fsync"))],
    ["read-back mismatch", (io) => vi.spyOn(io, "readFileSync").mockReturnValue("SOMETHING=else\n")],
    ["rename", (io) => vi.spyOn(io, "renameSync").mockImplementation(fail("EXDEV", "rename"))],
  ];

  it.each(STEPS)("a failure at %s leaves the old file byte for byte and no temp file", (_step, inject) => {
    const path = join(dir, ".env");
    const original = "# keep me\nNEAR_NETWORK=testnet\nAGENT_PRIVATE_KEY=\n";
    writeFileSync(path, original, { mode: 0o600 });
    const secretMarker = randomBytes(16).toString("hex"); // made at run time, never committed
    inject(envFileIo);
    let err: unknown;
    try {
      writeEnvFileAtomic(path, `NEAR_NETWORK=testnet\nAGENT_PRIVATE_KEY=${secretMarker}\n`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(dir)).toEqual([".env"]);
    for (const text of errorTexts(err)) expect(text).not.toContain(secretMarker);
  });

  it("a failure when the file does not exist yet leaves nothing behind", () => {
    const path = join(dir, ".env");
    vi.spyOn(envFileIo, "renameSync").mockImplementation(() => {
      throw fsError("EIO", "rename");
    });
    expect(() => writeEnvFileAtomic(path, "A=1\n")).toThrow(/EIO/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("if the temp file cannot be removed, it is emptied through its open descriptor (no secret left)", () => {
    const path = join(dir, ".env");
    writeFileSync(path, "OLD=1\n");
    const open = vi.spyOn(envFileIo, "openSync");
    vi.spyOn(envFileIo, "renameSync").mockImplementation(() => {
      throw fsError("EIO", "rename");
    });
    vi.spyOn(envFileIo, "unlinkSync").mockImplementation(() => {
      throw fsError("EBUSY", "unlink");
    });
    expect(() => writeEnvFileAtomic(path, `MADE_AT_RUN_TIME=${randomBytes(16).toString("hex")}\n`)).toThrow(/EIO/); // the first error, not the cleanup one
    const temp = open.mock.calls[0]?.[0] ?? "";
    expect(existsSync(temp)).toBe(true);
    expect(readFileSync(temp, "utf8")).toBe("");
    expect(readFileSync(path, "utf8")).toBe("OLD=1\n");
  });

  it("a failing folder fsync after the rename is ignored (best effort): the new file is in place", () => {
    const path = join(dir, ".env");
    const real = envFileIo.fsyncSync;
    let calls = 0;
    vi.spyOn(envFileIo, "fsyncSync").mockImplementation((fd) => {
      calls += 1;
      if (calls === 2) throw fsError("EINVAL", "fsync"); // the folder
      real(fd);
    });
    writeEnvFileAtomic(path, "A=1\n");
    expect(calls).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("A=1\n");
    expect(readdirSync(dir)).toEqual([".env"]);
  });

  it.each([
    ["an existing file", true],
    ["a missing file (dangling link)", false],
  ])("refuses a symlinked path to %s (ConfigError, never followed): nothing is written anywhere", (_kind, targetExists) => {
    mkdirSync(join(dir, "app"));
    mkdirSync(join(dir, "secrets"));
    const real = join(dir, "secrets", "claw.env");
    if (targetExists) writeFileSync(real, "OLD=1\n", { mode: 0o644 });
    const link = join(dir, "app", ".env");
    symlinkSync("../secrets/claw.env", link);
    const open = vi.spyOn(envFileIo, "openSync");

    expect(() => writeEnvFileAtomic(link, CONTENT)).toThrow(ConfigError);
    expect(() => writeEnvFileAtomic(link, CONTENT)).toThrow(
      `${link} is a symbolic link; the key commands never write through a link. ` +
        "Replace the link with the file itself and run the command again. Nothing was written.",
    );

    expect(open).not.toHaveBeenCalled();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../secrets/claw.env");
    expect(readdirSync(join(dir, "app"))).toEqual([".env"]);
    if (targetExists) {
      expect(readFileSync(real, "utf8")).toBe("OLD=1\n");
      expect(statSync(real).mode & 0o777).toBe(0o644);
      expect(readdirSync(join(dir, "secrets"))).toEqual(["claw.env"]);
    } else {
      expect(readdirSync(join(dir, "secrets"))).toEqual([]);
    }
  });

  it("refuses a folder (ConfigError), creating nothing", () => {
    const folder = join(dir, "folder");
    mkdirSync(folder);
    const open = vi.spyOn(envFileIo, "openSync");
    expect(() => writeEnvFileAtomic(folder, "A=1\n")).toThrow(ConfigError);
    expect(() => writeEnvFileAtomic(folder, "A=1\n")).toThrow(/is not a regular file/);
    expect(open).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(["folder"]);
    expect(readdirSync(folder)).toEqual([]);
  });

  // Behavioural O_EXCL check (not just the "wx" flag string): something planted at the temp name
  // between choosing it and opening it is never opened, followed or written through.
  it.each([
    ["a link to another file", "link"],
    ["a dangling link", "dangling"],
    ["a regular file", "file"],
  ] as const)("a temp name already taken by %s is never opened: fails with EEXIST, nothing written anywhere", (_kind, planted) => {
    const path = join(dir, ".env");
    writeFileSync(path, "OLD=1\n", { mode: 0o600 });
    const victim = join(dir, "victim");
    if (planted === "link") writeFileSync(victim, "VICTIM=1\n", { mode: 0o644 });
    const realOpen = envFileIo.openSync;
    let temp = "";
    vi.spyOn(envFileIo, "openSync").mockImplementationOnce((p, flags, mode) => {
      temp = p;
      if (planted === "file") writeFileSync(p, "PLANTED=1\n", { mode: 0o644 });
      else symlinkSync(victim, p);
      return realOpen(p, flags, mode);
    });
    const secretMarker = randomBytes(16).toString("hex");

    expect(() => writeEnvFileAtomic(path, `KEY=${secretMarker}\n`)).toThrow(/EEXIST/);

    expect(readFileSync(path, "utf8")).toBe("OLD=1\n");
    if (planted === "link") {
      expect(readFileSync(victim, "utf8")).toBe("VICTIM=1\n");
      expect(statSync(victim).mode & 0o777).toBe(0o644);
    }
    if (planted === "dangling") expect(existsSync(victim)).toBe(false); // not created through the link
    if (planted === "file") expect(readFileSync(temp, "utf8")).toBe("PLANTED=1\n");
    // Not ours, so not removed either (no unlink through a name we did not create).
    expect(lstatSync(temp).isSymbolicLink()).toBe(planted !== "file");
  });

  it.each([0o000, 0o022].map(umaskCase))(
    "the temp file is mode 0600 or tighter from the moment it exists, before any content is written (umask $label)",
    async ({ mask }) => {
      const path = join(dir, ".env");
      const seen: Array<[string, number]> = [];
      const realFchmod = envFileIo.fchmodSync;
      const realWrite = envFileIo.writeFileSync;
      vi.spyOn(envFileIo, "fchmodSync").mockImplementation((fd, mode) => {
        seen.push(["right after open", fstatSync(fd).mode & 0o777]);
        realFchmod(fd, mode);
      });
      vi.spyOn(envFileIo, "writeFileSync").mockImplementation((fd, data) => {
        seen.push(["before the content goes in", fstatSync(fd).mode & 0o777]);
        realWrite(fd, data);
      });
      await withUmask(mask, () => Promise.resolve(writeEnvFileAtomic(path, CONTENT)));
      expect(seen.map(([when]) => when)).toEqual(["right after open", "before the content goes in"]);
      for (const [, mode] of seen) expect(mode & 0o077).toBe(0); // no group or other bit, ever
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("a process killed (SIGKILL) after the write, just before the rename: the old file is byte for byte as it was; the leftover temp file is 0600 and git-ignored by name", () => {
    const envDir = join(dir, "env");
    mkdirSync(envDir);
    const path = join(envDir, ".env");
    const original = "# keep me\nNEAR_NETWORK=testnet\n";
    writeFileSync(path, original, { mode: 0o644 });
    // A child process (the script lives in the temp dir, never in the repo) that dies at the rename.
    const script = join(dir, "kill_at_rename.ts");
    writeFileSync(
      script,
      [
        `import { envFileIo, writeEnvFileAtomic } from ${JSON.stringify(ENVFILE_MODULE)};`,
        `envFileIo.renameSync = () => { process.kill(process.pid, "SIGKILL"); };`,
        `writeEnvFileAtomic(process.argv[2], "NEW_VALUE=" + process.argv[3] + "\\n");`,
      ].join("\n"),
    );
    const marker = randomBytes(16).toString("hex");
    const res = spawnSync(process.execPath, ["--import", TSX_LOADER, script, path, marker], { encoding: "utf8", timeout: 60_000 });
    expect(res.signal).toBe("SIGKILL");

    expect(readFileSync(path, "utf8")).toBe(original); // never truncated or half-written
    expect(statSync(path).mode & 0o777).toBe(0o644); // the old file itself was not touched
    const left = readdirSync(envDir).filter((name) => name !== ".env");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(TEMP_NAME); // matched by `.env.tmp-*` in .gitignore
    const temp = join(envDir, left[0] ?? "");
    expect(statSync(temp).mode & 0o777).toBe(0o600);
    expect(readFileSync(temp, "utf8")).toBe(`NEW_VALUE=${marker}\n`); // complete (fsynced) but never in place
    expect(`${res.stdout}\n${res.stderr}`).not.toContain(marker);
  });

  it("a link in a PARENT folder is fine: temp file and rename stay in that one real folder", () => {
    mkdirSync(join(dir, "real"));
    symlinkSync("real", join(dir, "linked"));
    const path = join(dir, "linked", ".env");
    writeEnvFileAtomic(path, CONTENT);
    expect(lstatSync(join(dir, "real", ".env")).isFile()).toBe(true);
    expect(readFileSync(join(dir, "real", ".env"), "utf8")).toBe(CONTENT);
    expect(statSync(join(dir, "real", ".env")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "real"))).toEqual([".env"]);
  });
});

// ---------------------------------------------------------------------------
// Both key commands use it
// ---------------------------------------------------------------------------

interface KeyCommand {
  name: string;
  /** The secret's variable, and any other variable the command writes. */
  keyName: string;
  otherNames: readonly string[];
  run: (envPath: string) => Promise<number>;
  /** Start counting the keys this command makes; the returned function reads the count. */
  countKeys: () => () => number;
}

const COMMANDS: readonly KeyCommand[] = [
  {
    name: "gen-testnet-near-key",
    keyName: "AGENT_PRIVATE_KEY",
    otherNames: ["NEAR_RPC_URL"], // the default testnet RPC, written when the file has none
    run: (envPath) => nearMain(["--role", "agent"], envPath),
    countKeys: () => {
      const spy = vi.spyOn(KeyPair, "fromRandom");
      return () => spy.mock.calls.length;
    },
  },
  {
    name: "gen-testnet-evm-key",
    keyName: "HL_MASTER_TESTNET_PRIVATE_KEY",
    otherNames: ["HL_MASTER_ADDRESS"],
    run: (envPath) => Promise.resolve().then(() => evmMain([], envPath)),
    countKeys: () => {
      const generator = vi.mocked(generatePrivateKey);
      const start = generator.mock.calls.length;
      return () => generator.mock.calls.length - start;
    },
  },
];

/** The forms of a written key that must never be shown: the value and its bare part. */
function keyForms(value: string): string[] {
  return [value, value.replace(/^(?:0x|ed25519:)/, "")];
}

describe.each(COMMANDS)("$name writes .env atomically (D-15)", (command) => {
  it("no .env yet: creates it at mode 0600 even with umask 000, and leaves no temp file", async () => {
    const envPath = join(dir, ".env");
    captureConsole();
    const keysMade = command.countKeys();
    await withUmask(0o000, async () => {
      await expect(command.run(envPath)).resolves.toBe(0);
    });
    expect(keysMade()).toBe(1); // the counter works (used by the symlink test below)
    expect(readdirSync(dir)).toEqual([".env"]);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(envFileValue(readFileSync(envPath, "utf8"), command.keyName)).toBeDefined();
  });

  it.each([0o022, 0o277].map(umaskCase))("existing .env (0644): other values and comments kept, mode 0600 with umask $label", async ({ mask }) => {
    const envPath = join(dir, ".env");
    const original = [
      "# my testnet settings",
      "NEAR_NETWORK=testnet",
      "OWNER_ACCOUNT_ID=owner.testnet",
      `${command.keyName}=            # keep this comment`,
      "DEMO_TARGET=hl                  # hl | base",
      "",
    ].join("\n");
    writeFileSync(envPath, original, { mode: 0o644 });
    const out = captureConsole();
    await withUmask(mask, async () => {
      await expect(command.run(envPath)).resolves.toBe(0);
    });

    const written = readFileSync(envPath, "utf8");
    expect(readdirSync(dir)).toEqual([".env"]);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const key = envFileValue(written, command.keyName) ?? "";
    const lines = written.split("\n");
    expect(lines[3]).toBe(`${command.keyName}=${key}            # keep this comment`);
    const ours = [command.keyName, ...command.otherNames].map((n) => `${n}=`);
    const rest = (text: string) => text.split("\n").filter((l) => !ours.some((p) => l.startsWith(p)));
    expect(rest(written)).toEqual(rest(original));
    for (const form of keyForms(key)) expect(out.join("\n")).not.toContain(form);
  });

  it.each(["writeFileSync", "fsyncSync", "renameSync"] as const)(
    "a failure at %s leaves the old .env byte for byte, no temp file, and no secret in the output or error",
    async (step) => {
      const envPath = join(dir, ".env");
      const original = "# my testnet settings\nNEAR_NETWORK=testnet\nOWNER_ACCOUNT_ID=owner.testnet\n";
      writeFileSync(envPath, original, { mode: 0o600 });
      const out = captureConsole();
      const writes = vi.spyOn(envFileIo, "writeFileSync"); // records what it tried to write
      const failing = step === "writeFileSync" ? writes : vi.spyOn(envFileIo, step);
      failing.mockImplementation(() => {
        throw fsError("EIO", step);
      });

      const err = await thrown(() => command.run(envPath));

      expect(err).toBeInstanceOf(Error);
      expect(readFileSync(envPath, "utf8")).toBe(original);
      expect(readdirSync(dir)).toEqual([".env"]);
      // The content it tried to write holds the new key; none of it may show anywhere.
      const attempted = writes.mock.calls[0]?.[1] ?? "";
      const key = envFileValue(attempted, command.keyName);
      expect(key).toBeDefined();
      for (const text of [...errorTexts(err), out.join("\n")]) {
        for (const form of keyForms(key ?? "")) expect(text).not.toContain(form);
      }
    },
  );

  it("a failure with no .env yet leaves no .env and no temp file", async () => {
    const envPath = join(dir, ".env");
    captureConsole();
    vi.spyOn(envFileIo, "renameSync").mockImplementation(() => {
      throw fsError("EIO", "rename");
    });
    await expect(command.run(envPath)).rejects.toThrow(/EIO/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ["an existing file", true],
    ["a missing file", false],
  ])("a symlinked .env (to %s) is refused before any key is made; the link and its target stay as they were", async (_kind, targetExists) => {
    mkdirSync(join(dir, "app"));
    mkdirSync(join(dir, "secrets"));
    const real = join(dir, "secrets", "claw.env");
    const original = "# kept\nNEAR_NETWORK=testnet\n";
    if (targetExists) writeFileSync(real, original, { mode: 0o644 });
    const envPath = join(dir, "app", ".env");
    symlinkSync("../secrets/claw.env", envPath);
    captureConsole();
    const open = vi.spyOn(envFileIo, "openSync");
    const writes = vi.spyOn(envFileIo, "writeFileSync");
    const keysMade = command.countKeys();

    await expect(command.run(envPath)).rejects.toThrow(`${envPath} is a symbolic link; the key commands never write through a link.`);

    expect(keysMade()).toBe(0); // refused before any key exists, not only at the write
    expect(open).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(lstatSync(envPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(envPath)).toBe("../secrets/claw.env");
    expect(readdirSync(join(dir, "app"))).toEqual([".env"]);
    if (targetExists) {
      expect(readFileSync(real, "utf8")).toBe(original);
      expect(statSync(real).mode & 0o777).toBe(0o644);
      expect(readdirSync(join(dir, "secrets"))).toEqual(["claw.env"]);
    } else {
      expect(existsSync(real)).toBe(false);
      expect(readdirSync(join(dir, "secrets"))).toEqual([]);
    }
  });
});
