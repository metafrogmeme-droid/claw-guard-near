// Keyless relayer entry point: route a Signed receipt to Hyperliquid testnet or Base Sepolia.
// Never run in the sandbox demo (no network); unit-tested with a mocked fetch.
import type { Hex } from "viem";
import type { Config, FetchLike } from "../config.js";
import { verifySignature } from "../sig.js";
import type { Receipt } from "../types.js";
import { buildBaseRawTx, submitBaseRawTx } from "./base.js";
import { type HlExchangeBody, RelayRefusedError, buildHlExchangeBody, submitHlExchange } from "./hl.js";

export { RelayRefusedError, buildHlExchangeBody, submitHlExchange, type HlExchangeBody } from "./hl.js";
export { buildBaseRawTx, submitBaseRawTx } from "./base.js";

export type RelayResult =
  | { target: "HlTestnet"; request: HlExchangeBody; httpStatus: number; response: unknown }
  | { target: "BaseSepolia"; rawTx: Hex; txHash: Hex };

export interface RelayDeps {
  config: Pick<Config, "hlApiUrl" | "baseSepoliaRpcUrl">;
  fetchImpl?: FetchLike;
  /** If given, the signature must recover to this address before anything is sent. */
  expectedSigner?: string;
}

export async function relayReceipt(receipt: Receipt, { config, fetchImpl = fetch, expectedSigner }: RelayDeps): Promise<RelayResult> {
  if (expectedSigner !== undefined) {
    if (receipt.payload_hash === null || receipt.signature === null) {
      throw new RelayRefusedError(`receipt #${receipt.id} has no signature`);
    }
    const check = await verifySignature(receipt.payload_hash, receipt.signature, expectedSigner);
    if (!check.match) throw new RelayRefusedError(`receipt #${receipt.id}: ${check.line}`);
  }
  switch (receipt.target) {
    case "HlTestnet": {
      const request = buildHlExchangeBody(receipt);
      const { httpStatus, response } = await submitHlExchange(request, { apiUrl: config.hlApiUrl, fetchImpl });
      return { target: "HlTestnet", request, httpStatus, response };
    }
    case "BaseSepolia": {
      const rawTx = buildBaseRawTx(receipt);
      const txHash = await submitBaseRawTx(rawTx, { rpcUrl: config.baseSepoliaRpcUrl, fetchImpl });
      return { target: "BaseSepolia", rawTx, txHash };
    }
  }
}
