// Claw Watch alert objects and ALL of their user-facing wording.
//
// Every alert text is either "Public signal: <what changed>" or, for a blocked order, the receipt
// message verbatim: "Order #<id> by <agent>: Blocked by your rule: <rule>" ("Order by <agent> (no
// receipt stored: contract storage reserve): …" when the decision's receipt id is 0). Alerts describe what
// changed; they never judge an address, key or order. Keeping the wording in this one file lets the
// console output, the Telegram module and the copy tests share it.
//
// One extra Telegram-only line lives here too (owner decision D-09): a new builder fee approval is
// sent to Telegram as "Needs your OK: …". It only asks the owner to look; reviewing and approving
// stays in the console, and the console alert keeps its "Public signal: …" wording.

/** NEAR access key permission kinds as normalised by near.ts. */
export type KeyKind = "FullAccess" | "FunctionCall" | "Other";

export const PUBLIC_SIGNAL = "Public signal: ";
/** Start of the Telegram line for a new builder fee approval (D-09). */
export const NEEDS_YOUR_OK = "Needs your OK: ";
/** Pause reasons the watcher passes to the contract must fit the contract's limit, in UTF-8 bytes. */
export const MAX_PAUSE_REASON_BYTES = 140;
/** Blocked-burst rule: this many blocked receipts within BURST_WINDOW_MS. */
export const BURST_THRESHOLD = 3;
export const BURST_WINDOW_MS = 10 * 60 * 1000;

interface AlertBase {
  /** The user-facing line. */
  readonly text: string;
  /** Dedupe key `(kind, receipt id | key)`: the same event always yields the same key. */
  readonly key: string;
  /** Testnet explorer link, only where one exists. */
  readonly explorerUrl?: string;
  /** Reason for the guardian pause() when CLAW_WATCH_AUTOPAUSE=1; absent on alerts that never pause. */
  readonly autopauseReason?: string;
}

export type Alert = AlertBase &
  (
    | { readonly kind: "near_key_added"; readonly account: string; readonly publicKey: string; readonly keyKind: KeyKind }
    | { readonly kind: "near_key_removed"; readonly account: string; readonly publicKey: string; readonly keyKind: KeyKind }
    | { readonly kind: "hl_api_wallet_added"; readonly user: string; readonly address: string }
    | { readonly kind: "hl_api_wallet_removed"; readonly user: string; readonly address: string }
    | { readonly kind: "hl_builder_added"; readonly user: string; readonly builder: string }
    | { readonly kind: "hl_builder_removed"; readonly user: string; readonly builder: string }
    | {
        readonly kind: "order_blocked";
        readonly receiptId: string;
        readonly agentId: string;
        readonly message: string;
        /** Block time of the receipt, ms since the epoch. */
        readonly timestampMs: number;
      }
    | { readonly kind: "blocked_burst"; readonly count: number; readonly receiptIds: readonly string[] }
    | { readonly kind: "agent_paused"; readonly by: string | null; readonly reason: string | null }
    | { readonly kind: "agent_unpaused"; readonly by: string | null }
    | { readonly kind: "storage_reserve_low"; readonly contractId: string; readonly roomReceipts: number }
    | { readonly kind: "storage_reserve_reached"; readonly contractId: string }
    | { readonly kind: "storage_reserve_ok"; readonly contractId: string }
  );

export type AlertKind = Alert["kind"];
export type AlertOf<K extends AlertKind> = Extract<Alert, { kind: K }>;

/** What one watch source reports for one poll. Errors are operational notes, never alerts. */
export interface SourceResult {
  alerts: Alert[];
  errors: string[];
  /** True when this poll only recorded a baseline (first poll: no alerts by design). */
  baseline: boolean;
}

