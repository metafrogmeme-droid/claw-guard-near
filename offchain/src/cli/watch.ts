// `npm run watch -- [--once] [--interval N] [--rpc url] [--state file] [--fresh]`
//
// Claw Watch CLI. Watches the access keys of the owner, agent, contract and guardian accounts
// (the guardian when GUARDIAN_ACCOUNT_ID is set, or guardian.test.near in sandbox, plus the owner
// and guardian the contract names in get_status at start; owner decisions D-07, D-10), the
// guard's receipts and pause state, and (testnet with HL_MASTER_ADDRESS set) the
// Hyperliquid testnet API wallets and builder fee approvals of the master account. Prints
// "Public signal: …" alerts. Read-only unless CLAW_WATCH_AUTOPAUSE=1, which needs
// GUARDIAN_ACCOUNT_ID + GUARDIAN_PRIVATE_KEY (a function-call key with the method pause only) and
// pauses the guard with "watch: <what changed>"; a new key on any watched account, the guardian's
// included, triggers it, a removed key never does.
//
// Baselines are kept in a state file (default offchain/.sandbox/watch-<network>.json, git-ignored)
// so that `--once` runs compare with the previous run; --fresh ignores it.
import { join } from "node:path";
import type { JsonRpcProvider } from "near-api-js";
import {
  type Config,
  OFFCHAIN_DIR,
  SANDBOX_IDS,
  assertTestnetAccountId,
  isTestnetAccountId,
  loadConfig,
  log,
  requireValue,
} from "../config.js";
import { type ClawGuardClient, connectAccount, signerFromKey } from "../near.js";
import {
  type AutopauseOptions,
  type ChainIdentity,
  type ClawWatch,
  type PollReport,
  assertPauseOnlyGuardianKey,
  createClawWatch,
  createTelegramNotifier,
  oneLine,
  readWatchState,
  reportLines,
  telegramSettings,
  writeWatchState,
} from "../watch/index.js";
import { connectGuard, isMain, parseFlags, positiveIntFlag, runCli } from "./common.js";

export function defaultStatePath(config: Pick<Config, "nearNetwork">): string {
  return join(OFFCHAIN_DIR, ".sandbox", `watch-${config.nearNetwork}.json`);
}

/** Owner and guardian as the contract itself names them (get_status). */
export interface ContractNamedAccounts {
  owner?: string;
  guardian?: string;
}

/**
 * Owner, agent, contract and guardian accounts, in that order (sandbox defaults when not
 * configured), then the owner and guardian the contract names, so the guardian set on chain is
 * watched even when GUARDIAN_ACCOUNT_ID is not set (D-07, D-10). An account named twice is
 * watched once.
 */
export function watchedAccounts(config: Config, contractId: string, named: ContractNamedAccounts = {}): string[] {
  const sandbox = config.nearNetwork === "sandbox";
  const owner = config.ownerAccountId ?? (sandbox ? SANDBOX_IDS.owner : undefined);
  const agent = config.agentAccountId ?? (sandbox ? SANDBOX_IDS.agent : undefined);
  const guardian = config.guardianAccountId ?? (sandbox ? SANDBOX_IDS.guardian : undefined);
  const ids = [owner, agent, contractId, guardian, named.owner, named.guardian].filter((id): id is string => id !== undefined);
  return [...new Set(ids.map((id) => assertTestnetAccountId(id, "watched account id")))];
}

/** Read the contract's owner and guardian once at start; on failure watch the configured accounts only. */
async function contractNamedAccounts(client: ClawGuardClient): Promise<ContractNamedAccounts> {
  let status: Awaited<ReturnType<ClawGuardClient["getStatus"]>>;
  try {
    status = await client.getStatus();
  } catch {
    log.warn("Claw Watch: cannot read the contract's owner and guardian (get_status); watching the configured accounts only");
    return {};
  }
  const named: ContractNamedAccounts = {};
  for (const [role, id] of [["owner", status.owner], ["guardian", status.guardian]] as const) {
    if (id === null) continue;
    if (isTestnetAccountId(id)) named[role] = id;
    else log.warn(`Claw Watch: the contract's ${role} ${oneLine(id, 100)} is not a testnet account id; its keys are not watched`);
  }
  return named;
}

