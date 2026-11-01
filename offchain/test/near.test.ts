// near-api-js wrappers and the ClawGuard client, with a fake provider and a fake
// signing account (no RPC, no network).
import { type Account, KeyPair, type Provider } from "near-api-js";
import { describe, expect, it, vi } from "vitest";
import { MainnetRefusedError } from "../src/config.js";
import {
  ClawGuardClient,
  PROPOSE_GAS_TGAS,
  TGAS,
  type TxOutcome,
  assertProviderNetwork,
  collectLogs,
  createProvider,
  createSubAccountWithFunctionCallKey,
  normalizeAccessKeyList,
  outcomeEvents,
  signerFromKey,
} from "../src/near.js";
import { hlOrderReceipt, hlOrders, first } from "./helpers.js";

const CONTRACT = "clawguard.test.near";
const event = (name: string, data: Record<string, unknown>) =>
  `EVENT_JSON:${JSON.stringify({ standard: "clawguard", version: "1.0.0", event: name, data: [data] })}`;

/** Minimal tx outcome: one tx outcome + receipts, with a base64 SuccessValue. */
function fakeOutcome(value: unknown, receipts: Array<{ executor: string; logs: string[] }>): TxOutcome {
  return {
    status: { SuccessValue: Buffer.from(JSON.stringify(value)).toString("base64") },
    transaction: { hash: "TxHash111" },
    transaction_outcome: { id: "t", outcome: { logs: [], executor_id: "agent-1.test.near" } },
    receipts_outcome: receipts.map((r, i) => ({ id: `r${i}`, outcome: { logs: r.logs, executor_id: r.executor } })),
  } as unknown as TxOutcome;
}

interface SentAction {
  enum: string;
  functionCall?: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
}

function fakeAccount(result: TxOutcome, accountId = "agent-1.test.near") {
  const signAndSendTransaction = vi.fn((_args: { receiverId: string; actions: SentAction[] }) => Promise.resolve(result));
  return { account: { accountId, signAndSendTransaction } as unknown as Account, signAndSendTransaction };
}

function fakeProvider(answers: Record<string, unknown>) {
  const callFunction = vi.fn(({ method }: { contractId: string; method: string; args: Record<string, unknown> }) =>
    Promise.resolve(answers[method]),
  );
  return { provider: { callFunction } as unknown as Provider, callFunction };
}

describe("provider and signer", () => {
  it("createProvider refuses mainnet URLs", () => {
    expect(() => createProvider("https://rpc.mainnet.near.org")).toThrow(MainnetRefusedError);
    expect(createProvider("http://127.0.0.1:3030")).toBeDefined();
  });

  it("assertProviderNetwork checks chain_id", async () => {
    const provider = (chainId: string) => ({ getNetworkId: () => Promise.resolve(chainId) }) as unknown as Provider;
    await expect(assertProviderNetwork(provider("testnet"), "testnet")).resolves.toBe("testnet");
    await expect(assertProviderNetwork(provider("mainnet"), "testnet")).rejects.toThrow(MainnetRefusedError);
  });

  it("signerFromKey accepts NEAR keys and never echoes a bad one", async () => {
    const kp = KeyPair.fromRandom("ed25519");
    await expect(signerFromKey(kp.toString()).getPublicKey()).resolves.toEqual(kp.getPublicKey());
    const bad = `0x${"ab".repeat(32)}`;
    expect(() => signerFromKey(bad)).toThrow(/must look like/);
    try {
      signerFromKey(bad);
    } catch (err) {
      expect(String(err)).not.toContain(bad);
    }
  });
});

describe("logs and events", () => {
  const outcome = fakeOutcome(null, [
    { executor: CONTRACT, logs: ["plain log", event("order_blocked", { receipt_id: "2" })] },
    // Another contract in the same transaction cannot forge claw-guard events.
    { executor: "mock-mpc.test.near", logs: [event("signature_ready", { receipt_id: "9" })] },
  ]);

  it("collects every log line in order", () => {
    expect(collectLogs(outcome)).toHaveLength(3);
  });

  it("keeps only events logged by the contract itself", () => {
    expect(outcomeEvents(outcome, { executorId: CONTRACT }).map((e) => e.event)).toEqual(["order_blocked"]);
    expect(outcomeEvents(outcome).map((e) => e.event)).toEqual(["order_blocked", "signature_ready"]);
  });
});

