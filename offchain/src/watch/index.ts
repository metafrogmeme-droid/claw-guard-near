// Claw Watch: watches NEAR access keys (owner, agent,
// contract and guardian accounts; the guardian per owner decision D-10), Hyperliquid testnet API
// wallets and builder fee approvals, and claw-guard receipts / pause state, and reports what
// changed as "Public signal: …" alerts. Optional: forwards alerts to Telegram (telegram.ts; a new
// builder fee approval goes there as "Needs your OK: …", D-09) and, only with
// CLAW_WATCH_AUTOPAUSE=1, pauses the guard through the guardian's function-call key (method
// `pause` only) with the reason "watch: <what changed>".
//
// The first poll of every source is a baseline and raises nothing. Programmatic use (the demo
// runs poll cycles in-process):
//
//   const watch = createClawWatch({ provider, client, network: "sandbox",
//     accounts: [owner, agent, contract, guardian], autopause: { pauser: client.as(guardianAccount) } });
//   await watch.pollOnce();                  // baseline
//   ...                                      // something changes on chain
//   const report = await watch.pollOnce();   // report.alerts, report.autopause
//
// `npm run watch` runs this file; the CLI itself lives in src/cli/watch.ts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Provider } from "near-api-js";
import { isMain, runCli } from "../cli/common.js";
import { ConfigError, type FetchLike, type NearNetwork, log, redact } from "../config.js";
import { viewAccessKeyList } from "../near.js";
import type { ClawGuardEvent } from "../types.js";
import { type Alert, type AutopauseKind, type Logger, type SourceResult, pauseReason, pickAutopauseAlert } from "./alerts.js";
import { type HlSnapshot, HlWatch, restoreHlSnapshot } from "./hl.js";
import { type KeySnapshot, NearKeysWatch, restoreKeySnapshot } from "./near_keys.js";
import { type ReceiptsReader, type ReceiptsState, ReceiptsWatch, restoreReceiptsState } from "./receipts.js";
import { type StorageState, StorageReserveWatch, restoreStorageState } from "./storage.js";

export * from "./alerts.js";
export { HlWatch } from "./hl.js";
export { NearKeysWatch } from "./near_keys.js";
export { ReceiptsWatch, type ReceiptsReader } from "./receipts.js";
export { StorageReserveWatch, type AccountReader } from "./storage.js";
export { createTelegramNotifier, telegramSettings, type TelegramNotifier } from "./telegram.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Receives every alert of a poll (e.g. the Telegram notifier). */
export interface AlertSink {
  notify(alerts: readonly Alert[]): void | Promise<void>;
  /** Wait until queued alerts are delivered (or dropped). */
  flush?(): Promise<void>;
}

/** The guardian side of the contract; `ClawGuardClient.as(guardianAccount)` satisfies it. */
export interface Pauser {
  pause(reason: string): Promise<{ events: readonly ClawGuardEvent[] }>;
}

export interface AutopauseOptions {
  pauser: Pauser;
  /** Alert kinds that may trigger the pause (default: all of AUTOPAUSE_KINDS). */
  on?: readonly AutopauseKind[];
}

export type AutopauseOutcome =
  | { status: "paused"; reason: string }
  | { status: "skipped"; reason: string; detail: string }
  | { status: "failed"; reason: string; error: string };

export interface PollReport {
  /** Alerts of this cycle, including the pause alert caused by an autopause. */
  alerts: Alert[];
  /** Operational problems ("<source>: <message>"), never alerts. Redacted. */
  errors: string[];
  /** Sources that only recorded their baseline this cycle. */
  baselines: string[];
  autopause?: AutopauseOutcome;
}

interface Source {
  readonly name: string;
  poll(): Promise<SourceResult>;
}

/** Baselines restored from a state file (see readWatchState). */
export interface StoredBaselines {
  near_keys?: KeySnapshot;
  hl?: HlSnapshot;
  receipts?: ReceiptsState;
  storage?: StorageState;
}

export interface ClawWatchParts {
  nearKeys?: NearKeysWatch;
  hl?: HlWatch;
  receipts?: ReceiptsWatch;
  storage?: StorageReserveWatch;
  sinks?: readonly AlertSink[];
  autopause?: AutopauseOptions;
  logger?: Logger;
}

