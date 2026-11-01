// Shared CLI plumbing: run/exit handling with redacted errors, flag parsing, contract connection.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import type { JsonRpcProvider } from "near-api-js";
import {
  type Config,
  ConfigError,
  MainnetRefusedError,
  assertTestnetAccountId,
  clawguardContractId,
  log,
  readSandboxState,
  redact,
  resolveNearRpcUrl,
} from "../config.js";
import { ClawGuardClient, assertProviderNetwork, createProvider } from "../near.js";

/** True when the module at `moduleUrl` is the script node/tsx was started with. */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry);
  } catch {
    return false;
  }
}

/** Human-readable, redacted error text. Guard failures keep their ERR_MAINNET_REFUSED prefix. */
export function errorText(err: unknown): string {
  if (err instanceof MainnetRefusedError) return redact(err.message);
  if (err instanceof ConfigError) return redact(`Config error: ${err.message}`);
  return redact(`Error: ${err instanceof Error ? err.message : String(err)}`);
}

/** Run a CLI main(); its return value is the exit code. Errors are printed redacted, exit code 1. */
export async function runCli(main: () => number | Promise<number>): Promise<void> {
  try {
    process.exitCode = await main();
  } catch (err) {
    log.error(errorText(err));
    process.exitCode = 1;
  }
}

/** Strict flag parsing (unknown flags are an error). */
export function parseFlags<const T extends ParseArgsOptionsConfig>(options: T, args: string[] = process.argv.slice(2)) {
  try {
    return parseArgs({ options, args, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
}

export function positiveIntFlag(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new ConfigError(`--${name} must be a positive integer`);
  return n;
}

export interface GuardConnection {
  provider: JsonRpcProvider;
  contractId: string;
  client: ClawGuardClient;
}

/** Read-only connection to the claw-guard contract; checks the RPC chain_id first. */
export async function connectGuard(config: Config, rpcOverride?: string): Promise<GuardConnection> {
  const provider = createProvider(resolveNearRpcUrl(config, rpcOverride));
  await assertProviderNetwork(provider, config.nearNetwork);
  const sandboxContract = config.nearNetwork === "sandbox" ? readSandboxState()?.contractId : undefined;
  const contractId = assertTestnetAccountId(
    config.clawguardContractId ?? sandboxContract ?? clawguardContractId(config),
    "claw-guard contract id",
  );
  return { provider, contractId, client: new ClawGuardClient(provider, contractId) };
}