describe("access keys", () => {
  it("normalises view_access_key_list and keeps unknown kinds visible", () => {
    const keys = normalizeAccessKeyList([
      { public_key: "ed25519:B", access_key: { nonce: 5, permission: "FullAccess" } },
      {
        public_key: "ed25519:A",
        access_key: {
          nonce: 7,
          permission: { FunctionCall: { allowance: "1000000000000000000000000", receiver_id: CONTRACT, method_names: ["propose_order"] } },
        },
      },
      { public_key: "ed25519:C", access_key: { nonce: 0, permission: { FunctionCall: { allowance: null, receiver_id: CONTRACT, method_names: ["pause"] } } } },
      { public_key: "ed25519:D", access_key: { nonce: 0, permission: { GasKeyFullAccess: { balance: "0", num_nonces: 1 } } } },
    ]);
    expect(keys).toEqual([
      { publicKey: "ed25519:A", kind: "FunctionCall", nonce: "7", receiverId: CONTRACT, methodNames: ["propose_order"], allowance: "1000000000000000000000000" },
      { publicKey: "ed25519:B", kind: "FullAccess", nonce: "5" },
      { publicKey: "ed25519:C", kind: "FunctionCall", nonce: "0", receiverId: CONTRACT, methodNames: ["pause"], allowance: null },
      { publicKey: "ed25519:D", kind: "Other", nonce: "0", permission: { GasKeyFullAccess: { balance: "0", num_nonces: 1 } } },
    ]);
  });
});

describe("createSubAccountWithFunctionCallKey", () => {
  const pk = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  const spec = {
    newAccountId: "agent-1.owner.test.near",
    publicKey: pk,
    initialBalanceYocto: 5n * 10n ** 23n,
    contractId: CONTRACT,
    methodNames: ["propose_order"],
    allowanceYocto: 10n ** 24n,
  };

  it("sends CreateAccount + Transfer + AddKey(FunctionCall) in one transaction, no full-access key", async () => {
    const { account, signAndSendTransaction } = fakeAccount(fakeOutcome(null, []), "owner.test.near");
    await createSubAccountWithFunctionCallKey(account, spec);
    const call = signAndSendTransaction.mock.calls[0]?.[0] as unknown as { receiverId: string; actions: Array<Record<string, unknown>> };
    expect(call.receiverId).toBe("agent-1.owner.test.near");
    expect(call.actions.map((a) => a.enum)).toEqual(["createAccount", "transfer", "addKey"]);
    const addKey = call.actions[2]?.addKey as { accessKey: { permission: { enum: string; functionCall: Record<string, unknown> } } };
    expect(addKey.accessKey.permission.enum).toBe("functionCall");
    expect(addKey.accessKey.permission.functionCall).toEqual({ allowance: 10n ** 24n, receiverId: CONTRACT, methodNames: ["propose_order"] });
  });

  it("refuses an empty method list, a non-sub-account and a mainnet id", async () => {
    const { account } = fakeAccount(fakeOutcome(null, []), "owner.test.near");
    await expect(createSubAccountWithFunctionCallKey(account, { ...spec, methodNames: [] })).rejects.toThrow(/at least one method/);
    await expect(createSubAccountWithFunctionCallKey(account, { ...spec, newAccountId: "agent-1.other.test.near" })).rejects.toThrow(
      /not a sub-account/,
    );
    await expect(createSubAccountWithFunctionCallKey(account, { ...spec, newAccountId: "agent-1.owner.near" })).rejects.toThrow(
      MainnetRefusedError,
    );
  });
});

