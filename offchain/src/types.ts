// TypeScript mirror of the claw-guard contract JSON.
//
// Wire conventions (near-sdk serde defaults):
//  - U64 / U128 are decimal strings; u8 / u32 are JSON numbers; plain u64 is a JSON number.
//  - Enums with data are externally tagged: {"HlOrder": {...}}; unit enums are strings.
//  - Option<T> is T | null.
// Parsers validate structure and types and throw ParseError on anything else (fail
// closed). Proposal *values* are kept as sent: receipts record malformed proposals
// that the contract blocked, and the views must still be able to show them.

export class ParseError extends Error {
  constructor(path: string, expected: string) {
    super(`unexpected contract JSON at ${path}: expected ${expected}`);
    this.name = "ParseError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const TARGETS = ["HlTestnet", "BaseSepolia"] as const;
export type Target = (typeof TARGETS)[number];

export const TIFS = ["Gtc", "Ioc", "Alo"] as const;
export type Tif = (typeof TIFS)[number];

export const RECEIPT_STATUSES = ["Blocked", "PendingSignature", "Signed", "SignFailed"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Derivation path per target. */
export const DERIVATION_PATHS: Readonly<Record<Target, string>> = {
  HlTestnet: "hl-testnet-1",
  BaseSepolia: "base-sepolia-1",
};

export interface MarketRule {
  name: string;
  asset: number;
  max_order_sz: string;
  /** Hyperliquid `szDecimals` for this market (0..=6), set by the owner from /info meta. */
  sz_decimals: number;
}

export interface TokenRule {
  symbol: string;
  address: string;
  decimals: number;
  max_per_order: string;
}

export interface Rules {
  targets: Target[];
  markets: MarketRule[];
  max_order_notional: string;
  max_leverage: number;
  tokens: TokenRule[];
  receivers: string[];
  daily_cap: string;
  max_orders_per_day: number;
  expires_at_ns: string;
  reduce_only_required: boolean;
}

export interface AgentState {
  rules: Rules;
  rules_version: number;
  /** Loosened rules waiting for confirm_rules, with their eta (ns). */
  pending: [Rules, string] | null;
  day: number;
  spent_today: string;
  orders_today: number;
  /** Added by the contract: nonce floors; the next nonce must be greater. */
  last_hl_nonce_ms: string | null;
  last_evm_nonce: string | null;
}

export interface HlOrder {
  market: string;
  is_buy: boolean;
  limit_px: string;
  sz: string;
  reduce_only: boolean;
  /** "Gtc" | "Ioc" | "Alo" when well-formed; any string can be proposed (and is blocked). */
  tif: string;
  nonce_ms: string;
}

export interface HlUpdateLeverage {
  market: string;
  is_cross: boolean;
  leverage: number;
  nonce_ms: string;
}

export interface EvmTransfer {
  token: string;
  to: string;
  amount: string;
  nonce: string;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

export type OrderRequest =
  | { HlOrder: HlOrder }
  | { HlUpdateLeverage: HlUpdateLeverage }
  | { EvmTransfer: EvmTransfer };

export type OrderKind = "HlOrder" | "HlUpdateLeverage" | "EvmTransfer";

export interface Proposal {
  target: Target;
  order: OrderRequest;
  /** ≤ 140 bytes (UTF-8), logged only. */
  memo?: string | null;
}

/** r, s: 0x + 64 lowercase hex. v: 27/28 for Hyperliquid, y-parity 0/1 for EIP-1559. */
export interface Sig {
  r: string;
  s: string;
  v: number;
}

export interface Receipt {
  id: string;
  agent_id: string;
  target: Target;
  proposal: Proposal;
  status: ReceiptStatus;
  rule_code: string | null;
  message: string;
  /** 0x + 32 bytes: exactly what the MPC signed. */
  payload_hash: string | null;
  /** HL: canonical action JSON; Base: 0x unsigned EIP-1559 tx. */
  signed_body: string | null;
  derivation_path: string | null;
  signature: Sig | null;
  rules_version: number;
  block_height: string;
  timestamp_ns: string;
}

export interface Decision {
  allowed: boolean;
  /** From "1"; "0" = blocked, no receipt stored because the contract kept its storage reserve. */
  receipt_id: string;
  rule_code: string | null;
  message: string;
  signature: Sig | null;
}

/** get_status view (GuardStatus). */
export interface GuardStatus {
  owner: string;
  guardian: string | null;
  paused: boolean;
  pause_reason: string | null;
  mpc_contract_id: string;
  agents_count: number;
  receipts_count: number;
}

/** preview_payload view: {"Ok":"0x…payload_hash"} or {"Err":"Blocked by your rule: …"}. */
export type PreviewResult = { Ok: string } | { Err: string };

/** Arguments of the contract's #[init] new(...). */
export interface InitArgs {
  owner_id: string;
  guardian_id: string | null;
  mpc_contract_id: string;
  sign_deposit_yocto: string;
  sign_gas_tgas: number;
  loosen_delay_sec: number;
}

/** NEP-297 event as logged by the contract (`EVENT_JSON:{…}`). */
export interface ClawGuardEvent {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>[];
}

export const ALLOWED_MESSAGE = "Allowed: within your limits";
export const BLOCKED_PREFIX = "Blocked by your rule: ";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function orderKind(order: OrderRequest): OrderKind {
  if ("HlOrder" in order) return "HlOrder";
  if ("HlUpdateLeverage" in order) return "HlUpdateLeverage";
  return "EvmTransfer";
}

export function isTarget(value: unknown): value is Target {
  return typeof value === "string" && (TARGETS as readonly string[]).includes(value);
}

export function isTif(value: unknown): value is Tif {
  return typeof value === "string" && (TIFS as readonly string[]).includes(value);
}

/** Normalise an id given as bigint/number/string to the U64 wire form (decimal string). */
export function toU64(value: bigint | number | string): string {
  const s = typeof value === "string" ? value : value.toString();
  if (!/^\d+$/.test(s) || BigInt(s) > 0xffff_ffff_ffff_ffffn) throw new RangeError(`not a u64: ${s}`);
  return BigInt(s).toString();
}

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function obj(x: unknown, path: string): Obj {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new ParseError(path, "object");
  return x as Obj;
}
function arr(x: unknown, path: string): unknown[] {
  if (!Array.isArray(x)) throw new ParseError(path, "array");
  return x;
}
function str(x: unknown, path: string): string {
  if (typeof x !== "string") throw new ParseError(path, "string");
  return x;
}
function bool(x: unknown, path: string): boolean {
  if (typeof x !== "boolean") throw new ParseError(path, "boolean");
  return x;
}
function int(x: unknown, path: string, max: number = Number.MAX_SAFE_INTEGER): number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0 || x > max) {
    throw new ParseError(path, `integer in [0, ${max}]`);
  }
  return x;
}
/** U64/U128 wire strings: digits only. */
function uintStr(x: unknown, path: string): string {
  if (typeof x !== "string" || !/^\d+$/.test(x)) throw new ParseError(path, "decimal string");
  return x;
}
/** A plain u64 count may arrive as a number or a U64 string; normalise to number. */
function count(x: unknown, path: string): number {
  if (typeof x === "string" && /^\d+$/.test(x) && Number.isSafeInteger(Number(x))) return Number(x);
  return int(x, path);
}
function nullable<T>(x: unknown, path: string, read: (v: unknown, p: string) => T): T | null {
  return x === null || x === undefined ? null : read(x, path);
}
function target(x: unknown, path: string): Target {
  if (!isTarget(x)) throw new ParseError(path, `one of ${TARGETS.join(" | ")}`);
  return x;
}
function hex32(x: unknown, path: string): string {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw new ParseError(path, "0x + 64 hex");
  return x.toLowerCase();
}
/** Externally tagged enum: exactly one key. */
function tagged(x: unknown, path: string): [string, unknown] {
  const o = obj(x, path);
  const keys = Object.keys(o);
  if (keys.length !== 1) throw new ParseError(path, "externally tagged enum (one key)");
  const key = keys[0] as string;
  return [key, o[key]];
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseSig(x: unknown, path = "signature"): Sig {
  const o = obj(x, path);
  return { r: hex32(o.r, `${path}.r`), s: hex32(o.s, `${path}.s`), v: int(o.v, `${path}.v`, 255) };
}

export function parseOrderRequest(x: unknown, path = "order"): OrderRequest {
  const [kind, body] = tagged(x, path);
  const p = `${path}.${kind}`;
  switch (kind) {
    case "HlOrder": {
      const o = obj(body, p);
      return {
        HlOrder: {
          market: str(o.market, `${p}.market`),
          is_buy: bool(o.is_buy, `${p}.is_buy`),
          limit_px: str(o.limit_px, `${p}.limit_px`),
          sz: str(o.sz, `${p}.sz`),
          reduce_only: bool(o.reduce_only, `${p}.reduce_only`),
          tif: str(o.tif, `${p}.tif`),
          nonce_ms: uintStr(o.nonce_ms, `${p}.nonce_ms`),
        },
      };
    }
    case "HlUpdateLeverage": {
      const o = obj(body, p);
      return {
        HlUpdateLeverage: {
          market: str(o.market, `${p}.market`),
          is_cross: bool(o.is_cross, `${p}.is_cross`),
          leverage: int(o.leverage, `${p}.leverage`, 255),
          nonce_ms: uintStr(o.nonce_ms, `${p}.nonce_ms`),
        },
      };
    }
    case "EvmTransfer": {
      const o = obj(body, p);
      return {
        EvmTransfer: {
          token: str(o.token, `${p}.token`),
          to: str(o.to, `${p}.to`),
          amount: uintStr(o.amount, `${p}.amount`),
          nonce: uintStr(o.nonce, `${p}.nonce`),
          gas_limit: uintStr(o.gas_limit, `${p}.gas_limit`),
          max_fee_per_gas: uintStr(o.max_fee_per_gas, `${p}.max_fee_per_gas`),
          max_priority_fee_per_gas: uintStr(o.max_priority_fee_per_gas, `${p}.max_priority_fee_per_gas`),
        },
      };
    }
    default:
      throw new ParseError(path, "HlOrder | HlUpdateLeverage | EvmTransfer");
  }
}

export function parseProposal(x: unknown, path = "proposal"): Proposal {
  const o = obj(x, path);
  return {
    target: target(o.target, `${path}.target`),
    order: parseOrderRequest(o.order, `${path}.order`),
    memo: nullable(o.memo, `${path}.memo`, str),
  };
}

export function parseReceipt(x: unknown, path = "receipt"): Receipt {
  const o = obj(x, path);
  const status = str(o.status, `${path}.status`);
  if (!(RECEIPT_STATUSES as readonly string[]).includes(status)) {
    throw new ParseError(`${path}.status`, RECEIPT_STATUSES.join(" | "));
  }
  return {
    id: uintStr(o.id, `${path}.id`),
    agent_id: str(o.agent_id, `${path}.agent_id`),
    target: target(o.target, `${path}.target`),
    proposal: parseProposal(o.proposal, `${path}.proposal`),
    status: status as ReceiptStatus,
    rule_code: nullable(o.rule_code, `${path}.rule_code`, str),
    message: str(o.message, `${path}.message`),
    payload_hash: nullable(o.payload_hash, `${path}.payload_hash`, hex32),
    signed_body: nullable(o.signed_body, `${path}.signed_body`, str),
    derivation_path: nullable(o.derivation_path, `${path}.derivation_path`, str),
    signature: nullable(o.signature, `${path}.signature`, parseSig),
    rules_version: int(o.rules_version, `${path}.rules_version`),
    block_height: uintStr(o.block_height, `${path}.block_height`),
    timestamp_ns: uintStr(o.timestamp_ns, `${path}.timestamp_ns`),
  };
}

export function parseDecision(x: unknown, path = "decision"): Decision {
  const o = obj(x, path);
  return {
    allowed: bool(o.allowed, `${path}.allowed`),
    receipt_id: uintStr(o.receipt_id, `${path}.receipt_id`),
    rule_code: nullable(o.rule_code, `${path}.rule_code`, str),
    message: str(o.message, `${path}.message`),
    signature: nullable(o.signature, `${path}.signature`, parseSig),
  };
}

export function parseGuardStatus(x: unknown, path = "status"): GuardStatus {
  const o = obj(x, path);
  return {
    owner: str(o.owner, `${path}.owner`),
    guardian: nullable(o.guardian, `${path}.guardian`, str),
    paused: bool(o.paused, `${path}.paused`),
    pause_reason: nullable(o.pause_reason, `${path}.pause_reason`, str),
    mpc_contract_id: str(o.mpc_contract_id, `${path}.mpc_contract_id`),
    agents_count: count(o.agents_count, `${path}.agents_count`),
    receipts_count: count(o.receipts_count, `${path}.receipts_count`),
  };
}

export function parseRules(x: unknown, path = "rules"): Rules {
  const o = obj(x, path);
  return {
    targets: arr(o.targets, `${path}.targets`).map((t, i) => target(t, `${path}.targets[${i}]`)),
    markets: arr(o.markets, `${path}.markets`).map((m, i) => {
      const p = `${path}.markets[${i}]`;
      const mo = obj(m, p);
      return {
        name: str(mo.name, `${p}.name`),
        asset: int(mo.asset, `${p}.asset`, 0xffff_ffff),
        max_order_sz: str(mo.max_order_sz, `${p}.max_order_sz`),
        sz_decimals: int(mo.sz_decimals, `${p}.sz_decimals`, 6),
      };
    }),
    max_order_notional: uintStr(o.max_order_notional, `${path}.max_order_notional`),
    max_leverage: int(o.max_leverage, `${path}.max_leverage`, 255),
    tokens: arr(o.tokens, `${path}.tokens`).map((t, i) => {
      const p = `${path}.tokens[${i}]`;
      const to = obj(t, p);
      return {
        symbol: str(to.symbol, `${p}.symbol`),
        address: str(to.address, `${p}.address`),
        decimals: int(to.decimals, `${p}.decimals`, 255),
        max_per_order: uintStr(to.max_per_order, `${p}.max_per_order`),
      };
    }),
    receivers: arr(o.receivers, `${path}.receivers`).map((r, i) => str(r, `${path}.receivers[${i}]`)),
    daily_cap: uintStr(o.daily_cap, `${path}.daily_cap`),
    max_orders_per_day: int(o.max_orders_per_day, `${path}.max_orders_per_day`, 0xffff_ffff),
    expires_at_ns: uintStr(o.expires_at_ns, `${path}.expires_at_ns`),
    reduce_only_required: bool(o.reduce_only_required, `${path}.reduce_only_required`),
  };
}

export function parseAgentState(x: unknown, path = "agent_state"): AgentState {
  const o = obj(x, path);
  let pending: [Rules, string] | null = null;
  if (o.pending !== null && o.pending !== undefined) {
    const pair = arr(o.pending, `${path}.pending`);
    if (pair.length !== 2) throw new ParseError(`${path}.pending`, "[rules, eta_ns]");
    pending = [parseRules(pair[0], `${path}.pending[0]`), uintStr(pair[1], `${path}.pending[1]`)];
  }
  return {
    rules: parseRules(o.rules, `${path}.rules`),
    rules_version: int(o.rules_version, `${path}.rules_version`),
    pending,
    day: count(o.day, `${path}.day`),
    spent_today: uintStr(o.spent_today, `${path}.spent_today`),
    orders_today: int(o.orders_today, `${path}.orders_today`),
    last_hl_nonce_ms: nullable(o.last_hl_nonce_ms, `${path}.last_hl_nonce_ms`, uintStr),
    last_evm_nonce: nullable(o.last_evm_nonce, `${path}.last_evm_nonce`, uintStr),
  };
}

export function parsePreviewResult(x: unknown, path = "preview"): PreviewResult {
  const [key, value] = tagged(x, path);
  if (key === "Ok") return { Ok: hex32(value, `${path}.Ok`) };
  if (key === "Err") return { Err: str(value, `${path}.Err`) };
  throw new ParseError(path, "{Ok} | {Err}");
}

export function parsePaths(x: unknown, path = "paths"): Array<[Target, string]> {
  return arr(x, path).map((entry, i) => {
    const pair = arr(entry, `${path}[${i}]`);
    if (pair.length !== 2) throw new ParseError(`${path}[${i}]`, "[target, path]");
    return [target(pair[0], `${path}[${i}][0]`), str(pair[1], `${path}[${i}][1]`)];
  });
}

/** Parse one `EVENT_JSON:` log line. Returns undefined for any other or malformed line. */
export function parseEventLog(line: string): ClawGuardEvent | undefined {
  const PREFIX = "EVENT_JSON:";
  if (!line.startsWith(PREFIX)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Obj;
  if (typeof e.standard !== "string" || typeof e.version !== "string" || typeof e.event !== "string") return undefined;
  const data = Array.isArray(e.data) ? e.data : e.data === undefined ? [] : [e.data];
  if (!data.every((d) => typeof d === "object" && d !== null && !Array.isArray(d))) return undefined;
  return { standard: e.standard, version: e.version, event: e.event, data: data as Obj[] };
}
