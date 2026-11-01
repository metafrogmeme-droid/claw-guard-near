// `npm run gen-testnet-near-key -- --role agent|guardian|owner [--force] [--replace-owner-key]`:
// create a fresh ed25519 key pair (near-api-js) for the NEAR TESTNET agent, guardian or owner account and
// write its secret into offchain/.env only, as AGENT_PRIVATE_KEY, GUARDIAN_PRIVATE_KEY or
// OWNER_PRIVATE_KEY (file mode 0600, created from .env.example if missing, every other value
// untouched). The secret is never printed or logged; only the public key is. For agent and
// guardian, `setup:testnet` then adds that public key as the account's ONLY key: a function-call
// key limited to the claw-guard contract and one method (propose_order for the agent, pause for
// the guardian), never a full-access key. For owner (owner approval, 31 Oct 2026) the key is the
// full-access key of a fresh top-level TESTNET account (<name>.testnet) that the owner creates
// with the testnet faucet; it is a testnet-only throwaway, never a mainnet key.
// Runs only with NEAR_NETWORK=testnet set explicitly, in the shell or in offchain/.env (owner
// decision D-16): sandbox, unset (the config default is sandbox) or anything else is refused before
// a key is made; mainnet stays ERR_MAINNET_REFUSED. A repeated --role is refused.
// The file is written atomically (D-15, writeEnvFileAtomic): temp file at 0600, then rename; a
// symlinked .env is refused before a key is made and never written through.
// Refuses to replace an existing key unless --force. For --role owner, --force alone is refused
// (ERR_OWNER_FORCE_REFUSED): the owner key is the only full-access key of the owner account and,
// after setup:testnet, of the contract account, so replacing it would lock the owner out of the
// deployed testnet guard. Replacing it needs --force --replace-owner-key. Sends nothing to any network.
// NEAR_RPC_URL (owner request after the 31 Oct 2026 testnet rerun): when the file it writes says
// NEAR_NETWORK=testnet and its NEAR_RPC_URL is unset or empty, it also writes
// NEAR_RPC_URL=https://rpc.testnet.near.org (DEFAULT_TESTNET_RPC_URL) and prints one line saying
// so. A non-empty NEAR_RPC_URL in the file is kept byte for byte; one set in the shell (it wins
// over the file) leaves the file's NEAR_RPC_URL alone, and the shell value is used (planNearRpcUrl).
// The server never holds mainnet keys or signs for users.
import { existsSync, readFileSync } from "node:fs";
import { KeyPair, KeyPairEd25519 } from "near-api-js";
import {
  type Config,
  DEFAULT_ENV_FILE,
  DEFAULT_TESTNET_RPC_URL,
  ENV_EXAMPLE_FILE,
  MainnetRefusedError,
  Secret,
  loadConfig,
  log,
  readEnvFile,
  registerSecret,
} from "../config.js";
import { assertEnvFileTarget, envFileValue, upsertEnvValues, writeEnvFileAtomic } from "../envfile.js";
import { signerFromKey } from "../near.js";
import { isMain, parseFlags, runCli } from "./common.js";

/** What each role's key is for. Methods must match AGENT_METHODS / GUARDIAN_METHODS in setup.ts. */
export const NEAR_KEY_ROLES = {
  agent: {
    keyName: "AGENT_PRIVATE_KEY",
    accountName: "AGENT_ACCOUNT_ID",
    accountExample: "agent-1.<owner>.testnet",
    methods: ["propose_order"],
  },
  guardian: {
    keyName: "GUARDIAN_PRIVATE_KEY",
    accountName: "GUARDIAN_ACCOUNT_ID",
    accountExample: "guardian.<owner>.testnet",
    methods: ["pause"],
  },
  /** The owner's testnet full-access key (no method list): only for a fresh <name>.testnet account. */
  owner: {
    keyName: "OWNER_PRIVATE_KEY",
    accountName: "OWNER_ACCOUNT_ID",
    accountExample: "<name>.testnet",
    methods: [],
  },
} as const;

export type NearKeyRole = keyof typeof NEAR_KEY_ROLES;

const USAGE = "Usage: npm --prefix offchain run gen-testnet-near-key -- --role agent|guardian|owner [--force] [--replace-owner-key]";
const KEY_LINE = "The server never holds mainnet keys or signs for users.";

function isRole(value: string | undefined): value is NearKeyRole {
  return value === "agent" || value === "guardian" || value === "owner";
}

/** Where NEAR_NETWORK comes from, in loadConfig's order (the shell wins over the env file). Never throws. */
function nearNetworkSource(envPath: string): { where: "shell" | "file" | "unset"; value: string } {
  const shell = process.env.NEAR_NETWORK;
  if (shell !== undefined) return { where: "shell", value: shell.trim() };
  let file: string | undefined;
  try {
    file = readEnvFile(envPath).NEAR_NETWORK?.trim();
  } catch {
    file = undefined; // unreadable: loadConfig reports that itself
  }
  return file === undefined || file === "" ? { where: "unset", value: "" } : { where: "file", value: file };
}

