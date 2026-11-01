// Plain-English "what is being signed" lines for a receipt (idea from our own PoC hl.py).
//
// When the receipt has a signed body, the description is decoded from that body
// (the exact bytes the MPC signs), not from the agent's proposal; any field where
// the two differ is listed. Decoding is strict: a body with any key, value or shape
// the contract does not build is "could not be decoded", never described. The market
// or token name comes from the owner's rules (asset index or token address in the
// body), not from the agent; without them the body's asset index or token address is
// shown. Blocked receipts have no signed body and are described from the proposal.
// Agent-supplied text is shown with control, line-break and bidi characters escaped.
// Output is descriptive only: no verdict words, no currency symbols; token amounts are
// shown in raw token units.
import { type Hex, decodeFunctionData, encodeFunctionData, parseAbi, parseTransaction, serializeTransaction } from "viem";
import { BASE_SEPOLIA_CHAIN_ID } from "./config.js";
import type { EvmTransfer, HlOrder, HlUpdateLeverage, MarketRule, Receipt, ReceiptStatus, TokenRule } from "./types.js";

const ERC20_TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** The owner's names for what a signed body refers to (from get_rules): asset index -> market, token address -> symbol. */
export interface RuleNames {
  markets: ReadonlyArray<Pick<MarketRule, "name" | "asset">>;
  tokens: ReadonlyArray<Pick<TokenRule, "symbol" | "address">>;
}

