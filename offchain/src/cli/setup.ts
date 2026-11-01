// `npm run setup:sandbox` / `npm run setup:testnet`: deploy Claw Guard, create its
// accounts with least-privilege keys and register the demo agent. Prototype. Testnet only. Not audited.
//
// Sandbox (no keys, no network accounts): starts a local NEAR sandbox node (near-sandbox npm
// package), signs as the root `test.near` with the key from the sandbox home's
// validator_key.json, deploys mock-mpc and claw-guard (wasm from scripts/build_contracts.sh),
// creates owner / agent / guardian with the key setup below and registers
// demo/rules.json for the agent (expiry = block time + 7 days). It prints
//   READY contract=clawguard.test.near agent=agent-1.test.near
// writes offchain/.sandbox/state.json (+ keys.json: throwaway sandbox keys, git-ignored) for the
// other CLIs, keeps the node running until Ctrl-C, then deletes the node and both files.
// `npm run demo` uses setupSandbox() in-process instead.
//
// Testnet (owner go only): the same with the owner's full-access key from offchain/.env. The
// agent and guardian keys are the owner's own (AGENT_PRIVATE_KEY / GUARDIAN_PRIVATE_KEY); only
// their public keys are used, nothing secret is written anywhere. Dry run unless --yes.
//
// Key setup:
//  - agent:    created in ONE batch (CreateAccount + Transfer + AddKey) with ONLY a function-call
//              key: receiver = claw-guard, methods = ["propose_order"], allowance 1 NEAR (gas).
//  - guardian: same pattern, methods = ["pause"].
//  - claw-guard and mock-mpc: deploy + `new` in one batch signed by the contract account itself
//              (`new` is #[private]).
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Sandbox } from "near-sandbox";
import { type Account, type JsonRpcProvider, KeyPair, KeyPairSigner, type PublicKey, actions } from "near-api-js";
import {
  type Config,
  ConfigError,
  OFFCHAIN_DIR,
  SANDBOX_IDS,
  SANDBOX_STATE_FILE,
  assertTestnetAccountId,
  loadConfig,
  log,
  requireValue,
  resolveNearRpcUrl,
} from "../config.js";
import { sandboxDerivedAddress } from "../derive.js";
import {
  ClawGuardClient,
  type TxOutcome,
  assertProviderNetwork,
  connectAccount,
  createProvider,
  createSubAccountWithFunctionCallKey,
  signerFromKey,
  tgas,
  viewAccessKeyList,
  viewFunction,
} from "../near.js";
import { DERIVATION_PATHS, type InitArgs, type Rules, parseRules } from "../types.js";
import { isMain, parseFlags, runCli } from "./common.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = join(OFFCHAIN_DIR, "..");
export const BUILD_SCRIPT = join(REPO_ROOT, "scripts", "build_contracts.sh");
export const DEMO_RULES_FILE = join(REPO_ROOT, "demo", "rules.json");
/** Throwaway sandbox keys for the other CLIs (git-ignored, deleted at teardown). */
export const SANDBOX_KEYS_FILE = join(dirname(SANDBOX_STATE_FILE), "keys.json");

const YOCTO_PER_NEAR = 10n ** 24n;
const NS_PER_DAY = 86_400n * 1_000_000_000n;
/** Rules expire this long after setup. */
export const RULES_LIFETIME_NS = 7n * NS_PER_DAY;

/** Placeholder in demo/rules.json that setup replaces with block time + 7 days. */
const EXPIRY_PLACEHOLDER = "<set by setup: block time + 7 days>";

export const AGENT_METHODS = ["propose_order"] as const;
export const GUARDIAN_METHODS = ["pause"] as const;
/** Function-call key gas allowance: 1 NEAR, gas only. */
const FC_KEY_ALLOWANCE = YOCTO_PER_NEAR;
const SIGN_GAS_TGAS = 100;
const LOOSEN_DELAY_SEC = 600;
const INIT_GAS_TGAS = 100n;

