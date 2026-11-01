// Claw Watch source: API (agent) wallets and builder fee approvals of the Hyperliquid
// TESTNET master account (reimplements the hlwatch idea described in docs/BASELINE.md; only the two queries the
// demo needs).
//
//   POST {HL_API_URL}/info {"type":"extraAgents","user":"0x…"}      -> [{name, address, validUntil}]
//   POST {HL_API_URL}/info {"type":"approvedBuilders","user":"0x…"} -> ["0x…"]
//
// Only the exact testnet URL is accepted (assertHlTestnetUrl). Responses are parsed fail-closed:
// anything unexpected is a source error and the previous baseline is kept.
import { type FetchLike, assertHlTestnetUrl } from "../config.js";
import { type Alert, type SourceResult, hlApiWalletAdded, hlApiWalletRemoved, hlBuilderAdded, hlBuilderRemoved } from "./alerts.js";
import { byString, snapshotSha256 } from "./snapshot.js";

export const HL_INFO_TIMEOUT_MS = 10_000;

export interface HlApiWallet {
  /** Lowercase 0x address. */
  address: string;
  name: string;
  /** ms since the epoch, as reported; null when absent. */
  valid_until: number | null;
}

export interface HlSnapshot {
  /** The master account (lowercase 0x). */
  user: string;
  taken_at_ms: number;
  api_wallets: HlApiWallet[];
  /** Approved builder addresses (lowercase 0x), sorted. */
  builders: string[];
  snapshot_sha256: string;
}

export class HlInfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HlInfoError";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function address(x: unknown, what: string): string {
  if (typeof x !== "string" || !ADDRESS.test(x)) throw new HlInfoError(`${what}: expected a 0x address`);
  return x.toLowerCase();
}

/** `extraAgents` response: a list of {name, address, validUntil}. */
export function parseExtraAgents(x: unknown): HlApiWallet[] {
  if (!Array.isArray(x)) throw new HlInfoError("extraAgents: expected a list");
  return x
    .map((item, i): HlApiWallet => {
      if (typeof item !== "object" || item === null) throw new HlInfoError(`extraAgents[${i}]: expected an object`);
      const o = item as Record<string, unknown>;
      const validUntil = o.validUntil;
      if (validUntil !== undefined && validUntil !== null && (typeof validUntil !== "number" || !Number.isFinite(validUntil))) {
        throw new HlInfoError(`extraAgents[${i}].validUntil: expected a number`);
      }
      return {
        address: address(o.address, `extraAgents[${i}].address`),
        name: typeof o.name === "string" ? o.name : "",
        valid_until: typeof validUntil === "number" ? validUntil : null,
      };
    })
    .sort((a, b) => byString(a.address, b.address));
}

/**
 * `approvedBuilders` response. The documented shape is a list of addresses; objects carrying a
 * `builder` or `address` field are accepted too (the exact testnet shape is UNVERIFIED offline).
 */
export function parseApprovedBuilders(x: unknown): string[] {
  if (!Array.isArray(x)) throw new HlInfoError("approvedBuilders: expected a list");
  const builders = x.map((item, i) => {
    const what = `approvedBuilders[${i}]`;
    if (typeof item === "string") return address(item, what);
    if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      return address(o.builder ?? o.address, what);
    }
    throw new HlInfoError(`${what}: expected an address`);
  });
  return [...new Set(builders)].sort(byString);
}

