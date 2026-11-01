// Configuration and testnet-only guards for every Claw Guard off-chain binary.
//
// Every CLI calls loadConfig() before doing anything else. It refuses to start
// (ERR_MAINNET_REFUSED) on any sign of a non-testnet network: NEAR_NETWORK other
// than sandbox|testnet, a URL that looks like mainnet, a Hyperliquid URL other
// than the testnet one, the mainnet MPC signer, or a NEAR account id that is not
// a testnet/sandbox id. The Base Sepolia path additionally checks eth_chainId.
//
// Secrets (*_PRIVATE_KEY, *_TOKEN, LLM_API_KEY) are wrapped in Secret so that
// printing or JSON-serialising a Config never shows them, and every value is
// registered with the redactor used by `log`.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, inspect, parseEnv } from "node:util";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ERR_MAINNET_REFUSED = "ERR_MAINNET_REFUSED";

export const HL_TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz";
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_CHAIN_ID_HEX = "0x14a34";
export const DEFAULT_BASE_SEPOLIA_RPC_URL = "https://sepolia.base.org";
export const DEFAULT_BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const TESTNET_MPC_CONTRACT_ID = "v1.signer-prod.testnet";
/**
 * NEAR testnet RPC that gen-testnet-near-key writes into offchain/.env when NEAR_RPC_URL is empty
 * there (owner request after the 31 Oct 2026 testnet rerun; the first testnet run used this URL,
 * docs/VERIFY.md section (h)). Not a loadConfig default: on testnet NEAR_RPC_URL stays required,
 * and any testnet RPC works.
 */
export const DEFAULT_TESTNET_RPC_URL = "https://rpc.testnet.near.org";
/** The mainnet MPC signer. Listed only so it can be refused by name. */
const MAINNET_MPC_CONTRACT_ID = "v1.signer";

/** Fixed sandbox account ids. */
export const SANDBOX_IDS = {
  root: "test.near",
  owner: "owner.test.near",
  contract: "clawguard.test.near",
  mpc: "mock-mpc.test.near",
  agent: "agent-1.test.near",
  guardian: "guardian.test.near",
} as const;

/** offchain/ (package root), resolved from this file so the cwd does not matter. */
export const OFFCHAIN_DIR = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));
export const ENV_EXAMPLE_FILE = fileURLToPath(new URL("../.env.example", import.meta.url));
/** Written by `setup:sandbox`, read by the other CLIs to find the local sandbox. */
export const SANDBOX_STATE_FILE = fileURLToPath(new URL("../.sandbox/state.json", import.meta.url));

/** Mainnet guard: any URL matching this is refused. Case-insensitive on purpose. */
const MAINNET_URL_PATTERN = /mainnet|api\.hyperliquid\.xyz(?!-)|rpc\.mainnet/i;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by every testnet guard. The message always starts with ERR_MAINNET_REFUSED. */
export class MainnetRefusedError extends Error {
  readonly code = ERR_MAINNET_REFUSED;
  constructor(reason: string) {
    super(`${ERR_MAINNET_REFUSED}: ${reason}`);
    this.name = "MainnetRefusedError";
  }
}

/** A configuration value is missing or malformed (not a network-safety problem). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Secrets and redaction
// ---------------------------------------------------------------------------

export const REDACTED = "[REDACTED]";

/** Values shorter than this are not real keys/tokens; redacting them would mangle output. */
const MIN_REDACT_LENGTH = 4;
const knownSecrets = new Set<string>();

/** Register a value so `redact()` removes it from any text. */
export function registerSecret(value: string): void {
  if (value.length >= MIN_REDACT_LENGTH) knownSecrets.add(value);
}

/** True for env names whose values must never be logged. */
export function isSecretEnvName(name: string): boolean {
  return /_PRIVATE_KEY$|_TOKEN$/.test(name) || name === "LLM_API_KEY";
}

/**
 * A secret string. `String(s)`, `JSON.stringify(s)` and `util.inspect(s)` all
 * yield a redacted placeholder; only `reveal()` returns the value.
 */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
    registerSecret(value);
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}

