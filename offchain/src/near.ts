// Thin wrappers over near-api-js 7.4.0 plus a typed client for the claw-guard contract.
//
// Everything here works against NEAR testnet or the local sandbox only: providers
// are created through createProvider(), which refuses mainnet-looking URLs, and
// assertProviderNetwork() checks the RPC's chain_id before anything is signed.
import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  PublicKey,
  actions,
  getTransactionLastResult,
  type Action,
  type KeyPairString,
  type Provider,
  type TxExecutionStatus,
} from "near-api-js";
import { type NearNetwork, type Secret, assertNearChainId, assertNoMainnetUrl, assertTestnetAccountId } from "./config.js";
import {
  type AgentState,
  type ClawGuardEvent,
  type Decision,
  type GuardStatus,
  type InitArgs,
  type PreviewResult,
  type Proposal,
  type Receipt,
  type Rules,
  type Target,
  parseAgentState,
  parseDecision,
  parseEventLog,
  parseGuardStatus,
  parsePaths,
  parsePreviewResult,
  parseReceipt,
  toU64,
} from "./types.js";

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
export const DEFAULT_GAS_TGAS = 30n;
/** propose_order may yield on the MPC sign call: give it the 300 Tgas maximum. */
export const PROPOSE_GAS_TGAS = 300n;
export const CLAWGUARD_EVENT_STANDARD = "clawguard";
/** get_receipts clamps `limit` to this. */
export const MAX_RECEIPTS_PAGE = 50;
/** The contract keeps the newest 1000 receipts (ring buffer); older ones exist only as events. */
export const MAX_RECEIPTS_HELD = 1000;

export type TxOutcome = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

// ---------------------------------------------------------------------------
// Provider, signer, account
// ---------------------------------------------------------------------------

export function createProvider(url: string): JsonRpcProvider {
  return new JsonRpcProvider({ url: assertNoMainnetUrl(url, "NEAR RPC URL") });
}

/** Refuse to continue unless the RPC's chain_id matches NEAR_NETWORK (ERR_MAINNET_REFUSED). */
export async function assertProviderNetwork(provider: Provider, network: NearNetwork): Promise<string> {
  return assertNearChainId(await provider.getNetworkId(), network);
}

/** Key-pair signer from an `ed25519:…` / `secp256k1:…` secret key. The key is never logged. */
export function signerFromKey(key: Secret | string): KeyPairSigner {
  const value = typeof key === "string" ? key : key.reveal();
  if (!/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(value)) {
    // Deliberately does not echo the value.
    throw new Error("NEAR private key must look like ed25519:<base58> or secp256k1:<base58>");
  }
  return KeyPairSigner.fromSecretKey(value as KeyPairString);
}

export function connectAccount(accountId: string, provider: Provider, signer?: KeyPairSigner): Account {
  return new Account(assertTestnetAccountId(accountId, "account id"), provider, signer);
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function tgas(n: bigint | number): bigint {
  return BigInt(n) * TGAS;
}

/** View call; returns the parsed JSON result (undefined for an empty result). */
export async function viewFunction(
  provider: Provider,
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return provider.callFunction({ contractId, method, args });
}

export interface CallOptions {
  gasTgas?: bigint | number;
  depositYocto?: bigint;
  waitUntil?: TxExecutionStatus;
}

export interface CallResult<T = unknown> {
  value: T;
  txHash: string;
  logs: string[];
  /** NEP-297 events logged by `contractId` itself (other executors are ignored). */
  events: ClawGuardEvent[];
  outcome: TxOutcome;
}

/**
 * Function call with explicit gas and deposit. Waits until every receipt has
 * executed (so a yielded MPC sign + callback is included) and throws on failure.
 */
export async function callFunction(
  account: Account,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
  { gasTgas = DEFAULT_GAS_TGAS, depositYocto = 0n, waitUntil = "EXECUTED_OPTIMISTIC" }: CallOptions = {},
): Promise<CallResult> {
  const outcome = await account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, tgas(gasTgas), depositYocto)],
    waitUntil,
  });
  return {
    value: getTransactionLastResult(outcome),
    txHash: outcome.transaction.hash,
    logs: collectLogs(outcome),
    events: outcomeEvents(outcome, { executorId: contractId }),
    outcome,
  };
}

