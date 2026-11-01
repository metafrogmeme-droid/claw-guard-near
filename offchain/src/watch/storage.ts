// Claw Watch source: the claw-guard contract's storage reserve (D-20, was Q-56; D-18).
//
// The contract stores a blocked receipt only while its balance covers
// (storage_usage + RECEIPT_STORAGE_RESERVE_BYTES) x byte cost. Below that floor a blocked order is
// still blocked, with the same decision and `order_blocked` event, but its receipt id is "0" and
// nothing is stored, so the receipts source never sees it. This source reads the contract account
// (`view_account`: unlocked balance and storage usage, the same inputs the contract uses) and
// reports the level: ok, low (room for fewer than LOW_ROOM_RECEIPTS worst-case blocked receipts)
// or reached. One alert per level change. Unlike the diff-based sources, a first poll that finds
// the level low or reached alerts at once: it is a state the owner must fix, not a change.
import type { Alert, SourceResult } from "./alerts.js";
import { storageReserveLow, storageReserveOk, storageReserveReached } from "./alerts.js";

/** Same constant as `RECEIPT_STORAGE_RESERVE_BYTES` in contracts/claw-guard/src/rules.rs. */
export const RECEIPT_STORAGE_RESERVE_BYTES = 4096n;
/** NEAR storage staking cost, 10^19 yoctoNEAR per byte (protocol constant on sandbox, testnet and mainnet). */
export const STORAGE_BYTE_COST_YOCTO = 10n ** 19n;
/** Worst-case storage of one blocked receipt with key and record overhead (measured, D-18). */
export const WORST_BLOCKED_RECEIPT_BYTES = 702n;
/** Below room for this many worst-case blocked receipts the level is "low". */
export const LOW_ROOM_RECEIPTS = 100n;

export type ReserveLevel = "ok" | "low" | "reached";

/** `provider.viewAccount` of near-api-js satisfies it. */
export interface AccountReader {
  viewAccount(args: { accountId: string }): Promise<{ amount: string | bigint; storage_usage: number | bigint }>;
}

export interface StorageState {
  contract_id: string;
  level: ReserveLevel;
  /** Counts level changes, so every alert has its own dedupe key. */
  seq: number;
}

export interface StorageWatchOptions {
  reader: AccountReader;
  contractId: string;
  baseline?: StorageState;
}

/** `(storage_usage + 4096) x byte cost`, the contract's floor for storing a blocked receipt. */
export function reserveFloorYocto(storageUsage: bigint, byteCost: bigint = STORAGE_BYTE_COST_YOCTO): bigint {
  return (storageUsage + RECEIPT_STORAGE_RESERVE_BYTES) * byteCost;
}

function toBigInt(value: string | bigint | number, what: string): bigint {
  if (typeof value === "bigint") return value;
  const text = String(value);
  if (!/^[0-9]+$/.test(text)) throw new Error(`view_account returned an unreadable ${what}`);
  return BigInt(text);
}

export class StorageReserveWatch {
  readonly name = "storage";
  readonly #reader: AccountReader;
  readonly #contractId: string;
  #state: StorageState | undefined;

  constructor({ reader, contractId, baseline }: StorageWatchOptions) {
    this.#reader = reader;
    this.#contractId = contractId;
    this.#state = baseline?.contract_id === contractId ? structuredClone(baseline) : undefined;
  }

  get state(): StorageState | undefined {
    return this.#state === undefined ? undefined : structuredClone(this.#state);
  }

  /** Throws when the account cannot be read (the watcher reports it as an error, never an alert). */
  async poll(): Promise<SourceResult> {
    const account = await this.#reader.viewAccount({ accountId: this.#contractId });
    const balance = toBigInt(account.amount, "amount");
    const usage = toBigInt(account.storage_usage, "storage_usage");
    const floor = reserveFloorYocto(usage);
    const roomBytes = balance >= floor ? (balance - floor) / STORAGE_BYTE_COST_YOCTO : -1n;
    const roomReceipts = roomBytes < 0n ? 0n : roomBytes / WORST_BLOCKED_RECEIPT_BYTES;
    const level: ReserveLevel = balance < floor ? "reached" : roomReceipts < LOW_ROOM_RECEIPTS ? "low" : "ok";

    const before = this.#state;
    const baseline = before === undefined;
    const previous: ReserveLevel = before?.level ?? "ok";
    const seq = before?.seq ?? 0;
    const alerts: Alert[] = [];
    let next = seq;
    if (level !== previous) {
      next = seq + 1;
      const id = this.#contractId;
      alerts.push(
        level === "reached"
          ? storageReserveReached(id, next)
          : level === "low"
            ? storageReserveLow(id, Number(roomReceipts), next)
            : storageReserveOk(id, next),
      );
    }
    this.#state = { contract_id: this.#contractId, level, seq: next };
    return { alerts, errors: [], baseline };
  }
}

/** Check a stored state before trusting it as a baseline. */
export function restoreStorageState(x: unknown): StorageState | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const s = x as Partial<StorageState>;
  const levels: readonly unknown[] = ["ok", "low", "reached"];
  if (typeof s.contract_id !== "string" || !levels.includes(s.level)) return undefined;
  if (typeof s.seq !== "number" || !Number.isSafeInteger(s.seq) || s.seq < 0) return undefined;
  return { contract_id: s.contract_id, level: s.level as ReserveLevel, seq: s.seq };
}