/**
 * D-16 refusal text: what NEAR_NETWORK reads as and where it came from, and how to set it to
 * testnet from there (a shell value wins over the file, so "edit the file" alone would not help).
 */
function nearNetworkRefusal(envPath: string): string[] {
  const { where, value } = nearNetworkSource(envPath);
  let found: string;
  switch (where) {
    case "shell":
      found =
        value === ""
          ? `NEAR_NETWORK is set but empty in this shell's environment, which wins over ${envPath}, so it reads as sandbox (the default).`
          : `NEAR_NETWORK is "${value}" in this shell's environment, which wins over ${envPath}.`;
      break;
    case "file":
      found = `NEAR_NETWORK is "${value}" in ${envPath}.`;
      break;
    case "unset":
      found = `NEAR_NETWORK is not set in this shell or in ${envPath}, so it reads as sandbox (the default).`;
      break;
  }
  const fix =
    where === "shell"
      ? `Run \`export NEAR_NETWORK=testnet\` (or \`unset NEAR_NETWORK\` and put NEAR_NETWORK=testnet in ${envPath}), then run it again.`
      : `Set NEAR_NETWORK=testnet in ${envPath} (or export it in this shell), then run it again.`;
  return [
    `${found} gen-testnet-near-key makes NEAR testnet keys only and needs NEAR_NETWORK=testnet, set explicitly.`,
    `${fix} The sandbox demo needs no keys. Nothing was generated or written.`,
  ];
}

/**
 * What to do with NEAR_RPC_URL in the env file being written (pure: reads only its arguments).
 * `content` is the file as it will be written (key and NEAR_NETWORK already set); `shellValue` is
 * process.env.NEAR_RPC_URL.
 *  - shell: set in the shell, even empty; that value wins over the file (loadConfig), so the
 *    file's NEAR_RPC_URL is left alone;
 *  - keep: the file has a non-empty NEAR_RPC_URL; kept byte for byte;
 *  - not-testnet: the file does not say NEAR_NETWORK=testnet; a testnet RPC there would also be
 *    used by sandbox runs reading that file, so nothing is written;
 *  - unclear: writing it would not read back (e.g. NEAR_RPC_URL listed twice); nothing is written,
 *    so an existing value is never overwritten;
 *  - set: `content` with NEAR_RPC_URL=DEFAULT_TESTNET_RPC_URL (the only line that changes).
 */
export type NearRpcUrlPlan =
  | { action: "shell"; empty: boolean }
  | { action: "keep" }
  | { action: "not-testnet" }
  | { action: "unclear" }
  | { action: "set"; content: string };

export function planNearRpcUrl(content: string, shellValue: string | undefined): NearRpcUrlPlan {
  if (shellValue !== undefined) return { action: "shell", empty: shellValue.trim() === "" };
  if (envFileValue(content, "NEAR_RPC_URL") !== undefined) return { action: "keep" };
  if (envFileValue(content, "NEAR_NETWORK") !== "testnet") return { action: "not-testnet" };
  const next = upsertEnvValues(content, { NEAR_RPC_URL: DEFAULT_TESTNET_RPC_URL });
  if (envFileValue(next, "NEAR_RPC_URL") !== DEFAULT_TESTNET_RPC_URL) return { action: "unclear" };
  return { action: "set", content: next };
}

/** The one line printed for a NEAR_RPC_URL plan (none when the file keeps its own value). */
function nearRpcUrlLine(plan: NearRpcUrlPlan, envPath: string): { level: "info" | "warn"; text: string } | undefined {
  switch (plan.action) {
    case "set":
      return {
        level: "info",
        text:
          `Set NEAR_RPC_URL=${DEFAULT_TESTNET_RPC_URL} in ${envPath} (it was not set): the NEAR testnet RPC that ` +
          "setup:testnet and the other CLIs will use. Replace it with another testnet RPC if you prefer.",
      };
    case "shell":
      return plan.empty
        ? {
            level: "warn",
            text:
              `NEAR_RPC_URL is set but empty in this shell's environment, which wins over ${envPath}, so setup:testnet ` +
              "would find no RPC URL; the file's NEAR_RPC_URL was left as it is. Run `unset NEAR_RPC_URL` or export a testnet RPC URL.",
          }
        : {
            level: "info",
            text: `NEAR_RPC_URL is set in this shell's environment; that value is used (it wins over ${envPath}), and the file's NEAR_RPC_URL was left as it is.`,
          };
    case "not-testnet":
      return {
        level: "warn",
        text:
          `NEAR_RPC_URL was not written: ${envPath} does not say NEAR_NETWORK=testnet. Set NEAR_NETWORK=testnet and ` +
          `NEAR_RPC_URL (e.g. ${DEFAULT_TESTNET_RPC_URL}) there before setup:testnet.`,
      };
    case "unclear":
      return {
        level: "warn",
        text:
          `NEAR_RPC_URL was not written: in ${envPath} it would not read back (is NEAR_RPC_URL listed more than once?). ` +
          `Keep one NEAR_RPC_URL line (e.g. ${DEFAULT_TESTNET_RPC_URL}) before setup:testnet.`,
      };
    case "keep":
      return undefined;
  }
}

