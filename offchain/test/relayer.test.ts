// Keyless relayer: request bodies (snapshots) for Hyperliquid testnet and Base Sepolia,
// with a mocked fetch. Nothing here touches the network.
import type { Mock } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { MainnetRefusedError } from "../src/config.js";
import {
  RelayRefusedError,
  buildBaseRawTx,
  buildHlExchangeBody,
  relayReceipt,
  submitBaseRawTx,
  submitHlExchange,
} from "../src/relayer/index.js";
import { evmReceipt, evmTransfers, first, hlLeverage, hlLeverageReceipt, hlOrderReceipt, hlOrders } from "./helpers.js";

type FetchMock = Mock<(input: string, init?: RequestInit) => Promise<Response>>;

/** fetch mock answering each call with the next JSON body. */
function fetchSequence(...bodies: unknown[]): FetchMock {
  const queue = [...bodies];
  return vi.fn((_input: string, _init?: RequestInit) => {
    const body = queue.shift();
    if (body === undefined) return Promise.reject(new Error("unexpected extra fetch"));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

const sentJson = (mock: FetchMock, call = 0): unknown => JSON.parse(mock.mock.calls[call]?.[1]?.body as string);

const config = { hlApiUrl: "https://api.hyperliquid-testnet.xyz", baseSepoliaRpcUrl: "https://sepolia.base.org" };

describe("Hyperliquid testnet", () => {
  const order = hlOrderReceipt(first(hlOrders()));

  it("builds the /exchange body from a Signed receipt", () => {
    expect(buildHlExchangeBody(order)).toMatchInlineSnapshot(`
      {
        "action": {
          "grouping": "na",
          "orders": [
            {
              "a": 3,
              "b": true,
              "p": "1000",
              "r": false,
              "s": "0.001",
              "t": {
                "limit": {
                  "tif": "Gtc",
                },
              },
            },
          ],
          "type": "order",
        },
        "expiresAfter": null,
        "nonce": 1793318400000,
        "signature": {
          "r": "0x9db86c1758bcc9235d0a38bac92817585d959fd8a5f867bd8d1da89ffe5a8d61",
          "s": "0x2f466ddbac66b5f18ba942c53f493f845287493bb7e1e29928c7c854d2284938",
          "v": 28,
        },
        "vaultAddress": null,
      }
    `);
  });

  it("POSTs exactly that body to the testnet /exchange endpoint, keeping the signed key order", async () => {
    const fetchImpl = fetchSequence({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 7 } }] } } });
    const body = buildHlExchangeBody(order);
    const res = await submitHlExchange(body, { apiUrl: config.hlApiUrl, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.body).toBe(
      `{"action":${order.signed_body ?? ""},"nonce":1793318400000,"signature":{"r":"${order.signature?.r ?? ""}",` +
        `"s":"${order.signature?.s ?? ""}","v":28},"vaultAddress":null,"expiresAfter":null}`,
    );
    expect(res).toEqual({ httpStatus: 200, response: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 7 } }] } } } });
  });

  it("updateLeverage body", () => {
    const body = buildHlExchangeBody(hlLeverageReceipt(first(hlLeverage())));
    expect(body.action).toEqual({ type: "updateLeverage", asset: 3, isCross: true, leverage: 3 });
    expect(body.nonce).toBe(1793318400100);
  });

  it("keeps a non-JSON venue answer as text", async () => {
    const fetchImpl: FetchMock = vi.fn(() => Promise.resolve(new Response("Bad Gateway", { status: 502 })));
    await expect(submitHlExchange(buildHlExchangeBody(order), { apiUrl: config.hlApiUrl, fetchImpl })).resolves.toEqual({
      httpStatus: 502,
      response: "Bad Gateway",
    });
  });

  it("refuses the mainnet API without calling fetch", async () => {
    const fetchImpl = fetchSequence({});
    await expect(
      submitHlExchange(buildHlExchangeBody(order), { apiUrl: "https://api.hyperliquid.xyz", fetchImpl }),
    ).rejects.toThrow(MainnetRefusedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["not Signed", { status: "Blocked" as const }],
    ["no signature", { signature: null }],
    ["body changed after signing", { signed_body: (order.signed_body ?? "").replace('"s":"0.001"', '"s":"0.01"') }],
    ["hash changed", { payload_hash: `0x${"00".repeat(32)}` }],
    ["EIP-1559 v on an HL receipt", { signature: { ...order.signature!, v: 1 } }],
    ["wrong target", { target: "BaseSepolia" as const }],
  ])("fails closed: %s", (_name, patch) => {
    expect(() => buildHlExchangeBody({ ...order, ...patch })).toThrow(RelayRefusedError);
  });

  it("fails closed on a nonce that does not fit a JSON number", () => {
    const big = hlOrders().find((v) => v.name === "big_nonce");
    if (big === undefined) throw new Error("vector missing");
    expect(() => buildHlExchangeBody(hlOrderReceipt(big))).toThrow(/nonce does not fit/);
  });
});