const errorMessage = (err: unknown): string => redact(err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// ClawWatch
// ---------------------------------------------------------------------------

export class ClawWatch {
  readonly #nearKeys: NearKeysWatch | undefined;
  readonly #hl: HlWatch | undefined;
  readonly #receipts: ReceiptsWatch | undefined;
  readonly #storage: StorageReserveWatch | undefined;
  readonly #sources: readonly Source[];
  readonly #sinks: readonly AlertSink[];
  readonly #autopause: AutopauseOptions | undefined;
  readonly #logger: Logger;
  #polling = false;

  constructor({ nearKeys, hl, receipts, storage, sinks = [], autopause, logger = log }: ClawWatchParts) {
    this.#nearKeys = nearKeys;
    this.#hl = hl;
    this.#receipts = receipts;
    this.#storage = storage;
    // Fixed order: keys first, so a new full-access key and the blocked orders it explains share a cycle.
    this.#sources = [nearKeys, hl, receipts, storage].filter((s): s is NonNullable<typeof s> => s !== undefined);
    if (this.#sources.length === 0) throw new Error("Claw Watch needs at least one source");
    this.#sinks = sinks;
    this.#autopause = autopause;
    this.#logger = logger;
  }

  get sourceNames(): string[] {
    return this.#sources.map((s) => s.name);
  }

  get autopauseEnabled(): boolean {
    return this.#autopause !== undefined;
  }

  /** One poll cycle: every source, then the optional autopause, then the sinks. Never throws for a source error. */
  async pollOnce(): Promise<PollReport> {
    if (this.#polling) throw new Error("Claw Watch: a poll is already running");
    this.#polling = true;
    try {
      const report: PollReport = { alerts: [], errors: [], baselines: [] };
      let receiptsOk = false;
      for (const source of this.#sources) {
        try {
          const result = await source.poll();
          report.alerts.push(...result.alerts);
          report.errors.push(...result.errors.map((e) => redact(`${source.name}: ${e}`)));
          if (result.baseline) report.baselines.push(source.name);
          if (source === this.#receipts) receiptsOk = true;
        } catch (err) {
          report.errors.push(`${source.name}: ${errorMessage(err)}`);
        }
      }
      const outcome = await this.#maybeAutopause(report, receiptsOk);
      if (outcome !== undefined) report.autopause = outcome;
      await this.#deliver(report.alerts);
      return report;
    } finally {
      this.#polling = false;
    }
  }

  /** Current baselines, for a state file. */
  baselines(): StoredBaselines {
    const out: StoredBaselines = {};
    const keys = this.#nearKeys?.snapshot;
    const hl = this.#hl?.snapshot;
    const receipts = this.#receipts?.state;
    const storage = this.#storage?.state;
    if (storage !== undefined) out.storage = storage;
    if (keys !== undefined) out.near_keys = keys;
    if (hl !== undefined) out.hl = hl;
    if (receipts !== undefined) out.receipts = receipts;
    return out;
  }

  /** Wait for every sink to deliver what it queued. */
  async flush(): Promise<void> {
    await Promise.all(this.#sinks.map(async (sink) => sink.flush?.()));
  }

  /** Poll every `intervalSec` until `signal` aborts; `onReport` sees each cycle. */
  async run({
    intervalSec,
    signal,
    onReport,
  }: {
    intervalSec: number;
    signal?: AbortSignal;
    onReport?: (report: PollReport) => void | Promise<void>;
  }): Promise<void> {
    while (signal?.aborted !== true) {
      const report = await this.pollOnce();
      await onReport?.(report);
      try {
        await delay(intervalSec * 1000, undefined, signal === undefined ? {} : { signal });
      } catch {
        break; // aborted while waiting
      }
    }
    await this.flush();
  }

  /**
   * Pause once per cycle for the most important pause-worthy alert. Skipped only when the
   * receipts source read the guard this cycle and it is already paused (fail closed otherwise).
   */
  async #maybeAutopause(report: PollReport, receiptsOk: boolean): Promise<AutopauseOutcome | undefined> {
    if (this.#autopause === undefined) return undefined;
    const trigger = pickAutopauseAlert(report.alerts, this.#autopause.on);
    if (trigger === undefined) return undefined;
    const reason = pauseReason(trigger.autopauseReason);
    if (receiptsOk && this.#receipts?.paused === true) {
      return { status: "skipped", reason, detail: "the guard is already paused" };
    }
    try {
      const { events } = await this.#autopause.pauser.pause(reason);
      // The contract's own paused event says who paused; the next status poll then sees no change.
      report.alerts.push(...(this.#receipts?.observeEvents(events) ?? []));
      return { status: "paused", reason };
    } catch (err) {
      const error = errorMessage(err);
      report.errors.push(`autopause: ${error}`);
      return { status: "failed", reason, error };
    }
  }

  async #deliver(alerts: readonly Alert[]): Promise<void> {
    if (alerts.length === 0) return;
    for (const sink of this.#sinks) {
      try {
        await sink.notify(alerts);
      } catch (err) {
        this.#logger.error(`Claw Watch: alert sink failed: ${errorMessage(err)}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface ClawWatchSetup {
  /** NEAR RPC provider (sandbox or testnet; see near.ts createProvider). */
  provider: Provider;
  /** Read side of the claw-guard contract (ClawGuardClient). Omit to skip receipts and pause state. */
  client?: ReceiptsReader;
  network: NearNetwork;
  /**
   * Accounts whose access keys are watched: owner, agent, contract and, when there is one, the
   * guardian (D-10). Every account listed gets the same alerts and autopause.
   */
  accounts: readonly string[];
  /** Hyperliquid testnet master account to watch; omit to skip the HL source. */
  hl?: { apiUrl: string; user: string; fetchImpl?: FetchLike };
  autopause?: AutopauseOptions;
  sinks?: readonly AlertSink[];
  logger?: Logger;
  /**
   * Also watch the contract's storage reserve (Q-56) through `provider.viewAccount`; needs `client`.
   * Off by default, so callers that replay fixed RPC fixtures are unchanged.
   */
  storageReserve?: boolean;
  baselines?: StoredBaselines;
  now?: () => number;
}

export function createClawWatch(setup: ClawWatchSetup): ClawWatch {
  const { baselines = {}, now } = setup;
  const parts: ClawWatchParts = {
    nearKeys: new NearKeysWatch({
      provider: setup.provider,
      accounts: setup.accounts,
      network: setup.network,
      ...(now === undefined ? {} : { now }),
      ...(baselines.near_keys === undefined ? {} : { baseline: baselines.near_keys }),
    }),
  };
  if (setup.hl !== undefined) {
    parts.hl = new HlWatch({
      ...setup.hl,
      ...(now === undefined ? {} : { now }),
      ...(baselines.hl === undefined ? {} : { baseline: baselines.hl }),
    });
  }
  if (setup.client !== undefined) {
    parts.receipts = new ReceiptsWatch({
      reader: setup.client,
      ...(baselines.receipts === undefined ? {} : { baseline: baselines.receipts }),
    });
  }
  if (setup.client !== undefined && setup.storageReserve === true) {
    parts.storage = new StorageReserveWatch({
      reader: setup.provider,
      contractId: setup.client.contractId,
      ...(baselines.storage === undefined ? {} : { baseline: baselines.storage }),
    });
  }
  if (setup.sinks !== undefined) parts.sinks = setup.sinks;
  if (setup.autopause !== undefined) parts.autopause = setup.autopause;
  if (setup.logger !== undefined) parts.logger = setup.logger;
  return new ClawWatch(parts);
}

/**
 * Refuse a guardian key that can do more than pause: it must be a function-call key of
 * `guardianId` for `contractId` with exactly the method `pause` (least privilege).
 */
export async function assertPauseOnlyGuardianKey(
  provider: Provider,
  guardianId: string,
  publicKey: string,
  contractId: string,
): Promise<void> {
  const key = (await viewAccessKeyList(provider, guardianId)).find((k) => k.publicKey === publicKey);
  if (key === undefined) throw new ConfigError(`GUARDIAN_PRIVATE_KEY is not an access key of ${guardianId}`);
  const pauseOnly =
    key.kind === "FunctionCall" && key.receiverId === contractId && key.methodNames.length === 1 && key.methodNames[0] === "pause";
  if (!pauseOnly) {
    throw new ConfigError(
      `the guardian key must be a function-call key for ${contractId} with the method pause only (it is a ${key.kind} key); autopause refused`,
    );
  }
}

/** Console lines for a poll report: [level, text]. Alerts first, in the order they happened. */
export function reportLines(report: PollReport): Array<["info" | "warn" | "error", string]> {
  const lines: Array<["info" | "warn" | "error", string]> = [];
  if (report.baselines.length > 0) lines.push(["info", `Claw Watch: baseline recorded (${report.baselines.join(", ")})`]);
  for (const alert of report.alerts) {
    lines.push(["info", alert.text]);
    if (alert.explorerUrl !== undefined) lines.push(["info", `  ${alert.explorerUrl}`]);
  }
  const ap = report.autopause;
  if (ap?.status === "paused") lines.push(["info", `Claw Watch: guardian pause sent (${ap.reason})`]);
  if (ap?.status === "skipped") lines.push(["info", `Claw Watch: no pause sent, ${ap.detail} (${ap.reason})`]);
  if (ap?.status === "failed") lines.push(["error", `Claw Watch: guardian pause failed (${ap.reason}): ${ap.error}`]);
  for (const error of report.errors) if (!error.startsWith("autopause: ")) lines.push(["warn", `Claw Watch: ${error}`]);
  return lines;
}

// ---------------------------------------------------------------------------
// State file (lets `watch --once` runs compare with the previous run)
// ---------------------------------------------------------------------------

/** Which chain and contract a state file belongs to; a mismatch means a fresh baseline. */
export interface ChainIdentity {
  network: NearNetwork;
  genesis_hash: string;
  contract_id: string;
}

export interface WatchStateFile extends StoredBaselines {
  version: 1;
  chain: ChainIdentity;
}

const sameChain = (a: unknown, b: ChainIdentity): boolean =>
  typeof a === "object" &&
  a !== null &&
  (a as ChainIdentity).network === b.network &&
  (a as ChainIdentity).genesis_hash === b.genesis_hash &&
  (a as ChainIdentity).contract_id === b.contract_id;

/** Baselines stored for `chain`, or {} (no file, another chain, or a damaged file: new baseline). */
export function readWatchState(path: string, chain: ChainIdentity, logger: Logger = log): StoredBaselines {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") logger.warn(`Claw Watch: ignoring unreadable state file ${path}`);
    return {};
  }
  const file = raw as Partial<WatchStateFile> | null;
  if (file === null || typeof file !== "object" || file.version !== 1 || !sameChain(file.chain, chain)) {
    logger.info(`Claw Watch: state file ${path} is for another chain or contract; recording a new baseline`);
    return {};
  }
  const out: StoredBaselines = {};
  const parts: Array<[keyof StoredBaselines, unknown, (x: unknown) => unknown]> = [
    ["near_keys", file.near_keys, restoreKeySnapshot],
    ["hl", file.hl, restoreHlSnapshot],
    ["receipts", file.receipts, restoreReceiptsState],
    ["storage", file.storage, restoreStorageState],
  ];
  for (const [name, value, restore] of parts) {
    if (value === undefined) continue;
    const restored = restore(value);
    if (restored === undefined) logger.warn(`Claw Watch: stored ${name} baseline failed its check; recording a new one`);
    else Object.assign(out, { [name]: restored });
  }
  return out;
}

/** Write the state file atomically (temp file + rename). */
export function writeWatchState(path: string, chain: ChainIdentity, baselines: StoredBaselines): void {
  const file: WatchStateFile = { version: 1, chain, ...baselines };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

// `npm run watch` runs this file. The CLI module imports this one, so it is loaded only after this
// module has finished evaluating (a top-level await here would wait on itself).
if (isMain(import.meta.url)) void import("../cli/watch.js").then(({ main }) => runCli(() => main()));
