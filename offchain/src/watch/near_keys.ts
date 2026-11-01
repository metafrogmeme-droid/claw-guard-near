// Claw Watch source: NEAR access keys of the owner, agent, contract and guardian
// accounts (guardian added by owner decision D-10). Every watched account is treated the
// same: a new key of any kind alerts and may trigger the autopause, a removed key only alerts.
//
// Each poll reads `view_access_key_list` for every watched account, builds a snapshot of what each
// key may do (public key, permission kind, receiver, method names) and diffs it against the
// previous one. Nonces and remaining gas allowances change on every use, so they are not part of
// the snapshot. The first successful read of an account is its baseline and raises no alert.
import type { Provider } from "near-api-js";
import type { NearNetwork } from "../config.js";
import { type AccessKeyEntry, viewAccessKeyList } from "../near.js";
import { type Alert, type KeyKind, type SourceResult, nearExplorerUrl, nearKeyAdded, nearKeyRemoved } from "./alerts.js";
import { byString, canonicalJson, snapshotSha256 } from "./snapshot.js";

/** What a key is allowed to do. Two entries with equal JSON are the same key. */
export interface WatchedKey {
  public_key: string;
  kind: KeyKind;
  receiver_id?: string;
  method_names?: string[];
  /**
   * For kinds this code does not know (gas keys, future kinds): the permission variant name only,
   * since the rest may hold balances that change with every use.
   */
  permission?: string;
}

export interface KeySnapshot {
  taken_at_ms: number;
  /** account id -> keys sorted by public key. Accounts never read successfully are absent. */
  accounts: Record<string, WatchedKey[]>;
  snapshot_sha256: string;
}

export function toWatchedKey(entry: AccessKeyEntry): WatchedKey {
  switch (entry.kind) {
    case "FullAccess":
      return { public_key: entry.publicKey, kind: "FullAccess" };
    case "FunctionCall":
      return {
        public_key: entry.publicKey,
        kind: "FunctionCall",
        receiver_id: entry.receiverId,
        method_names: [...entry.methodNames].sort(byString),
      };
    case "Other":
      return { public_key: entry.publicKey, kind: "Other", permission: permissionVariant(entry.permission) };
  }
}

/** `"FullAccess"` -> itself; `{GasKeyFunctionCall: {...}}` -> `"GasKeyFunctionCall"`. */
function permissionVariant(permission: unknown): string {
  if (typeof permission === "string") return permission;
  if (typeof permission === "object" && permission !== null) return Object.keys(permission).sort(byString).join(",");
  return typeof permission;
}

export function buildKeySnapshot(accounts: Readonly<Record<string, readonly WatchedKey[]>>, takenAtMs: number): KeySnapshot {
  const sorted: Record<string, WatchedKey[]> = {};
  for (const id of Object.keys(accounts).sort(byString)) {
    sorted[id] = [...(accounts[id] ?? [])].sort((a, b) => byString(a.public_key, b.public_key));
  }
  return { taken_at_ms: takenAtMs, accounts: sorted, snapshot_sha256: snapshotSha256(sorted) };
}

/**
 * Alerts for every key added to, changed on, or removed from an account present in both
 * snapshots. A key whose permission changed is reported as a new key of its new kind. Accounts
 * that appear only in `next` are new baselines and raise nothing.
 */
export function diffKeySnapshots(prev: KeySnapshot, next: KeySnapshot, network: NearNetwork): Alert[] {
  const alerts: Alert[] = [];
  for (const [account, nextKeys] of Object.entries(next.accounts)) {
    const prevKeys = prev.accounts[account];
    if (prevKeys === undefined) continue;
    const url = nearExplorerUrl(network, account);
    const before = new Map(prevKeys.map((k) => [k.public_key, k]));
    const after = new Map(nextKeys.map((k) => [k.public_key, k]));
    for (const key of nextKeys) {
      const old = before.get(key.public_key);
      if (old === undefined || canonicalJson(old) !== canonicalJson(key)) {
        alerts.push(nearKeyAdded(account, key.public_key, key.kind, url));
      }
    }
    for (const key of prevKeys) {
      if (!after.has(key.public_key)) alerts.push(nearKeyRemoved(account, key.public_key, key.kind, url));
    }
  }
  return alerts;
}