export interface HlInfoOptions {
  apiUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** POST {apiUrl}/info with a JSON body; testnet URL only. */
export async function postHlInfo(body: Record<string, unknown>, { apiUrl, fetchImpl = fetch, timeoutMs = HL_INFO_TIMEOUT_MS }: HlInfoOptions): Promise<unknown> {
  const base = assertHlTestnetUrl(apiUrl);
  const res = await fetchImpl(`${base}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HlInfoError(`Hyperliquid testnet /info ${String(body.type)} returned HTTP ${res.status}`);
  try {
    const json: unknown = await res.json();
    return json;
  } catch {
    throw new HlInfoError(`Hyperliquid testnet /info ${String(body.type)} did not return JSON`);
  }
}

export function buildHlSnapshot(user: string, apiWallets: HlApiWallet[], builders: string[], takenAtMs: number): HlSnapshot {
  const content = { user, api_wallets: apiWallets, builders };
  return { ...content, taken_at_ms: takenAtMs, snapshot_sha256: snapshotSha256(content) };
}

export async function fetchHlSnapshot(user: string, options: HlInfoOptions & { now?: () => number }): Promise<HlSnapshot> {
  const master = address(user, "HL_MASTER_ADDRESS");
  const [agents, builders] = await Promise.all([
    postHlInfo({ type: "extraAgents", user: master }, options),
    postHlInfo({ type: "approvedBuilders", user: master }, options),
  ]);
  return buildHlSnapshot(master, parseExtraAgents(agents), parseApprovedBuilders(builders), (options.now ?? Date.now)());
}

/** New / removed API wallets and builder approvals. A different master account is a new baseline. */
export function diffHlSnapshots(prev: HlSnapshot, next: HlSnapshot): Alert[] {
  if (prev.user !== next.user) return [];
  const alerts: Alert[] = [];
  const before = new Set(prev.api_wallets.map((w) => w.address));
  const after = new Set(next.api_wallets.map((w) => w.address));
  for (const w of next.api_wallets) if (!before.has(w.address)) alerts.push(hlApiWalletAdded(next.user, w.address));
  for (const w of prev.api_wallets) if (!after.has(w.address)) alerts.push(hlApiWalletRemoved(next.user, w.address));
  const buildersBefore = new Set(prev.builders);
  const buildersAfter = new Set(next.builders);
  for (const b of next.builders) if (!buildersBefore.has(b)) alerts.push(hlBuilderAdded(next.user, b));
  for (const b of prev.builders) if (!buildersAfter.has(b)) alerts.push(hlBuilderRemoved(next.user, b));
  return alerts;
}

/** Check a stored snapshot before trusting it as a baseline (structure and sha256). */
export function restoreHlSnapshot(x: unknown): HlSnapshot | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const s = x as Partial<HlSnapshot>;
  try {
    if (typeof s.taken_at_ms !== "number" || typeof s.snapshot_sha256 !== "string") return undefined;
    const user = address(s.user, "user");
    const wallets = parseExtraAgents(
      (s.api_wallets ?? []).map((w) => ({ address: w.address, name: w.name, validUntil: w.valid_until })),
    );
    const rebuilt = buildHlSnapshot(user, wallets, parseApprovedBuilders(s.builders), s.taken_at_ms);
    return rebuilt.snapshot_sha256 === s.snapshot_sha256 ? rebuilt : undefined;
  } catch {
    return undefined;
  }
}

export interface HlWatchOptions extends HlInfoOptions {
  /** HL_MASTER_ADDRESS: the testnet-only master account. */
  user: string;
  now?: () => number;
  baseline?: HlSnapshot;
}

export class HlWatch {
  readonly name = "hl";
  readonly user: string;
  readonly #options: HlInfoOptions & { now?: () => number };
  #snapshot: HlSnapshot | undefined;

  constructor({ user, baseline, ...options }: HlWatchOptions) {
    assertHlTestnetUrl(options.apiUrl);
    this.user = address(user, "HL_MASTER_ADDRESS");
    this.#options = options;
    this.#snapshot = baseline?.user === this.user ? baseline : undefined;
  }

  get snapshot(): HlSnapshot | undefined {
    return this.#snapshot;
  }

  async poll(): Promise<SourceResult> {
    // Any failure throws and leaves the previous baseline in place.
    const next = await fetchHlSnapshot(this.user, this.#options);
    const prev = this.#snapshot;
    this.#snapshot = next;
    if (prev === undefined) return { alerts: [], errors: [], baseline: true };
    return { alerts: diffHlSnapshots(prev, next), errors: [], baseline: false };
  }
}