export async function main(argv: string[] = process.argv.slice(2), envPath: string = DEFAULT_ENV_FILE): Promise<number> {
  let config: Config;
  try {
    config = loadConfig({ envFile: envPath }); // testnet guards first, like every binary
  } catch (err) {
    // Any NEAR_NETWORK other than sandbox|testnet (mainnet, devnet, "Testnet", ...) stays
    // ERR_MAINNET_REFUSED, rethrown as is; also say what this command needs (D-16).
    const { value } = nearNetworkSource(envPath);
    if (err instanceof MainnetRefusedError && value !== "" && value !== "sandbox" && value !== "testnet") {
      for (const line of nearNetworkRefusal(envPath)) log.error(line);
    }
    throw err;
  }
  const flags = parseFlags(
    { role: { type: "string", multiple: true }, force: { type: "boolean" }, "replace-owner-key": { type: "boolean" } },
    argv,
  );
  const roles = flags.role ?? [];
  if (roles.length > 1) {
    // parseArgs would keep the last value; a typo like `--role agent --role guardian` must not pick one.
    log.error(USAGE);
    log.error(`--role was given ${roles.length} times; pass it exactly once.`);
    return 2;
  }
  const roleName = roles[0];
  if (!isRole(roleName)) {
    log.error(USAGE);
    log.error("--role must be agent, guardian or owner.");
    return 2;
  }
  const role = NEAR_KEY_ROLES[roleName];

  // Owner decision on PR #5: the owner key may be the only full-access key of the owner account
  // and of the contract account, so --force alone must not replace it. A separate, explicit
  // --replace-owner-key is needed, and only together with --force; it means nothing for agent or
  // guardian keys, which the owner can always re-add.
  const replaceOwnerKey = flags["replace-owner-key"] === true;
  if (replaceOwnerKey && roleName !== "owner") {
    log.error(USAGE);
    log.error("--replace-owner-key applies to --role owner only.");
    return 2;
  }
  if (replaceOwnerKey && flags.force !== true) {
    log.error(USAGE);
    log.error("--replace-owner-key works only together with --force.");
    return 2;
  }
  if (roleName === "owner" && flags.force === true && !replaceOwnerKey) {
    log.error(
      "ERR_OWNER_FORCE_REFUSED: --force does not replace OWNER_PRIVATE_KEY. It may be the only full-access key " +
        "of the owner account and of the contract account; replacing it can lock you out of the deployed " +
        "testnet guard (no unpause, set_rules or remove_agent). Move the old key out of the env file yourself, " +
        "or pass --force --replace-owner-key if you are sure. Nothing was generated or written.",
    );
    return 1;
  }

  // D-16: NEAR testnet keys only, and only when the owner said so. loadConfig defaults an unset
  // NEAR_NETWORK to sandbox, which needs no keys; refuse it (and sandbox) before any key exists.
  if (config.nearNetwork !== "testnet") {
    for (const line of nearNetworkRefusal(envPath)) log.error(line);
    return 1;
  }

  // A value in the shell environment wins over offchain/.env (loadConfig), even an empty one (it
  // then reads as "not set"), so a new key written to the file would not be the one setup:testnet
  // uses. Refuse instead of printing a public key that does not match.
  if (process.env[role.keyName] !== undefined) {
    log.error(
      `${role.keyName} is set in this shell's environment (even an empty value counts), and that value ` +
        `wins over ${envPath}. Run \`unset ${role.keyName}\` and try again.`,
    );
    return 1;
  }

  assertEnvFileTarget(envPath); // a symlinked .env (never followed) or a folder is refused before a key exists
  const exists = existsSync(envPath);
  const current = exists ? readFileSync(envPath, "utf8") : readFileSync(ENV_EXAMPLE_FILE, "utf8");
  if (envFileValue(current, role.keyName) !== undefined && flags.force !== true) {
    log.error(
      roleName === "owner"
        ? `${role.keyName} is already set in ${envPath}; it may be the only full-access key of the owner and contract accounts. Pass --force --replace-owner-key to replace it.`
        : `${role.keyName} is already set in ${envPath}; pass --force to replace it.`,
    );
    return 1;
  }

  const pair = KeyPair.fromRandom("ed25519");
  if (!(pair instanceof KeyPairEd25519)) throw new Error("near-api-js did not return an ed25519 key pair");
  const secret = new Secret(pair.toString()); // ed25519:<base58 of the 64-byte secret>, registered for redaction
  registerSecret(pair.secretKey); // the bare 32-byte seed form too
  registerSecret(pair.extendedSecretKey);

  // The public key as setup:testnet computes it (signerFromKey, like its publicKeyOf), so the
  // printed key is exactly the one setup adds. Fail closed on any mismatch, before writing.
  const publicKey = (await signerFromKey(secret).getPublicKey()).toString();
  if (publicKey !== pair.getPublicKey().toString() || !publicKey.startsWith("ed25519:")) {
    throw new Error("the new key pair does not round-trip through near-api-js; nothing was written");
  }
  // A new file starts from .env.example, which says NEAR_NETWORK=sandbox; NEAR_NETWORK=testnet
  // then came from the shell. Write it into the file too, so setup:testnet reads the same network.
  const updates: Record<string, string> = { [role.keyName]: secret.reveal() };
  if (!exists) updates.NEAR_NETWORK = "testnet";
  let next = upsertEnvValues(current, updates);
  // NEAR_RPC_URL default: only where the file says testnet and has no value of its own.
  const rpcPlan = planNearRpcUrl(next, process.env.NEAR_RPC_URL);
  if (rpcPlan.action === "set") next = rpcPlan.content;
  if (envFileValue(next, role.keyName) !== secret.reveal()) {
    throw new Error(`${role.keyName} would not read back from ${envPath}; nothing was written`);
  }
  if (!exists && envFileValue(next, "NEAR_NETWORK") !== "testnet") {
    throw new Error(`NEAR_NETWORK=testnet would not read back from ${envPath}; nothing was written`);
  }
  if (rpcPlan.action === "set" && envFileValue(next, "NEAR_RPC_URL") !== DEFAULT_TESTNET_RPC_URL) {
    throw new Error(`NEAR_RPC_URL would not read back from ${envPath}; nothing was written`);
  }

  writeEnvFileAtomic(envPath, next); // D-15: temp file (0600) + rename; the old file is kept on any error

  const contract = config.clawguardContractId ?? "the claw-guard contract (CLAWGUARD_CONTRACT_ID)";
  const configured = { agent: config.agentAccountId, guardian: config.guardianAccountId, owner: config.ownerAccountId }[roleName];
  const account = configured ?? `${role.accountName} (e.g. ${role.accountExample})`;
  const methods = role.methods.join(", ");

  if (!exists) {
    log.info(
      `Created ${envPath} from .env.example and set NEAR_NETWORK=testnet in it (it came from this shell), ` +
        "so setup:testnet reads the same network.",
    );
  } else if (envFileValue(current, "NEAR_NETWORK") !== "testnet") {
    log.warn(
      `Note: NEAR_NETWORK=testnet comes from this shell; ${envPath} does not say testnet. ` +
        `Put NEAR_NETWORK=testnet in ${envPath} (or keep it set in the shell) before setup:testnet.`,
    );
  }
  const rpcLine = nearRpcUrlLine(rpcPlan, envPath);
  if (rpcLine !== undefined) log[rpcLine.level](rpcLine.text);
  log.info(`Wrote a new testnet-only ed25519 key to ${envPath} (${role.keyName}, file mode 600). The secret is not shown.`);
  log.info(`Public key: ${publicKey}`);
  if (roleName === "owner") {
    log.info(
      `Next step: create ${account} on NEAR testnet with this public key as its full-access key ` +
        "(the testnet faucet creates and funds new .testnet accounts). Testnet only: never reuse this key on mainnet.",
    );
    log.info("Check the plan with `npm --prefix offchain run setup:testnet` (a dry run: it sends no transaction without --yes).");
    log.info(KEY_LINE);
    return 0;
  }
  log.info(
    `Next step: setup:testnet adds this public key to ${account} as its ONLY key: a function-call key ` +
      `limited to ${contract} and the method ${methods}. It is never a full-access key.`,
  );
  if (roleName === "guardian") {
    log.info(`setup:testnet creates the guardian only when ${role.accountName} is set in ${envPath}.`);
  }
  log.info(
    `If the owner adds the key by hand instead, add it only as a function-call key with that receiver and ` +
      `the method ${methods}, never as a full-access key.`,
  );
  log.info("Check the plan with `npm --prefix offchain run setup:testnet` (a dry run: it sends no transaction without --yes).");
  log.info(KEY_LINE);
  return 0;
}

if (isMain(import.meta.url)) void runCli(() => main());