export interface KeyRead {
  accounts: Record<string, WatchedKey[]>;
  /** account id -> error text, for accounts that could not be read this time. */
  errors: Record<string, string>;
}

/** Read the key lists of `accountIds`; one failing account does not hide the others. */
export async function readAccountKeys(provider: Provider, accountIds: readonly string[]): Promise<KeyRead> {
  const results = await Promise.allSettled(accountIds.map((id) => viewAccessKeyList(provider, id)));
  const read: KeyRead = { accounts: {}, errors: {} };
  results.forEach((result, i) => {
    const id = accountIds[i] as string;
    if (result.status === "fulfilled") read.accounts[id] = result.value.map(toWatchedKey);
    else read.errors[id] = result.reason instanceof Error ? result.reason.message : String(result.reason);
  });
  return read;
}

/** Check a stored snapshot before trusting it as a baseline (structure and sha256). */
export function restoreKeySnapshot(x: unknown): KeySnapshot | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const s = x as Partial<KeySnapshot>;
  if (typeof s.taken_at_ms !== "number" || typeof s.snapshot_sha256 !== "string") return undefined;
  if (typeof s.accounts !== "object" || s.accounts === null) return undefined;
  const keyKinds: readonly string[] = ["FullAccess", "FunctionCall", "Other"];
  for (const keys of Object.values(s.accounts as Record<string, unknown>)) {
    if (!Array.isArray(keys)) return undefined;
    for (const k of keys as unknown[]) {
      const key = k as Partial<WatchedKey> | null;
      if (key === null || typeof key !== "object" || typeof key.public_key !== "string" || !keyKinds.includes(String(key.kind))) {
        return undefined;
      }
    }
  }
  const rebuilt = buildKeySnapshot(s.accounts, s.taken_at_ms);
  return rebuilt.snapshot_sha256 === s.snapshot_sha256 ? rebuilt : undefined;
}

export interface NearKeysWatchOptions {
  provider: Provider;
  /** Owner, agent, contract and guardian accounts (D-10). */
  accounts: readonly string[];
  network: NearNetwork;
  now?: () => number;
  /** A stored baseline (see restoreKeySnapshot). */
  baseline?: KeySnapshot;
}

export class NearKeysWatch {
  readonly name = "near_keys";
  readonly accounts: readonly string[];
  readonly #provider: Provider;
  readonly #network: NearNetwork;
  readonly #now: () => number;
  #snapshot: KeySnapshot | undefined;

  constructor({ provider, accounts, network, now = Date.now, baseline }: NearKeysWatchOptions) {
    if (accounts.length === 0) throw new Error("NearKeysWatch needs at least one account");
    this.#provider = provider;
    this.accounts = [...new Set(accounts)];
    this.#network = network;
    this.#now = now;
    this.#snapshot = baseline;
  }

  /** The current baseline (for persistence). */
  get snapshot(): KeySnapshot | undefined {
    return this.#snapshot;
  }

  async poll(): Promise<SourceResult> {
    const read = await readAccountKeys(this.#provider, this.accounts);
    const errors = Object.entries(read.errors).map(([id, err]) => `cannot read access keys of ${id}: ${err}`);
    // An account that failed this time keeps its previous keys, so its next good read is still
    // compared with the old baseline instead of silently becoming a new one.
    const merged: Record<string, WatchedKey[]> = { ...read.accounts };
    for (const id of Object.keys(read.errors)) {
      const previous = this.#snapshot?.accounts[id];
      if (previous !== undefined) merged[id] = previous;
    }
    const next = buildKeySnapshot(merged, this.#now());
    const prev = this.#snapshot;
    this.#snapshot = next;
    if (prev === undefined) return { alerts: [], errors, baseline: true };
    return { alerts: diffKeySnapshots(prev, next, this.#network), errors, baseline: false };
  }
}
