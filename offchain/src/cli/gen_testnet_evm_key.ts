// `npm run gen-testnet-evm-key`: create a fresh throwaway EVM key for the Hyperliquid
// TESTNET master account and write it into offchain/.env only. The key is never printed; only its
// address is. Never use this key on any mainnet. Refuses to replace an existing key unless --force.
// The file is written atomically (owner decision D-15, writeEnvFileAtomic): a temp file at mode
// 0600 in the same folder, then renamed over .env; on any error the old file is left as it was.
// A symlinked .env is refused before a key is made and never written through.
// The network rules are those of every binary (loadConfig); D-16 applies to the NEAR key command only.
// The server never holds mainnet keys or signs for users.
import { existsSync, readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { DEFAULT_ENV_FILE, ENV_EXAMPLE_FILE, Secret, loadConfig, log } from "../config.js";
import { assertEnvFileTarget, envFileValue, upsertEnvValues, writeEnvFileAtomic } from "../envfile.js";
import { isMain, parseFlags, runCli } from "./common.js";

const KEY_NAME = "HL_MASTER_TESTNET_PRIVATE_KEY";
const ADDRESS_NAME = "HL_MASTER_ADDRESS";

export function main(argv: string[] = process.argv.slice(2), envPath: string = DEFAULT_ENV_FILE): number {
  loadConfig({ envFile: envPath }); // testnet guards first, like every binary
  const flags = parseFlags({ force: { type: "boolean" } }, argv);

  assertEnvFileTarget(envPath); // a symlinked .env (never followed) or a folder is refused before a key exists
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(ENV_EXAMPLE_FILE, "utf8");
  if (envFileValue(current, KEY_NAME) !== undefined && flags.force !== true) {
    log.error(`${KEY_NAME} is already set in ${envPath}; pass --force to replace it.`);
    return 1;
  }

  const key = new Secret(generatePrivateKey()); // registered for redaction immediately
  const address = privateKeyToAddress(key.reveal() as `0x${string}`);
  const next = upsertEnvValues(current, { [KEY_NAME]: key.reveal(), [ADDRESS_NAME]: address });
  // Fail closed if the file would not read back as written (e.g. a later empty line hides the value).
  if (envFileValue(next, KEY_NAME) !== key.reveal() || envFileValue(next, ADDRESS_NAME) !== address) {
    throw new Error(`${KEY_NAME} or ${ADDRESS_NAME} would not read back from ${envPath}; nothing was written`);
  }
  writeEnvFileAtomic(envPath, next);

  log.info(`Wrote a new throwaway testnet-only key to ${envPath} (${KEY_NAME}, file mode 600).`);
  log.info(`${ADDRESS_NAME}=${address}`);
  log.info("Use it only as the Hyperliquid testnet master account. Never use it on any mainnet.");
  log.info("The server never holds mainnet keys or signs for users.");
  return 0;
}

if (isMain(import.meta.url)) void runCli(() => main());
