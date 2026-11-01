// Test helper: serves the JSON fixtures in this folder as NEAR JSON-RPC and Hyperliquid
// testnet /info responses through a fetch stand-in. No network: anything not in a fixture is an
// RPC error, and every request is recorded for assertions.
import { readFileSync } from "node:fs";
import type { FetchLike } from "../../src/config.js";

const FIXTURE_DIR = new URL("./", import.meta.url);

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8")) as T;
}

/** A recorded `view_access_key_list` JSON-RPC response envelope. */
export interface RpcEnvelope {
  jsonrpc: "2.0";
  id: string;
  result: { block_hash: string; block_height: number; keys: unknown[] };
}

export interface AccessKeyFixture {
  meta: Record<string, string>;
  steps: Record<string, Record<string, RpcEnvelope>>;
}

export interface ViewsStep {
  get_status: Record<string, unknown>;
  receipts: Array<Record<string, unknown> & { id: string }>;
}

export interface ViewsFixture {
  meta: Record<string, string>;
  contract_id: string;
  steps: Record<string, ViewsStep>;
}

export interface HlStep {
  extraAgents: unknown;
  approvedBuilders: unknown;
}

export interface HlFixture {
  meta: Record<string, string>;
  user: string;
  steps: Record<string, HlStep>;
}

/** What the fake NEAR node currently answers. Mutate it between polls to move to the next step. */
export interface NearRpcState {
  keys?: Record<string, RpcEnvelope>;
  views?: ViewsStep;
  /** Contract whose views are served (default clawguard.test.near). */
  contractId?: string;
  chainId?: string;
  genesisHash?: string;
  /** `view_account` of the contract (Q-56 storage source); default: 100 NEAR, 300000 bytes used. */
  account?: { amount: string; storage_usage: number };
}

export interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
}

/** The JSON request body the code under test sent (always a string here). */
export function requestJson(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("expected a JSON string request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function rpcError(id: unknown, cause: string, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: cause, info: {} }, code: -32000, message, data: message } });
}

/** call_function result bytes, like nearcore returns them. */
function viewResult(id: unknown, value: unknown): Response {
  const bytes = [...Buffer.from(JSON.stringify(value), "utf8")];
  return json({ jsonrpc: "2.0", id, result: { result: bytes, logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } });
}

/** NEAR JSON-RPC stand-in: `status`, `query view_access_key_list`, `query view_account`, `query call_function get_status|get_receipts`. */
export function nearRpcFetch(state: NearRpcState, requests: RecordedRequest[] = []): FetchLike {
  return (input: string, init?: RequestInit): Promise<Response> => {
    const body = requestJson(init);
    requests.push({ url: String(input), body });
    const { id, method } = body;
    const params = (body.params ?? {}) as Record<string, unknown>;
    if (method === "status") {
      return Promise.resolve(
        json({ jsonrpc: "2.0", id, result: { chain_id: state.chainId ?? "sandbox", genesis_hash: state.genesisHash ?? "GenesisHash1111", version: {} } }),
      );
    }
    if (method === "query" && params.request_type === "view_access_key_list") {
      const recorded = state.keys?.[String(params.account_id)];
      if (recorded === undefined) return Promise.resolve(rpcError(id, "UNKNOWN_ACCOUNT", `account ${String(params.account_id)} does not exist`));
      return Promise.resolve(json({ ...recorded, id }));
    }
    if (method === "query" && params.request_type === "view_account") {
      if (params.account_id !== (state.contractId ?? "clawguard.test.near") || state.views === undefined) {
        return Promise.resolve(rpcError(id, "UNKNOWN_ACCOUNT", `account ${String(params.account_id)} does not exist`));
      }
      const account = state.account ?? { amount: (100n * 10n ** 24n).toString(), storage_usage: 300_000 };
      return Promise.resolve(
        json({
          jsonrpc: "2.0",
          id,
          result: { ...account, locked: "0", code_hash: "11111111111111111111111111111111", block_height: 1, block_hash: "11111111111111111111111111111111" },
        }),
      );
    }
    if (method === "query" && params.request_type === "call_function") {
      if (params.account_id !== (state.contractId ?? "clawguard.test.near") || state.views === undefined) {
        return Promise.resolve(rpcError(id, "NO_CONTRACT_CODE", "no contract"));
      }
      const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8") || "{}") as Record<string, unknown>;
      if (params.method_name === "get_status") return Promise.resolve(viewResult(id, state.views.get_status));
      if (params.method_name === "get_receipts") {
        const from = Number(args.from_id);
        const limit = Math.min(Number(args.limit), 50);
        return Promise.resolve(viewResult(id, state.views.receipts.filter((r) => Number(r.id) >= from).slice(0, limit)));
      }
      return Promise.resolve(rpcError(id, "METHOD_NOT_FOUND", `no view ${String(params.method_name)}`));
    }
    return Promise.resolve(rpcError(id, "UNSUPPORTED", `fixture has no answer for ${String(method)}`));
  };
}

/** Hyperliquid testnet /info stand-in serving `extraAgents` and `approvedBuilders` for one master account. */
export function hlInfoFetch(state: { user: string; step: HlStep }, requests: RecordedRequest[] = []): FetchLike {
  return (input: string, init?: RequestInit): Promise<Response> => {
    const body = requestJson(init);
    requests.push({ url: String(input), body });
    if (input !== "https://api.hyperliquid-testnet.xyz/info" || body.user !== state.user) return Promise.resolve(json({ error: "unexpected" }, 422));
    if (body.type === "extraAgents") return Promise.resolve(json(state.step.extraAgents));
    if (body.type === "approvedBuilders") return Promise.resolve(json(state.step.approvedBuilders));
    return Promise.resolve(json({ error: "unknown type" }, 422));
  };
}

/**
 * Route the global fetch (used inside near-api-js's JsonRpcProvider) to `impl` while `run`
 * executes, then put the previous one (the test setup's network blocker) back.
 */
export async function withGlobalFetch<T>(impl: FetchLike, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}