/**
 * Sandbox node version (neard, protocol 88). The same node as the Rust sandbox tests: near-sandbox
 * crate 0.4.0 (under near-workspaces 0.24.0) defaults to 2.14.0, while the npm package 0.3.4
 * defaults to 2.13.4. scripts/sandbox_env.sh pins the same version for its low open-files-limit
 * fallback (owner decision D-13).
 */
export const SANDBOX_NODE_VERSION = "2.14.0";

/** Sandbox balances (sandbox NEAR, worthless), the same as tests/common/mod.rs. */
const SANDBOX_BALANCES = {
  contract: 20n * YOCTO_PER_NEAR,
  mpc: 10n * YOCTO_PER_NEAR,
  owner: 20n * YOCTO_PER_NEAR,
  agent: YOCTO_PER_NEAR / 2n,
  guardian: YOCTO_PER_NEAR / 2n,
} as const;

/** Testnet balances (testnet NEAR from the faucet): the contract gets at least 5 NEAR. */
const TESTNET_BALANCES = {
  contract: 5n * YOCTO_PER_NEAR,
  agent: YOCTO_PER_NEAR / 2n,
  guardian: YOCTO_PER_NEAR / 2n,
} as const;

// ---------------------------------------------------------------------------
// Inputs: wasm and rules
// ---------------------------------------------------------------------------

export interface ContractWasm {
  clawGuard: string;
  mockMpc: string;
}

/**
 * Wasm paths from scripts/build_contracts.sh (it rebuilds only what changed; build logs go to
 * stderr). CLAWGUARD_WASM_DIR=<dir laid out like target/near> skips the build, as in the Rust tests.
 */
export function buildContracts(env: NodeJS.ProcessEnv = process.env): ContractWasm {
  const prebuilt = env.CLAWGUARD_WASM_DIR;
  if (prebuilt !== undefined && prebuilt !== "") {
    return {
      clawGuard: join(prebuilt, "claw_guard", "claw_guard.wasm"),
      mockMpc: join(prebuilt, "mock_mpc", "mock_mpc.wasm"),
    };
  }
  const stdout = execFileSync("bash", [BUILD_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return parseBuildOutput(stdout);
}

/** `claw-guard=<path>` / `mock-mpc=<path>` lines (the build script's stdout contract). */
export function parseBuildOutput(stdout: string): ContractWasm {
  const paths = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^(claw-guard|mock-mpc)=(\/.+\.wasm)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) paths.set(match[1], match[2]);
  }
  const clawGuard = paths.get("claw-guard");
  const mockMpc = paths.get("mock-mpc");
  if (clawGuard === undefined || mockMpc === undefined) {
    throw new Error("scripts/build_contracts.sh did not print both claw-guard=<wasm> and mock-mpc=<wasm>");
  }
  return { clawGuard, mockMpc };
}

/**
 * demo/rules.json with `expires_at_ns` = `nowNs` + 7 days. The file's `_comment` is dropped and
 * the result is parsed with the same fail-closed parser as get_rules output.
 */
export function loadDemoRules(nowNs: bigint, path: string = DEMO_RULES_FILE): Rules {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw.expires_at_ns !== EXPIRY_PLACEHOLDER) {
    throw new ConfigError(`${path}: expires_at_ns must be the placeholder "${EXPIRY_PLACEHOLDER}" (setup fills it in)`);
  }
  const { _comment: _ignored, ...rules } = raw;
  return parseRules({ ...rules, expires_at_ns: (nowNs + RULES_LIFETIME_NS).toString() }, "demo/rules.json");
}

// ---------------------------------------------------------------------------
// Shared deployment steps
// ---------------------------------------------------------------------------

export interface DeploymentIds {
  owner: string;
  contract: string;
  mpc: string;
  agent: string;
  guardian: string | null;
}

