// Shared test fixtures: vector loading and receipts built from the committed vectors.
import { readFileSync } from "node:fs";
import { type Hex, pad, parseTransaction } from "viem";
import type { RuleNames } from "../src/decode.js";
import type { Receipt } from "../src/types.js";

const VECTOR_DIR = new URL("./vectors/", import.meta.url);

/** JSON.parse that keeps `nonce_ms` exact (one vector uses u64::MAX). */
export function loadVectors<T = Record<string, unknown>>(file: string): { meta: Record<string, unknown>; vectors: T[] } {
  const reviver = (key: string, value: unknown, ctx?: { source?: string }): unknown =>
    key === "nonce_ms" && typeof value === "number" && ctx?.source !== undefined ? ctx.source : value;
  return JSON.parse(readFileSync(new URL(file, VECTOR_DIR), "utf8"), reviver) as {
    meta: Record<string, unknown>;
    vectors: T[];
  };
}

export interface HlOrderVector {
  name: string;
  request: { coin_asset: number; is_buy: boolean; limit_px: string; sz: string; reduce_only: boolean; tif: string };
  action_json: string;
  nonce_ms: string;
  connection_id: string;
  digest: string;
  signer: string;
  signature: { r: string; s: string; v: number };
}

export interface HlLeverageVector {
  name: string;
  request: { coin_asset: number; is_cross: boolean; leverage: number };
  action_json: string;
  nonce_ms: string;
  connection_id: string;
  digest: string;
  signer: string;
  signature: { r: string; s: string; v: number };
}

export interface EvmVector {
  name: string;
  request: {
    token: string;
    to: string;
    amount: string;
    nonce: string;
    gas_limit: string;
    max_fee_per_gas: string;
    max_priority_fee_per_gas: string;
  };
  unsigned_tx: string;
  payload_hash: string;
  signer: string;
  signed_tx: string;
}

/** The owner's names from demo/rules.json (BTC = asset 3, ETH = asset 4, USDC = Circle's Base Sepolia address). */
export const DEMO_NAMES: RuleNames = JSON.parse(readFileSync(new URL("../../demo/rules.json", import.meta.url), "utf8")) as RuleNames;

const MARKETS: Record<number, string> = { 3: "BTC", 4: "ETH" };
const marketName = (asset: number): string => MARKETS[asset] ?? `ASSET${asset}`;
const hex32 = (h: string): string => pad(h as Hex, { size: 32 }).toLowerCase();

const base = {
  agent_id: "agent-1.test.near",
  rules_version: 1,
  block_height: "120",
  timestamp_ns: "1793318400000000000",
} as const;

export function hlOrderReceipt(v: HlOrderVector, id = "1"): Receipt {
  return {
    ...base,
    id,
    target: "HlTestnet",
    proposal: {
      target: "HlTestnet",
      order: {
        HlOrder: {
          market: marketName(v.request.coin_asset),
          is_buy: v.request.is_buy,
          limit_px: v.request.limit_px,
          sz: v.request.sz,
          reduce_only: v.request.reduce_only,
          tif: v.request.tif,
          nonce_ms: v.nonce_ms,
        },
      },
      memo: null,
    },
    status: "Signed",
    rule_code: null,
    message: "Allowed: within your limits",
    payload_hash: v.digest,
    signed_body: v.action_json,
    derivation_path: "hl-testnet-1",
    signature: { r: hex32(v.signature.r), s: hex32(v.signature.s), v: v.signature.v },
  };
}

export function hlLeverageReceipt(v: HlLeverageVector, id = "2"): Receipt {
  return {
    ...base,
    id,
    target: "HlTestnet",
    proposal: {
      target: "HlTestnet",
      order: {
        HlUpdateLeverage: {
          market: marketName(v.request.coin_asset),
          is_cross: v.request.is_cross,
          leverage: v.request.leverage,
          nonce_ms: v.nonce_ms,
        },
      },
      memo: null,
    },
    status: "Signed",
    rule_code: null,
    message: "Allowed: within your limits",
    payload_hash: v.digest,
    signed_body: v.action_json,
    derivation_path: "hl-testnet-1",
    signature: { r: hex32(v.signature.r), s: hex32(v.signature.s), v: v.signature.v },
  };
}

/** The vector's own (r, s, y-parity), read back from its signed transaction. */
export function evmVectorSig(v: EvmVector): { r: string; s: string; v: number } {
  const tx = parseTransaction(v.signed_tx as Hex);
  if (tx.r === undefined || tx.s === undefined || tx.yParity === undefined) throw new Error("vector has no signature");
  return { r: hex32(tx.r), s: hex32(tx.s), v: tx.yParity };
}

export function evmReceipt(v: EvmVector, id = "3"): Receipt {
  return {
    ...base,
    id,
    target: "BaseSepolia",
    proposal: { target: "BaseSepolia", order: { EvmTransfer: { ...v.request } }, memo: null },
    status: "Signed",
    rule_code: null,
    message: "Allowed: within your limits",
    payload_hash: v.payload_hash,
    signed_body: v.unsigned_tx,
    derivation_path: "base-sepolia-1",
    signature: evmVectorSig(v),
  };
}

/** A Blocked receipt (no signed body, no signature) for any proposal. */
export function blockedReceipt(id: string, proposal: Receipt["proposal"], ruleCode: string, message: string): Receipt {
  return {
    ...base,
    id,
    target: proposal.target,
    proposal,
    status: "Blocked",
    rule_code: ruleCode,
    message,
    payload_hash: null,
    signed_body: null,
    derivation_path: null,
    signature: null,
  };
}

export const hlOrders = (): HlOrderVector[] => loadVectors<HlOrderVector>("hl_orders.json").vectors;
export const hlLeverage = (): HlLeverageVector[] => loadVectors<HlLeverageVector>("hl_update_leverage.json").vectors;
export const evmTransfers = (): EvmVector[] => loadVectors<EvmVector>("evm_transfers.json").vectors;

/** Words that must never appear in user-facing output. */
export const BANNED_COPY = /\b(safe|scam|malicious|secure|presale|staking|airdrop)\b|\$RCLAW|\$[0-9]|\bUSD\b|price target/i;

export function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("empty fixture list");
  return item;
}
