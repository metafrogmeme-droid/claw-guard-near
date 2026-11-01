// Keyless relayer, Hyperliquid testnet path: turn a Signed receipt into the /exchange
// request body and POST it. It holds no keys; it only forwards what the contract signed.
import { type FetchLike, assertHlTestnetUrl } from "../config.js";
import { hlDigestOfSignedBody } from "../hl.js";
import { sigYParity } from "../sig.js";
import type { Receipt, Sig } from "../types.js";

/** POST /exchange body, same shape as the SDK's _post_action. */
export interface HlExchangeBody {
  action: unknown;
  nonce: number;
  signature: Sig;
  vaultAddress: null;
  expiresAfter: null;
}

export class RelayRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayRefusedError";
  }
}

function hlNonce(receipt: Receipt): bigint {
  const order = receipt.proposal.order;
  if ("HlOrder" in order) return BigInt(order.HlOrder.nonce_ms);
  if ("HlUpdateLeverage" in order) return BigInt(order.HlUpdateLeverage.nonce_ms);
  throw new RelayRefusedError(`receipt #${receipt.id}: not a Hyperliquid order`);
}

/**
 * Build the /exchange body. Refuses (fail closed) unless the receipt is a Signed
 * HlTestnet receipt whose payload_hash equals the digest of its own signed body.
 */
export function buildHlExchangeBody(receipt: Receipt): HlExchangeBody {
  if (receipt.target !== "HlTestnet") throw new RelayRefusedError(`receipt #${receipt.id} is not a Hyperliquid testnet receipt`);
  if (receipt.status !== "Signed") throw new RelayRefusedError(`receipt #${receipt.id} is ${receipt.status}, not Signed`);
  const { signed_body: body, signature, payload_hash: payloadHash } = receipt;
  if (body === null || signature === null || payloadHash === null) {
    throw new RelayRefusedError(`receipt #${receipt.id} is missing its signed body, hash or signature`);
  }
  if (signature.v !== 27 && signature.v !== 28) throw new RelayRefusedError(`receipt #${receipt.id}: Hyperliquid needs v 27/28`);
  sigYParity(signature);

  const nonce = hlNonce(receipt);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RelayRefusedError(`receipt #${receipt.id}: nonce does not fit a JSON number`);
  }
  if (hlDigestOfSignedBody(body, nonce) !== payloadHash.toLowerCase()) {
    throw new RelayRefusedError(`receipt #${receipt.id}: payload_hash does not match the signed body`);
  }
  return {
    action: JSON.parse(body) as unknown,
    nonce: Number(nonce),
    signature: { r: signature.r, s: signature.s, v: signature.v },
    vaultAddress: null,
    expiresAfter: null,
  };
}

export interface HlSubmitOptions {
  apiUrl: string;
  fetchImpl?: FetchLike;
}

export interface HlSubmitResult {
  httpStatus: number;
  response: unknown;
}

/** POST {apiUrl}/exchange. Only the Hyperliquid testnet URL is accepted. */
export async function submitHlExchange(body: HlExchangeBody, { apiUrl, fetchImpl = fetch }: HlSubmitOptions): Promise<HlSubmitResult> {
  const base = assertHlTestnetUrl(apiUrl);
  const res = await fetchImpl(`${base}/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let response: unknown = text;
  try {
    response = JSON.parse(text) as unknown;
  } catch {
    // Not JSON: keep the raw text so the operator sees exactly what came back.
  }
  return { httpStatus: res.status, response };
}
