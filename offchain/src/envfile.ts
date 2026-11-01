// Helpers to edit a dotenv file (used by gen-testnet-evm-key and gen-testnet-near-key):
// pure text edits (envFileValue, upsertEnvValues) and the atomic write (owner decision D-15).
// Testnet only: these files hold throwaway testnet keys. The server never holds mainnet keys or
// signs for users.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { ConfigError } from "./config.js";

/** Current (non-empty) value of `name` in dotenv `content`, or undefined. */
export function envFileValue(content: string, name: string): string | undefined {
  const value = (parseEnv(content) as Record<string, string | undefined>)[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Set each `NAME=value` in dotenv `content`, keeping the rest of the file and any
 * trailing `# comment` on the replaced line; names not present are appended.
 */
export function upsertEnvValues(content: string, updates: Readonly<Record<string, string>>): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  for (const [name, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`invalid env name ${name}`);
    if (/[\s#"'\\]/.test(value)) throw new Error(`value for ${name} must not contain spaces, quotes or #`);
    const pattern = new RegExp(`^(\\s*${name}\\s*=)[^#\\n]*?(\\s+#.*)?$`);
    const index = lines.findIndex((line) => pattern.test(line));
    if (index === -1) {
      lines.push(`${name}=${value}`);
    } else {
      lines[index] = (lines[index] ?? "").replace(pattern, (_m, head: string, comment: string | undefined) => {
        return `${head}${value}${comment ?? ""}`;
      });
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Atomic write (D-15)
// ---------------------------------------------------------------------------

/** Every temp file starts with this, in the target's folder (git-ignored: `.env.*`, `.env.tmp-*`). */
export const ENV_TEMP_PREFIX = ".env.tmp-";

/** The file-system calls writeEnvFileAtomic makes. Tests replace one of them to inject a failure. */
export interface EnvFileIo {
  openSync: (path: string, flags: string, mode?: number) => number;
  fchmodSync: (fd: number, mode: number) => void;
  writeFileSync: (fd: number, data: string) => void;
  fsyncSync: (fd: number) => void;
  ftruncateSync: (fd: number, length: number) => void;
  closeSync: (fd: number) => void;
  readFileSync: (path: string) => string;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
}

/** The real node:fs calls (the default). Exported only as a test seam. */
export const envFileIo: EnvFileIo = {
  openSync: (path, flags, mode) => openSync(path, flags, mode),
  fchmodSync: (fd, mode) => fchmodSync(fd, mode),
  writeFileSync: (fd, data) => writeFileSync(fd, data, "utf8"),
  fsyncSync: (fd) => fsyncSync(fd),
  ftruncateSync: (fd, length) => ftruncateSync(fd, length),
  closeSync: (fd) => closeSync(fd),
  readFileSync: (path) => readFileSync(path, "utf8"),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (path) => unlinkSync(path),
};

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
}

/**
 * Refuse a dotenv path that writeEnvFileAtomic must not replace. Call it before making a key, so a
 * bad target is refused before any secret exists.
 *
 * Symlinks are REFUSED, never followed (D-15): if `path` itself is a symbolic link (even one to a
 * file that does not exist), this throws a ConfigError and nothing is written through it, so a
 * key never lands in a file somewhere else. (A link in a parent folder is fine: the temp file
 * and the rename stay in that one real folder.) A path that is not a regular file (a folder, a
 * device) is refused too. A missing `path` is fine: the file is created there.
 */
export function assertEnvFileTarget(path: string): void {
  let isLink: boolean;
  let isFile: boolean;
  try {
    const stats = lstatSync(path); // lstat: looks at the link itself, does not follow it
    isLink = stats.isSymbolicLink();
    isFile = stats.isFile();
  } catch (err) {
    if (errorCode(err) === "ENOENT") return; // not there yet: created by the rename
    throw err;
  }
  if (isLink) {
    throw new ConfigError(
      `${path} is a symbolic link; the key commands never write through a link. ` +
        "Replace the link with the file itself and run the command again. Nothing was written.",
    );
  }
  if (!isFile) throw new ConfigError(`${path} is not a regular file. Nothing was written.`);
}

/**
 * Write `content` to the dotenv file at `path` atomically (owner decision D-15): a crash, a full
 * disk or any error never leaves a truncated or half-written file.
 *
 * 1. A temp file `.env.tmp-<random>` is created EXCLUSIVELY (O_CREAT|O_EXCL, so an existing file or
 *    a planted symlink is never reused) in the same folder as the target, then set to mode 0600
 *    with fchmod, so the final file is 0600 whatever the umask.
 * 2. The content is written, fsynced, and read back; a mismatch fails.
 * 3. The temp file is renamed over the target (atomic within one folder), then the folder is
 *    fsynced (best effort: some systems cannot fsync a folder; the rename has happened by then).
 *
 * On ANY error before the rename finishes, the temp file is removed (or, if it cannot be removed,
 * emptied through its still-open descriptor) and the error is rethrown: the old file stays byte
 * for byte as it was. Errors carry file names and error codes only, never the content.
 * A symlinked `path` is refused (assertEnvFileTarget). Should one appear between that check and
 * the rename, rename(2) replaces the link itself and still writes nothing through it.
 */
export function writeEnvFileAtomic(path: string, content: string, io: EnvFileIo = envFileIo): void {
  assertEnvFileTarget(path);
  const folder = dirname(path);
  const temp = join(folder, `${ENV_TEMP_PREFIX}${randomBytes(12).toString("hex")}`);

  let fd: number | undefined;
  try {
    fd = io.openSync(temp, "wx", 0o600);
    io.fchmodSync(fd, 0o600); // the umask may have removed bits (e.g. 0400): set exactly 0600
    io.writeFileSync(fd, content);
    io.fsyncSync(fd);
    if (io.readFileSync(temp) !== content) {
      throw new Error(`the new ${basename(path)} did not read back as written; nothing was changed`);
    }
    io.renameSync(temp, path);
  } catch (err) {
    if (fd !== undefined) removeTemp(temp, fd, io); // fd set = the temp file exists and is ours
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // the data is fsynced (or the write already failed and is reported); nothing to add
      }
    }
  }
  fsyncFolder(folder, io);
}

/**
 * Remove a temp file that may hold a secret. If unlinking fails, empty it through its open
 * descriptor (never by path, which a swapped-in link could redirect). Never throws.
 */
function removeTemp(temp: string, fd: number, io: EnvFileIo): void {
  try {
    io.unlinkSync(temp);
    return;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
  }
  try {
    io.ftruncateSync(fd, 0);
    io.fsyncSync(fd);
  } catch {
    // nothing more can be done here
  }
}

/** fsync a folder so the rename itself survives a crash. Best effort: never throws. */
function fsyncFolder(folder: string, io: EnvFileIo): void {
  let fd: number | undefined;
  try {
    fd = io.openSync(folder, "r");
    io.fsyncSync(fd);
  } catch {
    // some file systems and platforms cannot fsync a folder; the rename is already done
  } finally {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