/** Everything the demo, the agent and tests need after setup. */
export interface Deployment {
  network: "sandbox" | "testnet";
  rpcUrl: string;
  provider: JsonRpcProvider;
  ids: DeploymentIds;
  owner: Account;
  agent: Account;
  guardian: Account | null;
  /** Public keys of the agent's and guardian's function-call keys. */
  agentPublicKey: string;
  guardianPublicKey: string | null;
  /** Read side of claw-guard; use `.as(account)` to sign. */
  client: ClawGuardClient;
  rules: Rules;
}

/** Latest block time in ns (the contract's clock). */
export async function blockTimeNs(provider: JsonRpcProvider): Promise<bigint> {
  const block = await provider.viewBlock({ finality: "optimistic" });
  return BigInt(block.header.timestamp_nanosec);
}

async function createAccountWithFullAccessKey(
  parent: Account,
  accountId: string,
  publicKey: PublicKey,
  balance: bigint,
): Promise<TxOutcome> {
  return parent.signAndSendTransaction({
    receiverId: assertTestnetAccountId(accountId, "new account id"),
    actions: [actions.createAccount(), actions.transfer(balance), actions.addFullAccessKey(publicKey)],
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
}

/** DeployContract + FunctionCall(new) in one batch, signed by the contract account itself. */
async function deployAndInit(account: Account, wasmPath: string, initArgs: Record<string, unknown>): Promise<TxOutcome> {
  return account.signAndSendTransaction({
    receiverId: account.accountId,
    actions: [actions.deployContract(readFileSync(wasmPath)), actions.functionCall("new", initArgs, tgas(INIT_GAS_TGAS), 0n)],
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
}

/** Fail closed unless `accountId` has exactly one key: a function-call key for `contractId` with exactly `methods`. */
export async function assertOnlyFunctionCallKey(
  provider: JsonRpcProvider,
  accountId: string,
  contractId: string,
  methods: readonly string[],
): Promise<string> {
  const keys = await viewAccessKeyList(provider, accountId);
  const key = keys[0];
  const ok =
    keys.length === 1 &&
    key?.kind === "FunctionCall" &&
    key.receiverId === contractId &&
    key.methodNames.length === methods.length &&
    methods.every((m, i) => key.methodNames[i] === m);
  if (!ok || key === undefined) {
    throw new Error(`${accountId} must have exactly one key: a function-call key for ${contractId} with methods [${methods.join(", ")}]`);
  }
  return key.publicKey;
}

/** Register the agent (owner, 1 yocto) and check what the contract now reports. */
async function registerAndVerify(
  client: ClawGuardClient,
  owner: Account,
  ids: DeploymentIds,
  rules: Rules,
): Promise<void> {
  await client.as(owner).registerAgent(ids.agent, rules);
  const status = await client.getStatus();
  if (status.owner !== ids.owner || status.guardian !== ids.guardian || status.mpc_contract_id !== ids.mpc) {
    throw new Error(`claw-guard get_status does not match the setup: ${JSON.stringify(status)}`);
  }
  const state = await client.getRules(ids.agent);
  if (state === null || state.rules_version !== 1 || state.rules.expires_at_ns !== rules.expires_at_ns) {
    throw new Error(`${ids.agent} is not registered with the demo rules`);
  }
}

export function readyLine(ids: Pick<DeploymentIds, "contract" | "agent">): string {
  return `READY contract=${ids.contract} agent=${ids.agent}`;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface SandboxDeployment extends Deployment {
  network: "sandbox";
  sandbox: Sandbox;
  /** Throwaway sandbox keys (worthless; never use anywhere else), by account id. */
  keys: Record<string, string>;
  /** Last lines the sandbox node wrote to stderr, for error reports. */
  nodeLogTail(): string[];
  /** Stop the node and delete its home directory. Safe to call twice. */
  tearDown(): Promise<void>;
}

export interface SetupSandboxOptions {
  wasm?: ContractWasm;
  /** Progress lines (default: log.info). */
  progress?: (line: string) => void;
  /** Called as soon as the node runs, with its teardown (so a signal during setup still deletes it). */
  onNodeStarted?: (tearDown: () => Promise<void>) => void;
}

const NODE_LOG_LINES = 20;

/**
 * Start the sandbox node. near-sandbox 0.3.4 pipes the node's stderr but never reads it; a long
 * run would fill the pipe and stall the node, so the pipe is drained here (last lines are kept).
 * The package downloads SANDBOX_NODE_VERSION on first use. NEAR_SANDBOX_BIN_PATH (a local neard
 * sandbox binary) is honoured by the package and then wins over the version; `make demo` sets it
 * to scripts/fdlimit/near-sandbox-wrapper.sh (same 2.14.0 node) only on hosts whose open-files
 * hard limit is below 65535 (scripts/sandbox_env.sh).
 */
async function startSandboxNode(): Promise<{ sandbox: Sandbox; tail: () => string[] }> {
  const sandbox = await Sandbox.start({ version: SANDBOX_NODE_VERSION });
  const lines: string[] = [];
  // Private field of near-sandbox 0.3.4 (exact version pinned in package.json).
  const child = (sandbox as unknown as { childProcess?: ChildProcess }).childProcess;
  child?.stderr?.setEncoding("utf8");
  child?.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      lines.push(line);
      if (lines.length > NODE_LOG_LINES) lines.shift();
    }
  });
  return { sandbox, tail: () => [...lines] };
}

export async function setupSandbox({
  wasm = buildContracts(),
  progress = log.info,
  onNodeStarted,
}: SetupSandboxOptions = {}): Promise<SandboxDeployment> {
  const { sandbox, tail } = await startSandboxNode();
  let torn: Promise<void> | undefined;
  const tearDown = (): Promise<void> => (torn ??= sandbox.tearDown());
  onNodeStarted?.(tearDown);
  try {
    progress(`Sandbox node running at ${sandbox.rpcUrl} (local only)`);
    const provider = createProvider(sandbox.rpcUrl);
    await assertProviderNetwork(provider, "sandbox");

    const validatorKey = JSON.parse(readFileSync(join(sandbox.homeDir, "validator_key.json"), "utf8")) as {
      account_id?: unknown;
      secret_key?: unknown;
    };
    if (validatorKey.account_id !== SANDBOX_IDS.root || typeof validatorKey.secret_key !== "string") {
      throw new Error("sandbox validator_key.json does not hold the test.near key");
    }
    const root = connectAccount(SANDBOX_IDS.root, provider, signerFromKey(validatorKey.secret_key));

    const keyPairs = {
      [SANDBOX_IDS.owner]: KeyPair.fromRandom("ed25519"),
      [SANDBOX_IDS.contract]: KeyPair.fromRandom("ed25519"),
      [SANDBOX_IDS.mpc]: KeyPair.fromRandom("ed25519"),
      [SANDBOX_IDS.agent]: KeyPair.fromRandom("ed25519"),
      [SANDBOX_IDS.guardian]: KeyPair.fromRandom("ed25519"),
    };
    const account = (id: keyof typeof keyPairs): Account => connectAccount(id, provider, new KeyPairSigner(keyPairs[id]));
    const ids: DeploymentIds = {
      owner: SANDBOX_IDS.owner,
      contract: SANDBOX_IDS.contract,
      mpc: SANDBOX_IDS.mpc,
      agent: SANDBOX_IDS.agent,
      guardian: SANDBOX_IDS.guardian,
    };

    // mock-mpc: sandbox stand-in for the MPC signer (sandbox test key, worthless).
    await createAccountWithFullAccessKey(root, ids.mpc, keyPairs[SANDBOX_IDS.mpc].getPublicKey(), SANDBOX_BALANCES.mpc);
    await deployAndInit(account(SANDBOX_IDS.mpc), wasm.mockMpc, {});
    progress(`Deployed mock-mpc on ${ids.mpc} (sandbox stand-in for the MPC signer)`);

    await createAccountWithFullAccessKey(root, ids.contract, keyPairs[SANDBOX_IDS.contract].getPublicKey(), SANDBOX_BALANCES.contract);
    const initArgs: InitArgs = {
      owner_id: ids.owner,
      guardian_id: ids.guardian,
      mpc_contract_id: ids.mpc,
      sign_deposit_yocto: "1",
      sign_gas_tgas: SIGN_GAS_TGAS,
      loosen_delay_sec: LOOSEN_DELAY_SEC,
    };
    await deployAndInit(account(SANDBOX_IDS.contract), wasm.clawGuard, { ...initArgs });
    progress(`Deployed claw-guard on ${ids.contract} (owner ${ids.owner}, guardian ${ids.guardian}, signer ${ids.mpc})`);

    await createAccountWithFullAccessKey(root, ids.owner, keyPairs[SANDBOX_IDS.owner].getPublicKey(), SANDBOX_BALANCES.owner);
    for (const [id, methods, balance] of [
      [SANDBOX_IDS.agent, AGENT_METHODS, SANDBOX_BALANCES.agent],
      [SANDBOX_IDS.guardian, GUARDIAN_METHODS, SANDBOX_BALANCES.guardian],
    ] as const) {
      await createSubAccountWithFunctionCallKey(root, {
        newAccountId: id,
        publicKey: keyPairs[id].getPublicKey().toString(),
        initialBalanceYocto: balance,
        contractId: ids.contract,
        methodNames: [...methods],
        allowanceYocto: FC_KEY_ALLOWANCE,
      });
    }
    const agentPublicKey = await assertOnlyFunctionCallKey(provider, ids.agent, ids.contract, AGENT_METHODS);
    const guardianPublicKey = await assertOnlyFunctionCallKey(provider, SANDBOX_IDS.guardian, ids.contract, GUARDIAN_METHODS);
    progress(`Created ${ids.agent}: one function-call key only (receiver ${ids.contract}, methods [propose_order], allowance 1 NEAR)`);
    progress(`Created ${SANDBOX_IDS.guardian}: one function-call key only (receiver ${ids.contract}, methods [pause])`);

    const client = new ClawGuardClient(provider, ids.contract);
    const owner = account(SANDBOX_IDS.owner);
    const rules = loadDemoRules(await blockTimeNs(provider));
    await registerAndVerify(client, owner, ids, rules);
    progress(`Registered ${ids.agent} with demo/rules.json (expires 7 days from now)`);

    // The mock signs with the same key the offchain derivation math expects (verify-sig relies on it).
    for (const path of Object.values(DERIVATION_PATHS)) {
      const onChain = await viewFunction(provider, ids.mpc, "derived_address", { predecessor: ids.contract, path });
      if (onChain !== sandboxDerivedAddress(ids.contract, path)) {
        throw new Error(`mock-mpc derived_address for ${path} differs from the offchain derivation`);
      }
    }

    return {
      network: "sandbox",
      rpcUrl: sandbox.rpcUrl,
      provider,
      ids,
      owner,
      agent: account(SANDBOX_IDS.agent),
      guardian: account(SANDBOX_IDS.guardian),
      agentPublicKey,
      guardianPublicKey,
      client,
      rules,
      sandbox,
      keys: Object.fromEntries(Object.entries(keyPairs).map(([id, kp]) => [id, kp.toString()])),
      nodeLogTail: tail,
      tearDown,
    };
  } catch (err) {
    const lines = tail();
    if (lines.length > 0) log.error(`Sandbox node log (last ${lines.length} lines):\n${lines.join("\n")}`);
    await tearDown().catch((e: unknown) => log.error(`Sandbox teardown failed: ${e instanceof Error ? e.message : String(e)}`));
    throw err;
  }
}

// ---- state files for the other CLIs (sandbox only) ----

export interface SandboxKeysFile {
  network: "sandbox";
  note: string;
  keys: Record<string, string>;
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function writeSandboxFiles(dep: SandboxDeployment): void {
  writePrivateJson(SANDBOX_KEYS_FILE, {
    network: "sandbox",
    note: "Sandbox test keys for a local chain that is deleted at teardown. Worthless; never use anywhere else.",
    keys: dep.keys,
  } satisfies SandboxKeysFile);
  writePrivateJson(SANDBOX_STATE_FILE, {
    network: "sandbox",
    rpcUrl: dep.rpcUrl,
    contractId: dep.ids.contract,
    mpcContractId: dep.ids.mpc,
    ownerId: dep.ids.owner,
    agentId: dep.ids.agent,
    guardianId: dep.ids.guardian,
    keysFile: SANDBOX_KEYS_FILE,
    pid: process.pid,
  });
}

export function removeSandboxFiles(): void {
  rmSync(SANDBOX_KEYS_FILE, { force: true });
  rmSync(SANDBOX_STATE_FILE, { force: true });
}

/** The sandbox key of `accountId` written by a running `setup:sandbox`. */
export function readSandboxKey(accountId: string, path: string = SANDBOX_KEYS_FILE): string {
  let file: Partial<SandboxKeysFile>;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as Partial<SandboxKeysFile>;
  } catch {
    throw new ConfigError(`no sandbox keys at ${path}: run \`npm run setup:sandbox\` (and keep it running) first`);
  }
  const key = file.network === "sandbox" ? file.keys?.[accountId] : undefined;
  if (typeof key !== "string") throw new ConfigError(`${path} has no sandbox key for ${accountId}`);
  return key;
}

// ---------------------------------------------------------------------------
// Testnet (owner go only)
// ---------------------------------------------------------------------------

export interface TestnetPlan {
  ids: DeploymentIds;
  initArgs: InitArgs;
  agentPublicKey: string;
  guardianPublicKey: string | null;
}

/** Sub-account check: the owner creates every account (agent-1.<owner>.testnet). */
function assertSubAccount(id: string, parent: string, envName: string): string {
  assertTestnetAccountId(id, envName);
  if (!id.endsWith(`.${parent}`)) throw new ConfigError(`${envName} must be a sub-account of ${parent} (got ${id})`);
  return id;
}

async function publicKeyOf(secret: Parameters<typeof signerFromKey>[0]): Promise<string> {
  return (await signerFromKey(secret).getPublicKey()).toString();
}

export async function planTestnet(config: Config, signDepositYocto: string): Promise<TestnetPlan> {
  if (config.nearNetwork !== "testnet") throw new ConfigError("setup:testnet needs NEAR_NETWORK=testnet in offchain/.env");
  const owner = requireValue(config.ownerAccountId, "OWNER_ACCOUNT_ID");
  requireValue(config.ownerPrivateKey, "OWNER_PRIVATE_KEY");
  const ids: DeploymentIds = {
    owner,
    contract: assertSubAccount(requireValue(config.clawguardContractId, "CLAWGUARD_CONTRACT_ID"), owner, "CLAWGUARD_CONTRACT_ID"),
    mpc: config.mpcContractId,
    agent: assertSubAccount(requireValue(config.agentAccountId, "AGENT_ACCOUNT_ID"), owner, "AGENT_ACCOUNT_ID"),
    guardian: config.guardianAccountId === undefined ? null : assertSubAccount(config.guardianAccountId, owner, "GUARDIAN_ACCOUNT_ID"),
  };
  if (ids.guardian !== null && config.guardianPrivateKey === undefined) {
    throw new ConfigError("GUARDIAN_PRIVATE_KEY is required when GUARDIAN_ACCOUNT_ID is set");
  }
  if (!/^\d+$/.test(signDepositYocto)) throw new ConfigError("--sign-deposit-yocto must be a decimal integer");
  return {
    ids,
    initArgs: {
      owner_id: ids.owner,
      guardian_id: ids.guardian,
      mpc_contract_id: ids.mpc,
      sign_deposit_yocto: signDepositYocto,
      sign_gas_tgas: SIGN_GAS_TGAS,
      loosen_delay_sec: LOOSEN_DELAY_SEC,
    },
    agentPublicKey: await publicKeyOf(requireValue(config.agentPrivateKey, "AGENT_PRIVATE_KEY")),
    guardianPublicKey: config.guardianPrivateKey === undefined ? null : await publicKeyOf(config.guardianPrivateKey),
  };
}

async function accountExists(provider: JsonRpcProvider, accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deploy on NEAR testnet with the owner's key. The contract account gets the owner's public key
 * as its full-access key (the owner is trusted; locking it is an owner decision).
 */
export async function setupTestnet(
  config: Config,
  { yes, signDepositYocto = "1", rpc, wasm }: { yes: boolean; signDepositYocto?: string; rpc?: string; wasm?: ContractWasm },
): Promise<Deployment | null> {
  const plan = await planTestnet(config, signDepositYocto);
  const { ids } = plan;
  const rpcUrl = resolveNearRpcUrl(config, rpc);
  const provider = createProvider(rpcUrl);
  await assertProviderNetwork(provider, "testnet");

  for (const id of [ids.contract, ids.agent, ...(ids.guardian === null ? [] : [ids.guardian])]) {
    if (await accountExists(provider, id)) throw new ConfigError(`${id} already exists on testnet; setup:testnet never overwrites an account`);
  }
  log.info(`setup:testnet plan (NEAR testnet, owner ${ids.owner}):`);
  log.info(`  create ${ids.contract} (5 NEAR, owner's key), deploy claw-guard, init ${JSON.stringify(plan.initArgs)}`);
  log.info(`  create ${ids.agent} (0.5 NEAR) with only a function-call key ${plan.agentPublicKey}: [propose_order] on ${ids.contract}`);
  if (ids.guardian !== null) {
    log.info(`  create ${ids.guardian} (0.5 NEAR) with only a function-call key ${String(plan.guardianPublicKey)}: [pause] on ${ids.contract}`);
  }
  log.info(`  register ${ids.agent} with demo/rules.json (expires 7 days from now)`);
  if (!yes) {
    log.info("Dry run: nothing was sent. Run again with --yes once the owner says go.");
    return null;
  }

  const ownerSigner = signerFromKey(requireValue(config.ownerPrivateKey, "OWNER_PRIVATE_KEY"));
  const owner = connectAccount(ids.owner, provider, ownerSigner);
  const ownerPublicKey = await ownerSigner.getPublicKey();
  const contractWasm = wasm ?? buildContracts();

  await createAccountWithFullAccessKey(owner, ids.contract, ownerPublicKey, TESTNET_BALANCES.contract);
  await deployAndInit(connectAccount(ids.contract, provider, ownerSigner), contractWasm.clawGuard, { ...plan.initArgs });
  log.info(`Deployed claw-guard on ${ids.contract}`);

  const fcAccounts: Array<[string, string, readonly string[], bigint]> = [[ids.agent, plan.agentPublicKey, AGENT_METHODS, TESTNET_BALANCES.agent]];
  if (ids.guardian !== null && plan.guardianPublicKey !== null) {
    fcAccounts.push([ids.guardian, plan.guardianPublicKey, GUARDIAN_METHODS, TESTNET_BALANCES.guardian]);
  }
  for (const [id, publicKey, methods, balance] of fcAccounts) {
    await createSubAccountWithFunctionCallKey(owner, {
      newAccountId: id,
      publicKey,
      initialBalanceYocto: balance,
      contractId: ids.contract,
      methodNames: [...methods],
      allowanceYocto: FC_KEY_ALLOWANCE,
    });
    await assertOnlyFunctionCallKey(provider, id, ids.contract, methods);
    log.info(`Created ${id} with one function-call key [${methods.join(", ")}]`);
  }

  const client = new ClawGuardClient(provider, ids.contract);
  const rules = loadDemoRules(await blockTimeNs(provider));
  await registerAndVerify(client, owner, ids, rules);
  return {
    network: "testnet",
    rpcUrl,
    provider,
    ids,
    owner,
    agent: connectAccount(ids.agent, provider, signerFromKey(requireValue(config.agentPrivateKey, "AGENT_PRIVATE_KEY"))),
    guardian:
      ids.guardian === null || config.guardianPrivateKey === undefined
        ? null
        : connectAccount(ids.guardian, provider, signerFromKey(config.guardianPrivateKey)),
    agentPublicKey: plan.agentPublicKey,
    guardianPublicKey: plan.guardianPublicKey,
    client,
    rules,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * SIGINT / SIGTERM handling for a CLI that owns a sandbox node. Before `wait()` a signal is an
 * interruption: the node is torn down (if one was tracked) and the process exits 130. During
 * `wait()` a signal ends the wait so the caller can clean up normally.
 */
export class SandboxSignalGuard {
  #tearDown: (() => Promise<void>) | undefined;
  #waiting: ((signal: NodeJS.Signals) => void) | undefined;
  readonly #onSignal = (signal: NodeJS.Signals): void => {
    if (this.#waiting !== undefined) {
      this.#waiting(signal);
      return;
    }
    log.error(`Interrupted (${signal}): stopping the sandbox`);
    void (this.#tearDown?.() ?? Promise.resolve()).finally(() => process.exit(130));
  };

  constructor() {
    process.on("SIGINT", this.#onSignal);
    process.on("SIGTERM", this.#onSignal);
  }

  track(tearDown: () => Promise<void>): void {
    this.#tearDown = tearDown;
  }

  wait(): Promise<NodeJS.Signals> {
    return new Promise((resolve) => (this.#waiting = resolve));
  }

  dispose(): void {
    process.off("SIGINT", this.#onSignal);
    process.off("SIGTERM", this.#onSignal);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const config = loadConfig();
  const flags = parseFlags(
    {
      network: { type: "string" },
      yes: { type: "boolean" },
      rpc: { type: "string" },
      "sign-deposit-yocto": { type: "string" },
    },
    argv,
  );
  if (flags.network === "testnet") {
    const dep = await setupTestnet(config, {
      yes: flags.yes === true,
      ...(flags["sign-deposit-yocto"] === undefined ? {} : { signDepositYocto: flags["sign-deposit-yocto"] }),
      ...(flags.rpc === undefined ? {} : { rpc: flags.rpc }),
    });
    if (dep !== null) log.info(`${readyLine(dep.ids)} (testnet)`);
    return 0;
  }
  if (flags.network !== "sandbox") throw new ConfigError("--network must be sandbox or testnet");
  if (flags.yes !== undefined || flags.rpc !== undefined || flags["sign-deposit-yocto"] !== undefined) {
    throw new ConfigError("--yes, --rpc and --sign-deposit-yocto apply to --network testnet only");
  }
  if (config.nearNetwork !== "sandbox") log.warn("Note: NEAR_NETWORK is not sandbox; the other CLIs read the sandbox state only with NEAR_NETWORK=sandbox.");

  const guard = new SandboxSignalGuard();
  try {
    const dep = await setupSandbox({ onNodeStarted: (tearDown) => guard.track(tearDown) });
    try {
      writeSandboxFiles(dep);
      log.info(readyLine(dep.ids));
      log.info(`State for the other CLIs: ${SANDBOX_STATE_FILE} (sandbox keys in ${SANDBOX_KEYS_FILE}, worthless test keys)`);
      log.info("The sandbox keeps running. Press Ctrl-C to stop it and delete its state.");
      await guard.wait();
    } finally {
      removeSandboxFiles();
      await dep.tearDown();
      log.info("Sandbox stopped and deleted.");
    }
  } finally {
    guard.dispose();
  }
  return 0;
}

if (isMain(import.meta.url)) void runCli(() => main());