// C0/C1 controls, line/paragraph separators and bidi marks/overrides (the same set Claw Watch
// strips in watch/alerts.ts). Agent- or model-supplied text is printed to the owner's terminal,
// so these are shown as \uXXXX escapes: a value can never move the cursor, clear the screen,
// fake an extra row or reorder text.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `value` with every control, line-break and bidi character replaced by a visible `\uXXXX` escape. */
export function escapeUnprintable(value: string): string {
  return value.replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const STATUS_PREFIX: Record<ReceiptStatus, string> = {
  Signed: "",
  PendingSignature: "Waiting for signature: ",
  SignFailed: "Signature request failed for: ",
  Blocked: "Proposed, not signed: ",
};

// ---------------------------------------------------------------------------
// Sentences (shared by the proposal and the decoded-body paths)
// ---------------------------------------------------------------------------

export function hlOrderSentence(o: {
  market: string;
  isBuy: boolean;
  sz: string;
  limitPx: string;
  tif: string;
  reduceOnly: boolean;
}): string {
  const [sz, market, limitPx, tif] = [o.sz, o.market, o.limitPx, o.tif].map(escapeUnprintable);
  return (
    `${o.isBuy ? "Buy" : "Sell"} ${sz} ${market} at limit ${limitPx} (${tif}), ` +
    `${o.reduceOnly ? "reduce-only" : "not reduce-only"}, on Hyperliquid testnet`
  );
}

export function hlLeverageSentence(o: { market: string; leverage: number; isCross: boolean }): string {
  return `Set ${escapeUnprintable(o.market)} leverage to ${o.leverage}x (${o.isCross ? "cross" : "isolated"} margin) on Hyperliquid testnet`;
}

export function evmTransferSentence(o: { token: string; to: string; amount: string }): string {
  return `Transfer ${escapeUnprintable(o.amount)} raw units of ${escapeUnprintable(o.token)} to ${escapeUnprintable(o.to.toLowerCase())} on Base Sepolia`;
}

function proposalSentence(receipt: Receipt): string {
  const order = receipt.proposal.order;
  if ("HlOrder" in order) {
    const o = order.HlOrder;
    return hlOrderSentence({ market: o.market, isBuy: o.is_buy, sz: o.sz, limitPx: o.limit_px, tif: o.tif, reduceOnly: o.reduce_only });
  }
  if ("HlUpdateLeverage" in order) {
    const o = order.HlUpdateLeverage;
    return hlLeverageSentence({ market: o.market, leverage: o.leverage, isCross: o.is_cross });
  }
  const o = order.EvmTransfer;
  return evmTransferSentence({ token: o.token, to: o.to, amount: o.amount });
}

// ---------------------------------------------------------------------------
// Signed-body decoders
// ---------------------------------------------------------------------------

interface Decoded {
  sentence: string;
  detail: string;
  differs: string[];
}

type Json = Record<string, unknown>;

function isObj(x: unknown): x is Json {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function diff(pairs: Array<[field: string, signed: unknown, proposed: unknown]>): string[] {
  return pairs.filter(([, signed, proposed]) => signed !== proposed).map(([field]) => field);
}

/** True if `x` has exactly these keys, in this order (the contract's fixed templates). */
function hasKeys(x: Json, keys: readonly string[]): boolean {
  const own = Object.keys(x);
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
}

const isIndex = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

/**
 * Market label for a signed asset index: the owner's market name when the rules list that index,
 * else "asset N". `market` is listed as differing when the owner's name is not what the agent
 * proposed.
 */
function marketLabel(asset: number, proposed: string, names: RuleNames | undefined): { label: string; differs: boolean } {
  const owned = names?.markets.find((m) => m.asset === asset)?.name;
  return owned === undefined ? { label: `asset ${asset}`, differs: false } : { label: owned, differs: owned !== proposed };
}

// {"type":"order","orders":[{"a","b","p","s","r","t":{"limit":{"tif"}}}],"grouping":"na"}
function decodeHlOrderBody(action: Json, proposal: HlOrder, path: string, names: RuleNames | undefined): Decoded | undefined {
  const orders = action.orders;
  if (!hasKeys(action, ["type", "orders", "grouping"]) || action.type !== "order" || action.grouping !== "na") return undefined;
  if (!Array.isArray(orders) || orders.length !== 1 || !isObj(orders[0])) return undefined;
  const w = orders[0];
  if (!hasKeys(w, ["a", "b", "p", "s", "r", "t"]) || !isObj(w.t) || !hasKeys(w.t, ["limit"])) return undefined;
  const limit = w.t.limit;
  if (!isObj(limit) || !hasKeys(limit, ["tif"])) return undefined;
  const tif = limit.tif;
  if (!isIndex(w.a) || typeof w.b !== "boolean" || typeof w.p !== "string" || typeof w.s !== "string") return undefined;
  if (typeof w.r !== "boolean" || typeof tif !== "string") return undefined;
  const market = marketLabel(w.a, proposal.market, names);
  return {
    sentence: hlOrderSentence({ market: market.label, isBuy: w.b, sz: w.s, limitPx: w.p, tif, reduceOnly: w.r }),
    detail: `Hyperliquid testnet asset ${w.a}, nonce ${proposal.nonce_ms}, derivation path ${path}`,
    differs: [
      ...(market.differs ? ["market"] : []),
      ...diff([
        ["is_buy", w.b, proposal.is_buy],
        ["limit_px", w.p, proposal.limit_px],
        ["sz", w.s, proposal.sz],
        ["reduce_only", w.r, proposal.reduce_only],
        ["tif", tif, proposal.tif],
      ]),
    ],
  };
}

// {"type":"updateLeverage","asset","isCross","leverage"}
function decodeHlLeverageBody(action: Json, proposal: HlUpdateLeverage, path: string, names: RuleNames | undefined): Decoded | undefined {
  if (!hasKeys(action, ["type", "asset", "isCross", "leverage"]) || action.type !== "updateLeverage") return undefined;
  if (!isIndex(action.asset) || typeof action.isCross !== "boolean" || !isIndex(action.leverage)) return undefined;
  const market = marketLabel(action.asset, proposal.market, names);
  return {
    sentence: hlLeverageSentence({ market: market.label, leverage: action.leverage, isCross: action.isCross }),
    detail: `Hyperliquid testnet asset ${action.asset}, nonce ${proposal.nonce_ms}, derivation path ${path}`,
    differs: [
      ...(market.differs ? ["market"] : []),
      ...diff([
        ["is_cross", action.isCross, proposal.is_cross],
        ["leverage", action.leverage, proposal.leverage],
      ]),
    ],
  };
}

// Unsigned EIP-1559, chain 84532, value 0, empty access list, data = transfer(to, amount) exactly,
// canonical encoding (re-serializing the parsed fields gives the same bytes).
function decodeEvmBody(body: string, proposal: EvmTransfer, path: string, names: RuleNames | undefined): Decoded | undefined {
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(body)) return undefined;
  const tx = parseTransaction(body as Hex);
  if (tx.type !== "eip1559" || tx.chainId !== BASE_SEPOLIA_CHAIN_ID || tx.to === undefined || tx.to === null || tx.data === undefined) {
    return undefined;
  }
  if ((tx.value ?? 0n) !== 0n || (tx.accessList ?? []).length !== 0 || tx.r !== undefined || tx.s !== undefined) return undefined;
  if (serializeTransaction(tx) !== body.toLowerCase()) return undefined;
  const call = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: tx.data });
  const [to, amount] = call.args;
  if (encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to, amount] }) !== tx.data.toLowerCase()) return undefined;
  const tokenAddress = tx.to.toLowerCase();
  const owned = names?.tokens.find((t) => t.address.toLowerCase() === tokenAddress)?.symbol;
  return {
    sentence: evmTransferSentence({ token: owned ?? `token ${tokenAddress}`, to, amount: amount.toString() }),
    detail:
      `Token contract ${tokenAddress}, chain ${tx.chainId}, nonce ${tx.nonce ?? 0}, gas limit ${tx.gas ?? 0n}, ` +
      `max fee per gas ${tx.maxFeePerGas ?? 0n} wei, max priority fee per gas ${tx.maxPriorityFeePerGas ?? 0n} wei, ` +
      `derivation path ${path}`,
    differs: [
      ...(owned !== undefined && owned !== proposal.token ? ["token"] : []),
      ...diff([
        ["to", to.toLowerCase(), proposal.to.toLowerCase()],
        ["amount", amount.toString(), proposal.amount],
        ["nonce", String(tx.nonce ?? 0), proposal.nonce],
        ["gas_limit", String(tx.gas ?? 0n), proposal.gas_limit],
        ["max_fee_per_gas", String(tx.maxFeePerGas ?? 0n), proposal.max_fee_per_gas],
        ["max_priority_fee_per_gas", String(tx.maxPriorityFeePerGas ?? 0n), proposal.max_priority_fee_per_gas],
      ]),
    ],
  };
}