/** Minimal logger; config.ts `log` (always redacted) satisfies it. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

// C0/C1 controls, line/paragraph separators and bidi overrides: none of them may reach an alert,
// so a value read from chain or from Hyperliquid can never fake an extra line or reorder text.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

/** One printable line of at most `max` characters (code points), for values echoed into alerts. */
export function oneLine(value: string, max = 200): string {
  const flat = value.replace(UNPRINTABLE, " ").replace(/ {2,}/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Clamp a pause reason to one line within the contract's 140-byte limit (UTF-8, like Rust `str::len`). */
export function pauseReason(text: string): string {
  const flat = oneLine(text, Number.MAX_SAFE_INTEGER);
  if (utf8Length(flat) <= MAX_PAUSE_REASON_BYTES) return flat;
  let out = "";
  let bytes = utf8Length("…");
  for (const ch of flat) {
    bytes += utf8Length(ch);
    if (bytes > MAX_PAUSE_REASON_BYTES) break;
    out += ch;
  }
  return `${out}…`;
}

/**
 * NEAR testnet explorer page for an account; none for the local sandbox. nearblocks can lag behind
 * the chain: right after the 31 Oct 2026 testnet rerun its API returned empty transaction lists,
 * while FastNEAR's testnet transaction API (tx.test.fastnear.com) answered. The link stays on
 * nearblocks (its address page format is verified, docs/VERIFY.md (a)); a FastNEAR link would
 * need a URL format nobody has checked yet.
 */
export function nearExplorerUrl(network: "sandbox" | "testnet", accountId: string): string | undefined {
  return network === "testnet" ? `https://testnet.nearblocks.io/address/${encodeURIComponent(accountId)}` : undefined;
}

const KEY_KIND_WORDS: Record<KeyKind, string> = {
  FullAccess: "full-access key",
  FunctionCall: "function-call key",
  Other: "access key of an unrecognised type",
};

const KEY_PAUSE_REASONS: Record<KeyKind, string> = {
  FullAccess: "watch: new full-access key",
  FunctionCall: "watch: new function-call key",
  Other: "watch: new access key",
};

const withUrl = (url: string | undefined): { explorerUrl?: string } => (url === undefined ? {} : { explorerUrl: url });

// ---------------------------------------------------------------------------
// Builders (the only place alert wording is written)
// ---------------------------------------------------------------------------

export function nearKeyAdded(
  account: string,
  publicKey: string,
  keyKind: KeyKind,
  explorerUrl?: string,
): AlertOf<"near_key_added"> {
  return {
    kind: "near_key_added",
    account,
    publicKey,
    keyKind,
    text: `${PUBLIC_SIGNAL}new ${KEY_KIND_WORDS[keyKind]} on ${oneLine(account)}`,
    // The kind is part of the key: a key deleted and re-added with more power is a new event.
    key: `near_key_added:${account}:${publicKey}:${keyKind}`,
    autopauseReason: KEY_PAUSE_REASONS[keyKind],
    ...withUrl(explorerUrl),
  };
}

export function nearKeyRemoved(
  account: string,
  publicKey: string,
  keyKind: KeyKind,
  explorerUrl?: string,
): AlertOf<"near_key_removed"> {
  return {
    kind: "near_key_removed",
    account,
    publicKey,
    keyKind,
    text: `${PUBLIC_SIGNAL}key removed from ${oneLine(account)}`,
    key: `near_key_removed:${account}:${publicKey}`,
    ...withUrl(explorerUrl),
  };
}

const HL_ACCOUNT = "your Hyperliquid testnet account";

export function hlApiWalletAdded(user: string, address: string): AlertOf<"hl_api_wallet_added"> {
  return {
    kind: "hl_api_wallet_added",
    user,
    address,
    text: `${PUBLIC_SIGNAL}new API wallet ${address} on ${HL_ACCOUNT}`,
    key: `hl_api_wallet_added:${user}:${address}`,
    autopauseReason: "watch: new API wallet",
  };
}

export function hlApiWalletRemoved(user: string, address: string): AlertOf<"hl_api_wallet_removed"> {
  return {
    kind: "hl_api_wallet_removed",
    user,
    address,
    text: `${PUBLIC_SIGNAL}API wallet ${address} removed from ${HL_ACCOUNT}`,
    key: `hl_api_wallet_removed:${user}:${address}`,
  };
}

export function hlBuilderAdded(user: string, builder: string): AlertOf<"hl_builder_added"> {
  return {
    kind: "hl_builder_added",
    user,
    builder,
    text: `${PUBLIC_SIGNAL}new builder fee approval for ${builder} on ${HL_ACCOUNT}`,
    key: `hl_builder_added:${user}:${builder}`,
    autopauseReason: "watch: new builder fee approval",
  };
}

/**
 * The Telegram line for a new builder fee approval (D-09):
 * `Needs your OK: new builder fee approval 0x… on your Hyperliquid testnet account. Review it in the console.`
 */
export function needsYourOkText(alert: AlertOf<"hl_builder_added">): string {
  return `${NEEDS_YOUR_OK}new builder fee approval ${oneLine(alert.builder, 100)} on ${HL_ACCOUNT}. Review it in the console.`;
}

export function hlBuilderRemoved(user: string, builder: string): AlertOf<"hl_builder_removed"> {
  return {
    kind: "hl_builder_removed",
    user,
    builder,
    text: `${PUBLIC_SIGNAL}builder fee approval for ${builder} removed from ${HL_ACCOUNT}`,
    key: `hl_builder_removed:${user}:${builder}`,
  };
}

/**
 * `Order #<id> by <agent>: <receipt message verbatim>` (the message starts "Blocked by your rule: ").
 * Receipt id "0" means the contract stored no receipt (it kept its storage reserve; the receipts
 * source never sees such orders, only an `order_blocked` event does): the text says so, and the
 * dedupe key adds `where` (e.g. `<tx hash>:<event index>`; else block time and agent), so two such
 * orders never collapse into one alert.
 */
export function orderBlocked(
  receiptId: string,
  agentId: string,
  message: string,
  timestampMs: number,
  where?: string,
): AlertOf<"order_blocked"> {
  const stored = receiptId !== "0";
  const order = stored ? `Order #${receiptId} by ${oneLine(agentId)}` : `Order by ${oneLine(agentId)} (no receipt stored: contract storage reserve)`;
  return {
    kind: "order_blocked",
    receiptId,
    agentId,
    message,
    timestampMs,
    text: `${order}: ${oneLine(message, 300)}`,
    key: stored ? `order_blocked:${receiptId}` : `order_blocked:0:${where ?? `${timestampMs}:${agentId}`}`,
  };
}

export function blockedBurst(receiptIds: readonly string[]): AlertOf<"blocked_burst"> {
  const count = receiptIds.length;
  return {
    kind: "blocked_burst",
    count,
    receiptIds: [...receiptIds],
    text: `${PUBLIC_SIGNAL}${count} orders blocked in the last 10 min`,
    key: `blocked_burst:${receiptIds[0] ?? "none"}`,
    autopauseReason: `watch: ${count} blocked orders in 10 min`,
  };
}

/** `seq` makes each pause transition a distinct event for dedupe. */
export function agentPaused(by: string | null, reason: string | null, seq: number): AlertOf<"agent_paused"> {
  const who = by === null ? "" : ` by ${oneLine(by)}`;
  const why = reason === null || reason === "" ? "" : ` (${oneLine(reason, MAX_PAUSE_REASON_BYTES)})`;
  return { kind: "agent_paused", by, reason, text: `${PUBLIC_SIGNAL}agent paused${who}${why}`, key: `agent_paused:${seq}` };
}

export function agentUnpaused(by: string | null, seq: number): AlertOf<"agent_unpaused"> {
  const who = by === null ? "" : ` by ${oneLine(by)}`;
  return { kind: "agent_unpaused", by, text: `${PUBLIC_SIGNAL}agent unpaused${who}`, key: `agent_unpaused:${seq}` };
}

/**
 * Contract storage reserve (D-20, was Q-56; D-18): the contract stores a blocked receipt only
 * while its balance covers (storage_usage + 4096 bytes) x byte cost. Below that, blocked orders get
 * receipt id "0", so the receipts source cannot see them; these alerts say so. `seq` counts level
 * changes, so every transition has its own dedupe key.
 */
export function storageReserveLow(contractId: string, roomReceipts: number, seq: number): AlertOf<"storage_reserve_low"> {
  return {
    kind: "storage_reserve_low",
    contractId,
    roomReceipts,
    text: `${PUBLIC_SIGNAL}contract storage reserve is close on ${oneLine(contractId)}: room for about ${roomReceipts} more blocked receipts. Add NEAR to the contract.`,
    key: `storage_reserve_low:${contractId}:${seq}`,
  };
}

export function storageReserveReached(contractId: string, seq: number): AlertOf<"storage_reserve_reached"> {
  return {
    kind: "storage_reserve_reached",
    contractId,
    text:
      `${PUBLIC_SIGNAL}contract storage reserve reached on ${oneLine(contractId)}. Orders are still checked and blocked by your rules, ` +
      "but blocked orders get no stored receipt (receipt id 0) and no order alert. Nothing is signed for them. " +
      "Add NEAR to the contract to store receipts again.",
    key: `storage_reserve_reached:${contractId}:${seq}`,
    autopauseReason: "watch: storage reserve reached",
  };
}

export function storageReserveOk(contractId: string, seq: number): AlertOf<"storage_reserve_ok"> {
  return {
    kind: "storage_reserve_ok",
    contractId,
    text: `${PUBLIC_SIGNAL}contract storage reserve back to normal on ${oneLine(contractId)}: blocked receipts are stored again.`,
    key: `storage_reserve_ok:${contractId}:${seq}`,
  };
}

// ---------------------------------------------------------------------------
// Autopause selection
// ---------------------------------------------------------------------------

/** Alert kinds that can trigger the opt-in guardian pause, most important first. */
export const AUTOPAUSE_KINDS = [
  "near_key_added",
  "hl_api_wallet_added",
  "hl_builder_added",
  "blocked_burst",
  "storage_reserve_reached",
] as const;
export type AutopauseKind = (typeof AUTOPAUSE_KINDS)[number];

const KEY_KIND_RANK: Record<KeyKind, number> = { FullAccess: 0, Other: 1, FunctionCall: 2 };

function autopauseRank(alert: Alert): number {
  const kindRank = (AUTOPAUSE_KINDS as readonly string[]).indexOf(alert.kind);
  const sub = alert.kind === "near_key_added" ? KEY_KIND_RANK[alert.keyKind] : 0;
  return kindRank * 10 + sub;
}

/** The alert whose reason the guardian pause should carry (a new full-access key wins), if any. */
export function pickAutopauseAlert(
  alerts: readonly Alert[],
  enabledKinds: readonly AutopauseKind[] = AUTOPAUSE_KINDS,
): (Alert & { autopauseReason: string }) | undefined {
  const candidates = alerts.filter(
    (a): a is Alert & { autopauseReason: string } =>
      a.autopauseReason !== undefined && (enabledKinds as readonly string[]).includes(a.kind),
  );
  return candidates.sort((a, b) => autopauseRank(a) - autopauseRank(b))[0];
}