describe("ClawGuardClient", () => {
  const receipt = hlOrderReceipt(first(hlOrders()));

  it("views pass U64 ids as strings and parse the results", async () => {
    const { provider, callFunction } = fakeProvider({
      get_status: {
        owner: "owner.test.near",
        guardian: "guardian.test.near",
        paused: false,
        pause_reason: null,
        mpc_contract_id: "mock-mpc.test.near",
        agents_count: 1,
        receipts_count: 1,
      },
      get_receipt: receipt,
      get_receipts: [receipt],
      get_paths: [
        ["HlTestnet", "hl-testnet-1"],
        ["BaseSepolia", "base-sepolia-1"],
      ],
      get_rules: null,
    });
    const client = new ClawGuardClient(provider, CONTRACT);
    await expect(client.getStatus()).resolves.toMatchObject({ receipts_count: 1 });
    await expect(client.getReceipt(1)).resolves.toEqual(receipt);
    await expect(client.getReceipts(1n, 500)).resolves.toEqual([receipt]);
    await expect(client.getRules("agent-1.test.near")).resolves.toBeNull();
    await expect(client.getPaths()).resolves.toHaveLength(2);
    expect(callFunction.mock.calls.map((c) => [c[0].method, c[0].args])).toEqual([
      ["get_status", {}],
      ["get_receipt", { id: "1" }],
      ["get_receipts", { from_id: "1", limit: 50 }],
      ["get_rules", { agent_id: "agent-1.test.near" }],
      ["get_paths", {}],
    ]);
  });

  it("getLastReceipts pages from receipts_count - last + 1", async () => {
    const make = (id: number) => ({ ...receipt, id: String(id) });
    const callFunction = vi.fn(({ method, args }: { method: string; args: Record<string, unknown> }) => {
      if (method === "get_status") {
        return Promise.resolve({
          owner: "o.test.near",
          guardian: null,
          paused: false,
          pause_reason: null,
          mpc_contract_id: "m.test.near",
          agents_count: 1,
          receipts_count: 120,
        });
      }
      const from = Number(args.from_id);
      return Promise.resolve(Array.from({ length: Math.min(50, 121 - from) }, (_, i) => make(from + i)));
    });
    const client = new ClawGuardClient({ callFunction } as unknown as Provider, CONTRACT);
    const last = await client.getLastReceipts(60);
    expect(last.map((r) => r.id)).toEqual(Array.from({ length: 60 }, (_, i) => String(61 + i)));
    expect(callFunction.mock.calls.slice(1).map((c) => c[0].args.from_id)).toEqual(["61", "111"]);
  });

  it("proposeOrder: 300 Tgas, no deposit, parsed Decision and contract events", async () => {
    const decision = { allowed: true, receipt_id: "1", rule_code: null, message: "Allowed: within your limits", signature: receipt.signature };
    const outcome = fakeOutcome(decision, [{ executor: CONTRACT, logs: [event("signature_ready", { receipt_id: "1" })] }]);
    const { account, signAndSendTransaction } = fakeAccount(outcome);
    const res = await new ClawGuardClient({} as Provider, CONTRACT, account).proposeOrder(receipt.proposal);
    expect(res.value).toEqual(decision);
    expect(res.txHash).toBe("TxHash111");
    expect(res.events.map((e) => e.event)).toEqual(["signature_ready"]);
    const sent = signAndSendTransaction.mock.calls[0]?.[0];
    expect(sent?.receiverId).toBe(CONTRACT);
    const fc = sent?.actions[0]?.functionCall;
    expect(fc?.methodName).toBe("propose_order");
    expect(fc?.gas).toBe(PROPOSE_GAS_TGAS * TGAS);
    expect(fc?.deposit).toBe(0n);
    expect(JSON.parse(Buffer.from(fc?.args ?? []).toString())).toEqual({ proposal: receipt.proposal });
  });

  it("owner methods attach exactly 1 yoctoNEAR; pause and guardian cancel attach none", async () => {
    const { account, signAndSendTransaction } = fakeAccount(fakeOutcome(null, []), "owner.test.near");
    const client = new ClawGuardClient({} as Provider, CONTRACT).as(account);
    await client.unpause();
    await client.setSignConfig(1n, 100);
    await client.pause("watch: new full-access key");
    await client.cancelPendingRules("agent-1.test.near", { asGuardian: true });
    await client.cancelPendingRules("agent-1.test.near");
    const sent = signAndSendTransaction.mock.calls.map((c) => {
      const fc = c[0].actions[0]?.functionCall;
      return [fc?.methodName, fc?.deposit, JSON.parse(Buffer.from(fc?.args ?? []).toString()) as unknown];
    });
    expect(sent).toEqual([
      ["unpause", 1n, {}],
      ["set_sign_config", 1n, { sign_deposit_yocto: "1", sign_gas_tgas: 100 }],
      ["pause", 0n, { reason: "watch: new full-access key" }],
      ["cancel_pending_rules", 0n, { agent_id: "agent-1.test.near" }],
      ["cancel_pending_rules", 1n, { agent_id: "agent-1.test.near" }],
    ]);
  });

  it("getLastReceipts clamps to the 1000-receipt ring buffer and stops on ids that do not advance", async () => {
    const status = { owner: "o.test.near", guardian: null, paused: false, pause_reason: null, mpc_contract_id: "m.test.near", agents_count: 1 };
    const stuck = vi.fn(({ method }: { method: string; args: Record<string, unknown> }) =>
      Promise.resolve(method === "get_status" ? { ...status, receipts_count: 3000 } : [{ ...receipt, id: "5" }]),
    );
    const client = new ClawGuardClient({ callFunction: stuck } as unknown as Provider, CONTRACT);
    await expect(client.getLastReceipts(5000)).resolves.toEqual([]);
    expect(stuck.mock.calls[1]?.[0].args.from_id).toBe("2001");
    expect(stuck).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-testnet contract id", () => {
    expect(() => new ClawGuardClient({} as Provider, "clawguard.near")).toThrow(MainnetRefusedError);
  });

  it("calls without a signing account fail before anything is sent", async () => {
    await expect(new ClawGuardClient({} as Provider, CONTRACT).pause("x")).rejects.toThrow(/needs a signing account/);
  });
});