function decodeSignedBody(receipt: Receipt, body: string, names: RuleNames | undefined): Decoded | undefined {
  const order = receipt.proposal.order;
  const path = receipt.derivation_path ?? "(none)";
  try {
    if (receipt.target === "HlTestnet") {
      const action: unknown = JSON.parse(body);
      if (!isObj(action)) return undefined;
      if ("HlOrder" in order) return decodeHlOrderBody(action, order.HlOrder, path, names);
      if ("HlUpdateLeverage" in order) return decodeHlLeverageBody(action, order.HlUpdateLeverage, path, names);
      return undefined;
    }
    if ("EvmTransfer" in order) return decodeEvmBody(body, order.EvmTransfer, path, names);
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * One to three lines describing what a receipt signs (or would have signed):
 * the action sentence, a technical detail line (signed bodies only), and a
 * note listing fields where the signed body and the proposal differ.
 * `names` (the owner's rules for the receipt's agent) turns the signed asset index
 * or token address into the owner's market or token name.
 */
export function describeReceipt(receipt: Receipt, names?: RuleNames): string[] {
  const prefix = STATUS_PREFIX[receipt.status];
  if (receipt.signed_body === null) return [`${prefix}${proposalSentence(receipt)}`];
  const decoded = decodeSignedBody(receipt, receipt.signed_body, names);
  if (decoded === undefined) return [`${prefix}(the signed body could not be decoded, so it is not described here)`];
  const lines = [`${prefix}${decoded.sentence}`, decoded.detail];
  if (decoded.differs.length > 0) lines.push(`Signed body differs from the proposal in: ${decoded.differs.join(", ")}`);
  return lines;
}
