// Keyless relayer, Base Sepolia path: attach the MPC signature to the contract-built
// unsigned EIP-1559 transaction and broadcast it. eth_chainId must be 0x14a34 first, and the
// transaction's nonce must be the signer's next (pending) nonce.
import { type Hex, type TransactionSerialized, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction } from "viem";
import { BASE_SEPOLIA_CHAIN_ID, type FetchLike, assertBaseSepoliaChainId, assertNoMainnetUrl } from "../config.js";
import { sigYParity } from "../sig.js";
import type { Receipt } from "../types.js";
import { RelayRefusedError } from "./hl.js";

/**
 * Raw signed transaction for a Signed BaseSepolia receipt. Refuses unless the
 * unsigned tx hashes to payload_hash, is EIP-1559 and targets chain 84532.
 */
export function buildBaseRawTx(receipt: Receipt): Hex {
  if (receipt.target !== "BaseSepolia") throw new RelayRefusedError(`receipt #${receipt.id} is not a Base Sepolia receipt`);
  if (receipt.status !== "Signed") throw new RelayRefusedError(`receipt #${receipt.id} is ${receipt.status}, not Signed`);
  const { signed_body: body, signature, payload_hash: payloadHash } = receipt;
  if (body === null || signature === null || payloadHash === null) {
    throw new RelayRefusedError(`receipt #${receipt.id} is missing its signed body, hash or signature`);
  }
  if (!/^0x02(?:[0-9a-fA-F]{2})+$/.test(body)) throw new RelayRefusedError(`receipt #${receipt.id}: signed body is not an EIP-1559 tx`);
  if (keccak256(body as Hex) !== payloadHash.toLowerCase()) {
    throw new RelayRefusedError(`receipt #${receipt.id}: payload_hash does not match the signed body`);
  }
  if (signature.v !== 0 && signature.v !== 1) throw new RelayRefusedError(`receipt #${receipt.id}: EIP-1559 needs y-parity 0/1`);

  const tx = parseTransaction(body as Hex);
  if (tx.type !== "eip1559" || tx.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new RelayRefusedError(`receipt #${receipt.id}: transaction is not EIP-1559 on chain ${BASE_SEPOLIA_CHAIN_ID}`);
  }
  return serializeTransaction(tx, { r: signature.r as Hex, s: signature.s as Hex, yParity: sigYParity(signature) });
}

export interface BaseSubmitOptions {
  rpcUrl: string;
  fetchImpl?: FetchLike;
}

/**
 * Refuses unless the transaction's nonce is the signer's pending nonce. A lower nonce is already
 * used; a higher one would only wait in the node's queue (the RPC still returns a hash) until the
 * gap is filled, and the guard never signs a nonce at or below one it already signed.
 */
async function assertNextNonce(rawTx: Hex, rpcUrl: string, fetchImpl: FetchLike): Promise<void> {
  const nonce = BigInt(parseTransaction(rawTx).nonce ?? 0);
  const from = (await recoverTransactionAddress({ serializedTransaction: rawTx as TransactionSerialized })).toLowerCase();
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [from, "pending"] }),
  });
  if (!res.ok) throw new Error(`eth_getTransactionCount failed with HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) {
    throw new Error("eth_getTransactionCount returned no nonce");
  }
  const pending = BigInt(body.result);
  if (nonce < pending) {
    throw new RelayRefusedError(`nonce ${nonce} of ${from} is already used (its next nonce is ${pending})`);
  }
  if (nonce > pending) {
    throw new RelayRefusedError(
      `${from} has next nonce ${pending}, this transaction has nonce ${nonce}: ` +
        "it would wait in the queue until the nonces in between are used, so it is not sent",
    );
  }
}

/** eth_chainId guard, pending-nonce check, then eth_sendRawTransaction. Returns the transaction hash. */
export async function submitBaseRawTx(rawTx: Hex, { rpcUrl, fetchImpl = fetch }: BaseSubmitOptions): Promise<Hex> {
  assertNoMainnetUrl(rpcUrl, "BASE_SEPOLIA_RPC_URL");
  await assertBaseSepoliaChainId(rpcUrl, fetchImpl);
  await assertNextNonce(rawTx, rpcUrl, fetchImpl);
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_sendRawTransaction", params: [rawTx] }),
  });
  if (!res.ok) throw new Error(`eth_sendRawTransaction failed with HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: unknown } };
  if (typeof body.result === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.result)) return body.result as Hex;
  const message = typeof body.error?.message === "string" ? body.error.message : "no transaction hash returned";
  throw new Error(`eth_sendRawTransaction error: ${message}`);
}
