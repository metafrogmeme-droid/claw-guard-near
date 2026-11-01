// Testnet guards (ERR_MAINNET_REFUSED) and secret redaction.
import { inspect } from "node:util";
import { KeyPair } from "near-api-js";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorText } from "../src/cli/common.js";
import { TESTNET_MPC_ROOT_PUBLIC_KEY } from "../src/derive.js";
import {
  ConfigError,
  ENV_EXAMPLE_FILE,
  ERR_MAINNET_REFUSED,
  MainnetRefusedError,
  REDACTED,
  Secret,
  assertBaseSepoliaChainId,
  assertNearChainId,
  isSecretEnvName,
  loadConfig,
  log,
  readEnvFile,
  redact,
  resolveNearRpcUrl,
} from "../src/config.js";

const load = (env: Record<string, string>) => loadConfig({ env, envFile: false });
const refused = (env: Record<string, string>) => {
  expect(() => load(env)).toThrow(MainnetRefusedError);
  expect(() => load(env)).toThrow(/^ERR_MAINNET_REFUSED: /);
};

describe("defaults", () => {
  it("works with no env at all (sandbox, testnet URLs)", () => {
    const cfg = load({});
    expect(cfg.nearNetwork).toBe("sandbox");
    expect(cfg.hlApiUrl).toBe("https://api.hyperliquid-testnet.xyz");
    expect(cfg.mpcContractId).toBe("v1.signer-prod.testnet");
    expect(cfg.baseSepoliaRpcUrl).toBe("https://sepolia.base.org");
    expect(cfg.demoTarget).toBe("hl");
    expect(cfg.telegramAlertsEnabled).toBe(false);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it("accepts .env.example as shipped (inline comments, empty secrets)", () => {
    const fileEnv = readEnvFile(ENV_EXAMPLE_FILE);
    expect(Object.keys(fileEnv)).toHaveLength(23);
    for (const [name, value] of Object.entries(fileEnv)) {
      if (isSecretEnvName(name)) expect(value, name).toBe("");
    }
    const cfg = loadConfig({ env: {}, envFile: ENV_EXAMPLE_FILE });
    expect(cfg.nearNetwork).toBe("sandbox");
    expect(cfg.baseSepoliaUsdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(cfg.ownerPrivateKey).toBeUndefined();
    expect(cfg.clawWatchIntervalSec).toBe(15);
  });

  it("real environment wins over the env file", () => {
    const cfg = loadConfig({ env: { DEMO_TARGET: "base" }, envFile: ENV_EXAMPLE_FILE });
    expect(cfg.demoTarget).toBe("base");
  });

  it("missing env file is fine", () => {
    expect(loadConfig({ env: {}, envFile: "/nonexistent/clawguard/.env" }).nearNetwork).toBe("sandbox");
  });
});

describe("ERR_MAINNET_REFUSED guards", () => {
  it("NEAR_NETWORK must be sandbox or testnet", () => {
    refused({ NEAR_NETWORK: "mainnet" });
    refused({ NEAR_NETWORK: "localnet" });
    refused({ NEAR_NETWORK: "Testnet" });
    expect(load({ NEAR_NETWORK: "testnet" }).nearNetwork).toBe("testnet");
  });

  it("HL_API_URL must be exactly the testnet URL", () => {
    refused({ HL_API_URL: "https://api.hyperliquid.xyz" });
    refused({ HL_API_URL: "https://api.hyperliquid.xyz/" });
    refused({ HL_API_URL: "https://api.hyperliquid-testnet.xyz.example.com" });
    refused({ HL_API_URL: "http://localhost:3001" });
  });

  it("MPC_CONTRACT_ID v1.signer (mainnet) and non-testnet ids are refused", () => {
    refused({ MPC_CONTRACT_ID: "v1.signer" });
    refused({ MPC_CONTRACT_ID: "signer.near" });
    expect(load({ MPC_CONTRACT_ID: "mock-mpc.test.near" }).mpcContractId).toBe("mock-mpc.test.near");
  });

  it("mainnet RPC URLs are refused, for any *_URL variable", () => {
    refused({ NEAR_NETWORK: "testnet", NEAR_RPC_URL: "https://rpc.mainnet.near.org" });
    refused({ NEAR_RPC_URL: "https://free.rpc.fastnear.com/MAINNET" });
    refused({ BASE_SEPOLIA_RPC_URL: "https://mainnet.base.org" });
    refused({ SOME_OTHER_URL: "https://eth-mainnet.example.org" });
    expect(load({ NEAR_NETWORK: "testnet", NEAR_RPC_URL: "https://near-testnet.drpc.org" }).nearRpcUrl).toBe(
      "https://near-testnet.drpc.org",
    );
  });

  it("NEAR account ids must be testnet or sandbox ids", () => {
    refused({ CLAWGUARD_CONTRACT_ID: "clawguard.alice.near" });
    refused({ OWNER_ACCOUNT_ID: "alice.near" });
    refused({ AGENT_ACCOUNT_ID: "a".repeat(64) }); // implicit ids exist on mainnet too
    expect(load({ AGENT_ACCOUNT_ID: "agent-1.alice.testnet" }).agentAccountId).toBe("agent-1.alice.testnet");
    expect(load({ AGENT_ACCOUNT_ID: "agent-1.test.near" }).agentAccountId).toBe("agent-1.test.near");
  });

  it("NEAR RPC chain_id check", () => {
    expect(assertNearChainId("testnet", "testnet")).toBe("testnet");
    expect(assertNearChainId("test-chain-x1y2", "sandbox")).toBe("test-chain-x1y2");
    expect(() => assertNearChainId("mainnet", "testnet")).toThrow(MainnetRefusedError);
    expect(() => assertNearChainId("mainnet", "sandbox")).toThrow(MainnetRefusedError);
    expect(() => assertNearChainId("localnet", "testnet")).toThrow(MainnetRefusedError);
  });

  describe("Base path eth_chainId", () => {
    const rpc = "https://sepolia.base.org";
    const answer = (body: unknown, status = 200) => vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

    it("passes only for 0x14a34 (84532)", async () => {
      const fetchImpl = answer({ jsonrpc: "2.0", id: 1, result: "0x14a34" });
      await expect(assertBaseSepoliaChainId(rpc, fetchImpl)).resolves.toBeUndefined();
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(rpc);
      expect(JSON.parse(init.body as string)).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
    });

    it.each(["0x2105", "0x1", "0xaa36a7", 84532])("refuses chain id %s", async (result) => {
      await expect(assertBaseSepoliaChainId(rpc, answer({ result }))).rejects.toThrow(ERR_MAINNET_REFUSED);
    });

    it("fails closed on HTTP errors and missing results", async () => {
      await expect(assertBaseSepoliaChainId(rpc, answer({}, 500))).rejects.toThrow(/HTTP 500/);
      await expect(assertBaseSepoliaChainId(rpc, answer({ error: { message: "x" } }))).rejects.toThrow(ERR_MAINNET_REFUSED);
    });

    it("never calls a mainnet-looking RPC", async () => {
      const fetchImpl = answer({ result: "0x14a34" });
      await expect(assertBaseSepoliaChainId("https://mainnet.base.org", fetchImpl)).rejects.toThrow(MainnetRefusedError);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe("other config validation", () => {
  it("rejects bad enums, flags and numbers with ConfigError", () => {
    expect(() => load({ DEMO_TARGET: "solana" })).toThrow(ConfigError);
    expect(() => load({ AGENT_MODE: "auto" })).toThrow(ConfigError);
    expect(() => load({ CLAW_WATCH_AUTOPAUSE: "yes" })).toThrow(ConfigError);
    expect(() => load({ CLAW_WATCH_INTERVAL_SEC: "0" })).toThrow(ConfigError);
    expect(() => load({ HL_MASTER_ADDRESS: "0x123" })).toThrow(ConfigError);
    expect(() => load({ NEAR_RPC_URL: "https://user:pw@near-testnet.drpc.org" })).toThrow(ConfigError);
  });

  it("testnet mode needs NEAR_RPC_URL", () => {
    expect(() => resolveNearRpcUrl(load({ NEAR_NETWORK: "testnet" }))).toThrow(/NEAR_RPC_URL is required/);
    expect(resolveNearRpcUrl(load({ NEAR_NETWORK: "testnet" }), "https://near-testnet.drpc.org")).toBe(
      "https://near-testnet.drpc.org",
    );
    expect(() => resolveNearRpcUrl(load({}), "https://rpc.mainnet.near.org")).toThrow(MainnetRefusedError);
  });
});

describe("secrets never reach logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Generated at runtime so no key-shaped literal lives in the repo.
  const nearKey = KeyPair.fromRandom("ed25519").toString();
  const evmKey = generatePrivateKey();
  const botToken = `${"8".repeat(9)}:${"tK".repeat(17)}x`;
  const llmKey = `llm-${"q".repeat(30)}`;
  const env = {
    NEAR_NETWORK: "testnet",
    OWNER_PRIVATE_KEY: nearKey,
    AGENT_PRIVATE_KEY: KeyPair.fromRandom("ed25519").toString(),
    HL_MASTER_TESTNET_PRIVATE_KEY: evmKey,
    TELEGRAM_BOT_TOKEN: botToken,
    LLM_API_KEY: llmKey,
  };
  const secrets = [nearKey, env.AGENT_PRIVATE_KEY, evmKey, botToken, llmKey];
  const leaks = (text: string) => secrets.filter((s) => text.includes(s));

  it("classifies secret env names", () => {
    expect(["OWNER_PRIVATE_KEY", "HL_MASTER_TESTNET_PRIVATE_KEY", "TELEGRAM_BOT_TOKEN", "LLM_API_KEY"].every(isSecretEnvName)).toBe(true);
    expect(["OWNER_ACCOUNT_ID", "TELEGRAM_CHAT_ID", "HL_MASTER_ADDRESS"].some(isSecretEnvName)).toBe(false);
  });

  it("Config prints, serialises and inspects without secrets", () => {
    const cfg = load(env);
    expect(cfg.ownerPrivateKey?.reveal()).toBe(nearKey);
    expect(leaks(JSON.stringify(cfg))).toEqual([]);
    expect(leaks(inspect(cfg, { depth: 5 }))).toEqual([]);
    expect(leaks(String(cfg.ownerPrivateKey))).toEqual([]);
    expect(leaks(`${String(cfg.llmApiKey)}`)).toEqual([]);
    expect(JSON.stringify(cfg)).toContain(REDACTED);
  });

  it("log.* redacts every registered secret", () => {
    load(env);
    const out: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        out.push(args.map(String).join(" "));
      });
    }
    log.info("owner key", nearKey, { nested: { evmKey } });
    log.warn(`token=${botToken}`);
    log.error(new Error(`llm call failed with key ${llmKey}`));
    expect(out).toHaveLength(3);
    expect(leaks(out.join("\n"))).toEqual([]);
    expect(out.join("\n")).toContain(REDACTED);
  });

  it("guard errors and CLI error text carry no secrets", () => {
    let message = "";
    try {
      load({ ...env, NEAR_NETWORK: "mainnet" });
    } catch (err) {
      message = errorText(err);
    }
    expect(message).toMatch(/^ERR_MAINNET_REFUSED: /);
    expect(leaks(message)).toEqual([]);
    expect(leaks(errorText(new Error(`boom ${evmKey} ${nearKey}`)))).toEqual([]);
  });

  it("pattern redaction catches unregistered NEAR secret keys and bot tokens, keeps public keys", () => {
    const unregistered = KeyPair.fromRandom("ed25519");
    const publicKey = unregistered.getPublicKey().toString();
    const token = `${"7".repeat(10)}:${"Zz".repeat(17)}_`;
    const text = redact(`sk=${unregistered.toString()} pk=${publicKey} url=https://api.telegram.org/bot${token}/sendMessage`);
    expect(text).not.toContain(unregistered.toString());
    expect(text).not.toContain(token);
    expect(text).toContain(publicKey);
  });

  it("pattern redaction: secp256k1 secret keys go, secp256k1 public keys (e.g. the MPC root key) stay", () => {
    const kp = KeyPair.fromRandom("secp256k1");
    const text = redact(`sk=${kp.toString()} pk=${kp.getPublicKey().toString()} root=${TESTNET_MPC_ROOT_PUBLIC_KEY}`);
    expect(text).not.toContain(kp.toString().slice("secp256k1:".length));
    expect(text).toContain(kp.getPublicKey().toString());
    expect(text).toContain(TESTNET_MPC_ROOT_PUBLIC_KEY);
  });

  it("Secret hides its value from every stringification", () => {
    const s = new Secret(`value-${"z".repeat(20)}`);
    expect(String(s)).toBe(REDACTED);
    expect(JSON.stringify({ s })).toBe(`{"s":"${REDACTED}"}`);
    expect(inspect(s)).toBe(`Secret(${REDACTED})`);
  });
});