export interface SubAccountWithFcKey {
  newAccountId: string;
  /** Public key of the function-call key (the only key the new account will have). */
  publicKey: string;
  initialBalanceYocto: bigint;
  contractId: string;
  methodNames: string[];
  /** Gas allowance in yoctoNEAR. Required: an unlimited allowance is never created by accident. */
  allowanceYocto: bigint;
}

/**
 * One batch transaction: CreateAccount + Transfer + AddKey(FunctionCall). The new
 * account never gets a full-access key, so it can only call `methodNames` on
 * `contractId` and can never attach a deposit, move NEAR or add keys.
 */
export async function createSubAccountWithFunctionCallKey(parent: Account, spec: SubAccountWithFcKey): Promise<TxOutcome> {
  assertTestnetAccountId(spec.newAccountId, "new account id");
  if (!spec.newAccountId.endsWith(`.${parent.accountId}`)) {
    throw new Error(`${spec.newAccountId} is not a sub-account of ${parent.accountId}`);
  }
  if (spec.methodNames.length === 0) {
    // An empty list means "all methods" at the protocol level: never create that by accident.
    throw new Error("function-call key needs at least one method name");
  }
  const batch: Action[] = [
    actions.createAccount(),
    actions.transfer(spec.initialBalanceYocto),
    actions.addFunctionCallAccessKey(PublicKey.from(spec.publicKey), spec.contractId, spec.methodNames, spec.allowanceYocto),
  ];
  return parent.signAndSendTransaction({ receiverId: spec.newAccountId, actions: batch, waitUntil: "EXECUTED_OPTIMISTIC" });
}