/** The guardian pauser, after checking its key can only call pause on this contract. */
async function guardianAutopause(
  config: Config,
  provider: JsonRpcProvider,
  client: ClawGuardClient,
): Promise<AutopauseOptions> {
  const guardianId = requireValue(config.guardianAccountId, "GUARDIAN_ACCOUNT_ID");
  const signer = signerFromKey(requireValue(config.guardianPrivateKey, "GUARDIAN_PRIVATE_KEY"));
  const publicKey = (await signer.getPublicKey()).toString();
  await assertPauseOnlyGuardianKey(provider, guardianId, publicKey, client.contractId);
  return { pauser: client.as(connectAccount(guardianId, provider, signer)) };
}

function printReport(report: PollReport, { quietWhenEmpty }: { quietWhenEmpty: boolean }): void {
  const lines = reportLines(report);
  if (lines.length === 0 && !quietWhenEmpty) lines.push(["info", "Claw Watch: no changes"]);
  for (const [level, line] of lines) log[level](line);
}

export async function main(
  argv: string[] = process.argv.slice(2),
  { config = loadConfig() }: { config?: Config } = {},
): Promise<number> {
  const flags = parseFlags(
    {
      once: { type: "boolean" },
      interval: { type: "string" },
      rpc: { type: "string" },
      state: { type: "string" },
      fresh: { type: "boolean" },
    },
    argv,
  );
  const intervalSec = positiveIntFlag(flags.interval, "interval", config.clawWatchIntervalSec);
  const { provider, contractId, client } = await connectGuard(config, flags.rpc);
  const accounts = watchedAccounts(config, contractId, await contractNamedAccounts(client));
  const hl =
    config.nearNetwork === "testnet" && config.hlMasterAddress !== undefined
      ? { apiUrl: config.hlApiUrl, user: config.hlMasterAddress }
      : undefined;
  const autopause = config.clawWatchAutopause ? await guardianAutopause(config, provider, client) : undefined;
  const telegram = createTelegramNotifier(telegramSettings(config));

  const chain: ChainIdentity = {
    network: config.nearNetwork,
    genesis_hash: (await provider.viewNodeStatus()).genesis_hash,
    contract_id: contractId,
  };
  const statePath = flags.state ?? defaultStatePath(config);
  const baselines = flags.fresh === true ? {} : readWatchState(statePath, chain);

  const watch: ClawWatch = createClawWatch({
    provider,
    client,
    network: config.nearNetwork,
    accounts,
    sinks: [telegram],
    storageReserve: true,
    baselines,
    ...(hl === undefined ? {} : { hl }),
    ...(autopause === undefined ? {} : { autopause }),
  });

  log.info(`Claw Watch on NEAR ${config.nearNetwork}: access keys of ${accounts.join(", ")}; receipts, pause state and storage reserve of ${contractId}`);
  log.info(
    `Claw Watch: Hyperliquid testnet source ${hl === undefined ? "off" : `on (${hl.user})`}; ` +
      `autopause ${autopause === undefined ? "off" : "on (guardian, pause only)"}; ` +
      `Telegram alerts ${telegram.enabled ? "on" : "off"}`,
  );

  const save = (): void => writeWatchState(statePath, chain, watch.baselines());
  if (flags.once === true) {
    const report = await watch.pollOnce();
    printReport(report, { quietWhenEmpty: false });
    save();
    await watch.flush();
    return report.errors.length > 0 ? 1 : 0;
  }

  const stop = new AbortController();
  const onSignal = (): void => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await watch.run({
      intervalSec,
      signal: stop.signal,
      onReport: (report) => {
        printReport(report, { quietWhenEmpty: true });
        save();
      },
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  log.info("Claw Watch stopped");
  return 0;
}

if (isMain(import.meta.url)) void runCli(() => main());