// Pattern-based fallbacks for secrets that were never registered (e.g. echoed by a library).
const SECRET_PATTERNS: readonly RegExp[] = [
  // NEAR ed25519 secret keys are 64 bytes (~88 base58 chars); public keys are ~44 chars.
  /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g,
  // near-api-js secp256k1 secret keys are 96 bytes (~131 chars), a bare 32-byte scalar is ~44
  // chars; public keys (64 bytes, ~88 chars, e.g. the MPC root key) are kept.
  /secp256k1:(?:[1-9A-HJ-NP-Za-km-z]{100,}|[1-9A-HJ-NP-Za-km-z]{40,50}(?![1-9A-HJ-NP-Za-km-z]))/g,
  // Telegram bot tokens, bare or inside an API URL (".../bot<token>/sendMessage").
  /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
];

/** Remove every registered secret value and every secret-shaped token from `text`. */
export function redact(text: string): string {
  let out = text;
  // Longest first, so a secret that contains another is removed whole.
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Console logging that always goes through `redact()`. Use it instead of console.* in CLIs. */
export const log = {
  info: (...args: unknown[]): void => {
    console.log(redact(format(...args)));
  },
  warn: (...args: unknown[]): void => {
    console.warn(redact(format(...args)));
  },
  error: (...args: unknown[]): void => {
    console.error(redact(format(...args)));
  },
};

// ---------------------------------------------------------------------------
// Guards (exported so binaries and later stages can re-check at use sites)
// ---------------------------------------------------------------------------

export type NearNetwork = "sandbox" | "testnet";
export type DemoTarget = "hl" | "base";
export type AgentMode = "scripted" | "llm";

export function assertNearNetwork(value: string | undefined): NearNetwork {
  const network = value === undefined || value === "" ? "sandbox" : value;
  if (network !== "sandbox" && network !== "testnet") {
    throw new MainnetRefusedError(`NEAR_NETWORK must be "sandbox" or "testnet" (got "${network}")`);
  }
  return network;
}

/** Refuse a URL that is not http(s) or that looks like a mainnet endpoint. */
export function assertNoMainnetUrl(url: string, label: string): string {
  if (MAINNET_URL_PATTERN.test(url)) {
    throw new MainnetRefusedError(`${label} looks like a mainnet URL (${url})`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(`${label} must be an http(s) URL`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    // Credentials in a URL would end up in logs; refuse instead of redacting.
    throw new ConfigError(`${label} must not contain credentials`);
  }
  return url;
}

/** Hyperliquid: only the exact testnet API URL is accepted. */
export function assertHlTestnetUrl(url: string): string {
  assertNoMainnetUrl(url, "HL_API_URL");
  if (url !== HL_TESTNET_API_URL) {
    throw new MainnetRefusedError(`HL_API_URL must be ${HL_TESTNET_API_URL} (got ${url})`);
  }
  return url;
}

/** True for NEAR testnet or local-sandbox account ids. Implicit (hex) ids are refused: they exist on mainnet too. */
export function isTestnetAccountId(id: string): boolean {
  return id.endsWith(".testnet") || id === SANDBOX_IDS.root || id.endsWith(`.${SANDBOX_IDS.root}`);
}

export function assertTestnetAccountId(id: string, label: string): string {
  if (!isTestnetAccountId(id)) {
    throw new MainnetRefusedError(`${label} must end with ".testnet" or ".test.near" (got "${id}")`);
  }
  return id;
}

export function assertMpcContractId(id: string): string {
  if (id === MAINNET_MPC_CONTRACT_ID) {
    throw new MainnetRefusedError(`MPC_CONTRACT_ID ${MAINNET_MPC_CONTRACT_ID} is the mainnet signer`);
  }
  return assertTestnetAccountId(id, "MPC_CONTRACT_ID");
}

/** NEAR RPC `status.chain_id` check: testnet must say "testnet"; sandbox must never say mainnet. */
export function assertNearChainId(chainId: string, network: NearNetwork): string {
  if (/mainnet/i.test(chainId) || (network === "testnet" && chainId !== "testnet")) {
    throw new MainnetRefusedError(`NEAR RPC reports chain_id "${chainId}" but NEAR_NETWORK=${network}`);
  }
  return chainId;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Base Sepolia path: ask the RPC for eth_chainId and refuse unless it is 0x14a34 (84532).
 * Network or protocol errors are thrown too (fail closed), as a plain Error.
 */
export async function assertBaseSepoliaChainId(rpcUrl: string, fetchImpl: FetchLike = fetch): Promise<void> {
  assertNoMainnetUrl(rpcUrl, "BASE_SEPOLIA_RPC_URL");
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  if (!res.ok) throw new Error(`eth_chainId request failed with HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  const chainId = typeof body.result === "string" ? body.result.toLowerCase() : undefined;
  if (chainId !== BASE_SEPOLIA_CHAIN_ID_HEX) {
    throw new MainnetRefusedError(
      `EVM RPC reports chain id ${String(body.result)}; only Base Sepolia (${BASE_SEPOLIA_CHAIN_ID_HEX}) is allowed`,
    );
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Config {
  readonly nearNetwork: NearNetwork;
  readonly nearRpcUrl: string | undefined;
  readonly mpcContractId: string;
  readonly clawguardContractId: string | undefined;
  readonly ownerAccountId: string | undefined;
  readonly ownerPrivateKey: Secret | undefined;
  readonly agentAccountId: string | undefined;
  readonly agentPrivateKey: Secret | undefined;
  readonly guardianAccountId: string | undefined;
  readonly guardianPrivateKey: Secret | undefined;
  readonly demoTarget: DemoTarget;
  readonly hlApiUrl: string;
  readonly hlMasterAddress: string | undefined;
  readonly hlMasterTestnetPrivateKey: Secret | undefined;
  readonly baseSepoliaRpcUrl: string;
  readonly baseSepoliaUsdc: string;
  readonly agentMode: AgentMode;
  readonly llmApiKey: Secret | undefined;
  readonly clawWatchIntervalSec: number;
  readonly clawWatchAutopause: boolean;
  readonly telegramAlertsEnabled: boolean;
  readonly telegramBotToken: Secret | undefined;
  readonly telegramChatId: string | undefined;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions {
  /** Environment to read (default: process.env). Values here win over the env file. */
  env?: EnvSource;
  /** Path of a dotenv file, or false to skip it (default: offchain/.env if it exists). */
  envFile?: string | false;
}

/** Parse a dotenv file without touching process.env. A missing file yields {}. */
export function readEnvFile(path: string = DEFAULT_ENV_FILE): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
}

/**
 * Load, validate and guard the configuration. Throws MainnetRefusedError
 * (ERR_MAINNET_REFUSED) or ConfigError; never returns a config that could
 * reach a mainnet.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const fileEnv = options.envFile === false ? {} : readEnvFile(options.envFile ?? DEFAULT_ENV_FILE);
  const env: EnvSource = { ...fileEnv, ...(options.env ?? process.env) };

  // Register secrets before anything can throw, so even error paths stay redacted.
  for (const [name, value] of Object.entries(env)) {
    if (isSecretEnvName(name) && value) registerSecret(value);
  }

  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const secret = (name: string): Secret | undefined => {
    const value = get(name);
    return value === undefined ? undefined : new Secret(value);
  };

  const nearNetwork = assertNearNetwork(get("NEAR_NETWORK"));

  // "Any URL": every *_URL variable in the environment is checked against the
  // mainnet pattern, not only the ones this code knows about.
  for (const [name, value] of Object.entries(env)) {
    if (name.endsWith("_URL") && value !== undefined && MAINNET_URL_PATTERN.test(value)) {
      throw new MainnetRefusedError(`${name} looks like a mainnet URL (${value.trim()})`);
    }
  }
  const nearRpcUrl = optionalUrl(get("NEAR_RPC_URL"), "NEAR_RPC_URL");
  const hlApiUrl = assertHlTestnetUrl(get("HL_API_URL") ?? HL_TESTNET_API_URL);
  const baseSepoliaRpcUrl = assertNoMainnetUrl(
    get("BASE_SEPOLIA_RPC_URL") ?? DEFAULT_BASE_SEPOLIA_RPC_URL,
    "BASE_SEPOLIA_RPC_URL",
  );

  const mpcContractId = assertMpcContractId(get("MPC_CONTRACT_ID") ?? TESTNET_MPC_CONTRACT_ID);
  const accountId = (name: string): string | undefined => {
    const value = get(name);
    return value === undefined ? undefined : assertTestnetAccountId(value, name);
  };

  const config: Config = {
    nearNetwork,
    nearRpcUrl,
    mpcContractId,
    clawguardContractId: accountId("CLAWGUARD_CONTRACT_ID"),
    ownerAccountId: accountId("OWNER_ACCOUNT_ID"),
    ownerPrivateKey: secret("OWNER_PRIVATE_KEY"),
    agentAccountId: accountId("AGENT_ACCOUNT_ID"),
    agentPrivateKey: secret("AGENT_PRIVATE_KEY"),
    guardianAccountId: accountId("GUARDIAN_ACCOUNT_ID"),
    guardianPrivateKey: secret("GUARDIAN_PRIVATE_KEY"),
    demoTarget: oneOf(get("DEMO_TARGET") ?? "hl", ["hl", "base"] as const, "DEMO_TARGET"),
    hlApiUrl,
    hlMasterAddress: evmAddress(get("HL_MASTER_ADDRESS"), "HL_MASTER_ADDRESS"),
    hlMasterTestnetPrivateKey: secret("HL_MASTER_TESTNET_PRIVATE_KEY"),
    baseSepoliaRpcUrl,
    baseSepoliaUsdc: evmAddress(get("BASE_SEPOLIA_USDC") ?? DEFAULT_BASE_SEPOLIA_USDC, "BASE_SEPOLIA_USDC"),
    agentMode: oneOf(get("AGENT_MODE") ?? "scripted", ["scripted", "llm"] as const, "AGENT_MODE"),
    llmApiKey: secret("LLM_API_KEY"),
    clawWatchIntervalSec: positiveInt(get("CLAW_WATCH_INTERVAL_SEC") ?? "15", "CLAW_WATCH_INTERVAL_SEC"),
    clawWatchAutopause: flag(get("CLAW_WATCH_AUTOPAUSE"), "CLAW_WATCH_AUTOPAUSE"),
    telegramAlertsEnabled: flag(get("TELEGRAM_ALERTS_ENABLED"), "TELEGRAM_ALERTS_ENABLED"),
    telegramBotToken: secret("TELEGRAM_BOT_TOKEN"),
    telegramChatId: get("TELEGRAM_CHAT_ID"),
  };
  return Object.freeze(config);
}

function oneOf<const T extends readonly string[]>(value: string, allowed: T, name: string): T[number] {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new ConfigError(`${name} must be one of ${allowed.join(" | ")}`);
  return match;
}

function optionalUrl(value: string | undefined, name: string): string | undefined {
  return value === undefined ? undefined : assertNoMainnetUrl(value, name);
}

function flag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new ConfigError(`${name} must be 0 or 1`);
}

function positiveInt(value: string, name: string): number {
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

function evmAddress(value: string, name: string): string;
function evmAddress(value: string | undefined, name: string): string | undefined;
function evmAddress(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new ConfigError(`${name} must be 0x + 40 hex characters`);
  return value;
}

/** Return a required value or throw a ConfigError naming the env variable. */
export function requireValue<T>(value: T | undefined, envName: string): T {
  if (value === undefined) throw new ConfigError(`${envName} is required for this command (set it in offchain/.env)`);
  return value;
}

/** The claw-guard contract id: the fixed sandbox id, or CLAWGUARD_CONTRACT_ID on testnet. */
export function clawguardContractId(config: Config): string {
  if (config.clawguardContractId !== undefined) return config.clawguardContractId;
  if (config.nearNetwork === "sandbox") return SANDBOX_IDS.contract;
  throw new ConfigError("CLAWGUARD_CONTRACT_ID is required when NEAR_NETWORK=testnet");
}

// ---------------------------------------------------------------------------
// Sandbox state (written by setup:sandbox)
// ---------------------------------------------------------------------------

export interface SandboxState {
  /** Local sandbox JSON-RPC URL, e.g. http://127.0.0.1:3030 */
  rpcUrl: string;
  contractId?: string;
  [key: string]: unknown;
}

export function readSandboxState(path: string = SANDBOX_STATE_FILE): SandboxState | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as SandboxState).rpcUrl !== "string") {
    throw new ConfigError(`${path} is not a valid sandbox state file`);
  }
  return parsed as SandboxState;
}

/**
 * NEAR RPC URL for this run: explicit override, then NEAR_RPC_URL, then (sandbox
 * only) the URL recorded by setup:sandbox. Always re-checked against mainnet URLs.
 */
export function resolveNearRpcUrl(config: Config, override?: string): string {
  const url =
    override ?? config.nearRpcUrl ?? (config.nearNetwork === "sandbox" ? readSandboxState()?.rpcUrl : undefined);
  if (url === undefined) {
    throw new ConfigError(
      config.nearNetwork === "sandbox"
        ? "No sandbox RPC URL: run `npm run setup:sandbox` first or pass --rpc"
        : "NEAR_RPC_URL is required when NEAR_NETWORK=testnet",
    );
  }
  return assertNoMainnetUrl(url, "NEAR RPC URL");
}