describe("Base Sepolia", () => {
  it.each(evmTransfers())("$name: unsigned tx + MPC signature = the vector's signed tx", (v) => {
    expect(buildBaseRawTx(evmReceipt(v))).toBe(v.signed_tx);
  });

  it("checks eth_chainId (0x14a34) first, then the signer's pending nonce, then eth_sendRawTransaction", async () => {
    const v = first(evmTransfers());
    const raw = buildBaseRawTx(evmReceipt(v));
    const txHash = `0x${"ab".repeat(32)}`;
    const fetchImpl = fetchSequence(
      { jsonrpc: "2.0", id: 1, result: "0x14a34" },
      { jsonrpc: "2.0", id: 2, result: "0x0" },
      { jsonrpc: "2.0", id: 3, result: txHash },
    );
    await expect(submitBaseRawTx(raw, { rpcUrl: config.baseSepoliaRpcUrl, fetchImpl })).resolves.toBe(txHash);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([config.baseSepoliaRpcUrl, config.baseSepoliaRpcUrl, config.baseSepoliaRpcUrl]);
    expect(sentJson(fetchImpl, 0)).toMatchInlineSnapshot(`
      {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "eth_chainId",
        "params": [],
      }
    `);
    expect(sentJson(fetchImpl, 1)).toEqual({
      id: 2,
      jsonrpc: "2.0",
      method: "eth_getTransactionCount",
      params: [v.signer, "pending"],
    });
    expect(sentJson(fetchImpl, 2)).toMatchInlineSnapshot(`
      {
        "id": 3,
        "jsonrpc": "2.0",
        "method": "eth_sendRawTransaction",
        "params": [
          "0x02f8b183014a3480830f4240843b9aca0082fde894036cbd53842c5426634e7929541ec2318f3dcf7e80b844a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f4240c001a0b2c40f302b07a143802d318c7ebbf7df707434e371ffcda89d7bd34decaf6b94a014716afde607d5a9369383040110a203f0cac0473a2ba75ddf31452636f88201",
        ],
      }
    `);
  });

  it("never broadcasts when the RPC reports another chain", async () => {
    const raw = buildBaseRawTx(evmReceipt(first(evmTransfers())));
    const fetchImpl = fetchSequence({ result: "0x2105" }, { result: `0x${"ab".repeat(32)}` });
    await expect(submitBaseRawTx(raw, { rpcUrl: config.baseSepoliaRpcUrl, fetchImpl })).rejects.toThrow(MainnetRefusedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Regression: a transaction whose nonce is not the signer's next nonce used to be broadcast
  // anyway; a future nonce is queued by the node (it returns a hash) but never mines.
  it.each([
    ["a nonce above the pending one (gap)", "usdc_small_nonce_7", "0x3", /has next nonce 3, this transaction has nonce 7/],
    ["a nonce that is already used", "usdc_small_nonce_7", "0x8", /nonce 7 of 0x[0-9a-f]{40} is already used \(its next nonce is 8\)/],
  ])("never broadcasts %s", async (_name, vector, pending, message) => {
    const v = evmTransfers().find((t) => t.name === vector);
    if (v === undefined) throw new Error("vector missing");
    const raw = buildBaseRawTx(evmReceipt(v));
    const fetchImpl = fetchSequence({ result: "0x14a34" }, { result: pending }, { result: `0x${"ab".repeat(32)}` });
    const sent = submitBaseRawTx(raw, { rpcUrl: config.baseSepoliaRpcUrl, fetchImpl });
    await expect(sent).rejects.toThrow(RelayRefusedError);
    await expect(sent).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((sentJson(fetchImpl, 1) as { params: unknown[] }).params).toEqual([v.signer, "pending"]);
  });

  it("never broadcasts when the pending nonce cannot be read", async () => {
    const raw = buildBaseRawTx(evmReceipt(first(evmTransfers())));
    const fetchImpl = fetchSequence({ result: "0x14a34" }, { error: { code: -32000, message: "down" } });
    await expect(submitBaseRawTx(raw, { rpcUrl: config.baseSepoliaRpcUrl, fetchImpl })).rejects.toThrow("eth_getTransactionCount returned no nonce");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces RPC errors", async () => {
    const raw = buildBaseRawTx(evmReceipt(first(evmTransfers())));
    const fetchImpl = fetchSequence({ result: "0x14a34" }, { result: "0x0" }, { error: { code: -32000, message: "insufficient funds" } });
    await expect(submitBaseRawTx(raw, { rpcUrl: config.baseSepoliaRpcUrl, fetchImpl })).rejects.toThrow(
      "eth_sendRawTransaction error: insufficient funds",
    );
  });

  const receipt = evmReceipt(first(evmTransfers()));
  it.each([
    ["not Signed", { status: "SignFailed" as const }],
    ["body changed after signing", { signed_body: `${receipt.signed_body ?? ""}00` }],
    ["HL-style v", { signature: { ...receipt.signature!, v: 27 } }],
    ["wrong target", { target: "HlTestnet" as const }],
  ])("fails closed: %s", (_name, patch) => {
    expect(() => buildBaseRawTx({ ...receipt, ...patch })).toThrow(RelayRefusedError);
  });
});

describe("relayReceipt", () => {
  it("routes by target and checks the expected signer before sending", async () => {
    const hl = first(hlOrders());
    const fetchImpl = fetchSequence({ status: "ok" });
    const res = await relayReceipt(hlOrderReceipt(hl), { config, fetchImpl, expectedSigner: hl.signer });
    expect(res).toMatchObject({ target: "HlTestnet", httpStatus: 200, response: { status: "ok" } });

    const evm = first(evmTransfers());
    const txHash = `0x${"cd".repeat(32)}`;
    const fetchBase = fetchSequence({ result: "0x14a34" }, { result: "0x0" }, { result: txHash });
    await expect(relayReceipt(evmReceipt(evm), { config, fetchImpl: fetchBase, expectedSigner: evm.signer })).resolves.toEqual({
      target: "BaseSepolia",
      rawTx: evm.signed_tx,
      txHash,
    });
  });

  it("refuses to send when the signature is not from the expected signer", async () => {
    const fetchImpl = fetchSequence({ status: "ok" });
    await expect(
      relayReceipt(hlOrderReceipt(first(hlOrders())), { config, fetchImpl, expectedSigner: `0x${"11".repeat(20)}` }),
    ).rejects.toThrow(RelayRefusedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