/** One batch transaction: DeployContract + FunctionCall(new). */
export async function deployAndInit(account: Account, wasm: Uint8Array, initArgs: InitArgs, gasTgas: bigint = 100n): Promise<TxOutcome> {
  return account.signAndSendTransaction({
    receiverId: account.accountId,
    actions: [actions.deployContract(wasm), actions.functionCall("new", initArgs, tgas(gasTgas), 0n)],
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
}

export async function addFullAccessKey(account: Account, publicKey: string): Promise<TxOutcome> {
  return account.addFullAccessKey(publicKey);
}

export async function addFunctionCallKey(
  account: Account,
  key: { publicKey: string; contractId: string; methodNames: string[]; allowanceYocto: bigint },
): Promise<TxOutcome> {
  if (key.methodNames.length === 0) throw new Error("function-call key needs at least one method name");
  return account.addFunctionCallAccessKey({
    publicKey: key.publicKey,
    contractId: key.contractId,
    methodNames: key.methodNames,
    allowance: key.allowanceYocto,
  });
}

export async function deleteKey(account: Account, publicKey: string): Promise<TxOutcome> {
  return account.deleteKey(publicKey);
}

// ---------------------------------------------------------------------------
// Access keys
// ---------------------------------------------------------------------------

export type AccessKeyEntry =
  | { publicKey: string; kind: "FullAccess"; nonce: string }
  | {
      publicKey: string;
      kind: "FunctionCall";
      nonce: string;
      receiverId: string;
      methodNames: string[];
      /** yoctoNEAR as a decimal string; null = unlimited. */
      allowance: string | null;
    }
  /** Gas keys and any permission kind this code does not know: reported, never ignored. */
  | { publicKey: string; kind: "Other"; nonce: string; permission: unknown };

/** `query` / `view_access_key_list`, normalised and sorted by public key. */
export async function viewAccessKeyList(provider: Provider, accountId: string): Promise<AccessKeyEntry[]> {
  const res = await provider.viewAccessKeyList({ accountId });
  return normalizeAccessKeyList(res.keys);
}

export function normalizeAccessKeyList(
  keys: ReadonlyArray<{ public_key: string; access_key: { nonce: number | bigint | string; permission: unknown } }>,
): AccessKeyEntry[] {
  return keys
    .map(({ public_key, access_key }): AccessKeyEntry => {
      const nonce = String(access_key.nonce);
      const perm = access_key.permission;
      if (perm === "FullAccess") return { publicKey: public_key, kind: "FullAccess", nonce };
      if (typeof perm === "object" && perm !== null && "FunctionCall" in perm) {
        const fc = (perm as { FunctionCall: { receiver_id: string; method_names: string[]; allowance?: unknown } })
          .FunctionCall;
        return {
          publicKey: public_key,
          kind: "FunctionCall",
          nonce,
          receiverId: fc.receiver_id,
          methodNames: [...fc.method_names],
          allowance: allowanceString(fc.allowance),
        };
      }
      return { publicKey: public_key, kind: "Other", nonce, permission: perm };
    })
    .sort((a, b) => (a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0));
}

/** RPC allowance (yoctoNEAR string; null/absent = unlimited). Unknown shapes are kept visible as JSON. */
function allowanceString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Logs and events
// ---------------------------------------------------------------------------

type OutcomeLike = {
  transaction_outcome: { outcome: { logs: string[]; executor_id: string } };
  receipts_outcome: ReadonlyArray<{ outcome: { logs: string[]; executor_id: string } }>;
};

function outcomeParts(outcome: OutcomeLike): Array<{ logs: string[]; executor_id: string }> {
  return [outcome.transaction_outcome.outcome, ...outcome.receipts_outcome.map((r) => r.outcome)];
}

/** All log lines of a transaction, in execution order. */
export function collectLogs(outcome: OutcomeLike): string[] {
  return outcomeParts(outcome).flatMap((part) => part.logs);
}

/**
 * NEP-297 events with the given standard. With `executorId`, only logs emitted
 * by that account count, so another contract in the same transaction cannot
 * forge a claw-guard event.
 */
export function outcomeEvents(
  outcome: OutcomeLike,
  { executorId, standard = CLAWGUARD_EVENT_STANDARD }: { executorId?: string; standard?: string } = {},
): ClawGuardEvent[] {
  return outcomeParts(outcome)
    .filter((part) => executorId === undefined || part.executor_id === executorId)
    .flatMap((part) => parseEventLogs(part.logs, standard));
}

export function parseEventLogs(logs: readonly string[], standard: string = CLAWGUARD_EVENT_STANDARD): ClawGuardEvent[] {
  return logs.map(parseEventLog).filter((e): e is ClawGuardEvent => e !== undefined && e.standard === standard);
}

// ---------------------------------------------------------------------------
// ClawGuard client
// ---------------------------------------------------------------------------

export class ClawGuardClient {
  constructor(
    readonly provider: Provider,
    readonly contractId: string,
    private readonly account?: Account,
  ) {
    assertTestnetAccountId(contractId, "claw-guard contract id");
  }

  /** Same contract, calls signed by another account (owner, guardian or agent). */
  as(account: Account): ClawGuardClient {
    return new ClawGuardClient(this.provider, this.contractId, account);
  }

  // ---- views ----

  async getStatus(): Promise<GuardStatus> {
    return parseGuardStatus(await this.view("get_status"));
  }

  async getRules(agentId: string): Promise<AgentState | null> {
    const res = await this.view("get_rules", { agent_id: agentId });
    return res === null || res === undefined ? null : parseAgentState(res);
  }

  async getReceipt(id: bigint | number | string): Promise<Receipt | null> {
    const res = await this.view("get_receipt", { id: toU64(id) });
    return res === null || res === undefined ? null : parseReceipt(res);
  }

  async getReceipts(fromId: bigint | number | string, limit: number = MAX_RECEIPTS_PAGE): Promise<Receipt[]> {
    const res = await this.view("get_receipts", { from_id: toU64(fromId), limit: Math.min(limit, MAX_RECEIPTS_PAGE) });
    if (!Array.isArray(res)) throw new Error("get_receipts did not return an array");
    return res.map((r, i) => parseReceipt(r, `receipts[${i}]`));
  }

  /** The newest `last` receipts (at most the 1000 the ring buffer holds), oldest first. */
  async getLastReceipts(last: number): Promise<Receipt[]> {
    const want = Math.min(last, MAX_RECEIPTS_HELD);
    const { receipts_count } = await this.getStatus();
    const out: Receipt[] = [];
    let from = Math.max(1, receipts_count - want + 1);
    while (from <= receipts_count) {
      const page = await this.getReceipts(from, MAX_RECEIPTS_PAGE);
      const next = Number(page[page.length - 1]?.id ?? 0) + 1;
      // Stop on an empty page or ids that do not move forward (never loop forever).
      if (page.length === 0 || next <= from) break;
      out.push(...page);
      from = next;
    }
    return out.slice(-want);
  }

  async getPaths(): Promise<Array<[Target, string]>> {
    return parsePaths(await this.view("get_paths"));
  }

  async previewPayload(agentId: string, proposal: Proposal): Promise<PreviewResult> {
    return parsePreviewResult(await this.view("preview_payload", { agent_id: agentId, proposal }));
  }

  // ---- owner only (1 yoctoNEAR proves a full-access key signed) ----

  registerAgent(agentId: string, rules: Rules): Promise<CallResult> {
    return this.call("register_agent", { agent_id: agentId, rules }, { depositYocto: ONE_YOCTO });
  }
  removeAgent(agentId: string): Promise<CallResult> {
    return this.call("remove_agent", { agent_id: agentId }, { depositYocto: ONE_YOCTO });
  }
  setRules(agentId: string, rules: Rules): Promise<CallResult> {
    return this.call("set_rules", { agent_id: agentId, rules }, { depositYocto: ONE_YOCTO });
  }
  confirmRules(agentId: string): Promise<CallResult> {
    return this.call("confirm_rules", { agent_id: agentId }, { depositYocto: ONE_YOCTO });
  }
  /** Owner attaches 1 yocto; a guardian (function-call key) cannot attach anything. */
  cancelPendingRules(agentId: string, { asGuardian = false }: { asGuardian?: boolean } = {}): Promise<CallResult> {
    return this.call("cancel_pending_rules", { agent_id: agentId }, { depositYocto: asGuardian ? 0n : ONE_YOCTO });
  }
  unpause(): Promise<CallResult> {
    return this.call("unpause", {}, { depositYocto: ONE_YOCTO });
  }
  setGuardian(guardianId: string | null): Promise<CallResult> {
    return this.call("set_guardian", { guardian_id: guardianId }, { depositYocto: ONE_YOCTO });
  }
  setSignConfig(signDepositYocto: bigint, signGasTgas: number): Promise<CallResult> {
    return this.call(
      "set_sign_config",
      { sign_deposit_yocto: signDepositYocto.toString(), sign_gas_tgas: signGasTgas },
      { depositYocto: ONE_YOCTO },
    );
  }

  // ---- owner or guardian, no deposit ----

  pause(reason: string): Promise<CallResult> {
    return this.call("pause", { reason });
  }

  // ---- agent ----

  /** propose_order with 300 Tgas and no deposit; resolves to the final Decision (after the MPC callback). */
  async proposeOrder(proposal: Proposal, { gasTgas = PROPOSE_GAS_TGAS }: { gasTgas?: bigint } = {}): Promise<CallResult<Decision>> {
    const res = await this.call("propose_order", { proposal }, { gasTgas });
    return { ...res, value: parseDecision(res.value) };
  }

  // ---- plumbing ----

  private async view(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return viewFunction(this.provider, this.contractId, method, args);
  }

  private async call(method: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<CallResult> {
    if (this.account === undefined) throw new Error(`${method} needs a signing account (use ClawGuardClient.as)`);
    return callFunction(this.account, this.contractId, method, args, opts);
  }
}
