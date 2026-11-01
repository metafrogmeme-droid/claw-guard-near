// CLI behaviour that needs no network: derive (sandbox / offline), gen-testnet-evm-key
// (writes only to the env file, never prints the key; its atomic write, D-15, is covered in
// envfile_atomic.test.ts), and the env-file helpers.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hex, recoverTypedDataAddress, serializeSignature } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as approveMain } from "../src/cli/approve_hl_agent.js";
import { main as deriveMain } from "../src/cli/derive.js";
import { main as genKeyMain } from "../src/cli/gen_testnet_evm_key.js";
import { ENV_EXAMPLE_FILE } from "../src/config.js";
import { envFileValue, upsertEnvValues } from "../src/envfile.js";
import * as hlModule from "../src/hl.js";
import { type ApproveAgentAction, approveAgentDigest, approveAgentTypedData } from "../src/hl.js";
import { loadVectors } from "./helpers.js";

/** Capture console output for the duration of a test. */
function captureConsole(): string[] {
  const out: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      out.push(args.map(String).join(" "));
    });
  }
  return out;
}

beforeEach(() => {
  // Isolate from any developer offchain/.env: the real environment wins over the file.
  vi.stubEnv("NEAR_NETWORK", "sandbox");
  vi.stubEnv("CLAWGUARD_CONTRACT_ID", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("derive CLI", () => {
  it("sandbox: prints the mock-mpc address for clawguard.test.near", async () => {
    const out = captureConsole();
    await expect(deriveMain(["--path", "hl-testnet-1"])).resolves.toBe(0);
    expect(out[0]).toBe("0xb966992b0783f42b2f78a7a94c8f190f03758a96");
  });

  it("testnet --offline: local MPC math (matches chainsig.js vector)", async () => {
    vi.stubEnv("NEAR_NETWORK", "testnet");
    const { vectors } = loadVectors<{ predecessor: string; path: string; evm_address: string }>("derive_mpc.json");
    const v = vectors[1];
    if (v === undefined) throw new Error("vector missing");
    const out = captureConsole();
    await expect(deriveMain(["--path", v.path, "--contract", v.predecessor, "--offline"])).resolves.toBe(0);
    expect(out[0]).toBe(v.evm_address);
  });

  it("refuses a mainnet contract id and bad paths", async () => {
    captureConsole();
    await expect(deriveMain(["--path", "hl-testnet-1", "--contract", "clawguard.near"])).rejects.toThrow(/ERR_MAINNET_REFUSED/);
    await expect(deriveMain(["--path", "../etc"])).resolves.toBe(2);
    await expect(deriveMain(["--bogus"])).rejects.toThrow(/Unknown option/);
  });

  it("refuses NEAR_NETWORK=mainnet before doing anything", async () => {
    vi.stubEnv("NEAR_NETWORK", "mainnet");
    await expect(deriveMain(["--path", "hl-testnet-1"])).rejects.toThrow(/^ERR_MAINNET_REFUSED/);
  });
});

describe("approve-hl-agent CLI", () => {
  // Regression: the dry run used to sign with the master key and print a ready-to-POST request.
  it("dry run: prints the unsigned Testnet approveAgent action and its digest, signs and sends nothing", async () => {
    const key = generatePrivateKey();
    vi.stubEnv("NEAR_NETWORK", "testnet");
    vi.stubEnv("HL_MASTER_TESTNET_PRIVATE_KEY", key);
    vi.stubEnv("HL_MASTER_ADDRESS", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    const signSpy = vi.spyOn(hlModule, "buildApproveAgentRequest");
    const out = captureConsole();
    const agent = `0x${"ab".repeat(20)}`;
    await expect(approveMain(["--agent", agent, "--valid-days", "7"])).resolves.toBe(0);
    const printed = out.join("\n");
    expect(printed).not.toContain(key.slice(2));
    expect(printed).toContain("Dry run, nothing signed or sent");
    expect(printed).not.toMatch(/"signature"|"r":|"s":|"v":/);
    expect(signSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    const action = JSON.parse(printed.slice(printed.indexOf("{"), printed.lastIndexOf("}") + 1)) as ApproveAgentAction;
    expect(action).toMatchObject({
      type: "approveAgent",
      agentAddress: "0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB",
      hyperliquidChain: "Testnet",
      signatureChainId: "0x66eee",
    });
    expect(String(action.agentName)).toMatch(/^clawguard valid_until \d{13}$/);
    expect(printed).toContain(`EIP-712 digest the master key would sign: ${approveAgentDigest(action)}`);
  });

  it("--yes signs with the master key and POSTs the signed request", async () => {
    const key = generatePrivateKey();
    vi.stubEnv("NEAR_NETWORK", "testnet");
    vi.stubEnv("HL_MASTER_TESTNET_PRIVATE_KEY", key);
    vi.stubEnv("HL_MASTER_ADDRESS", "");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ status: "ok", response: { type: "default" } }), { status: 200 }));
    const signSpy = vi.spyOn(hlModule, "buildApproveAgentRequest");
    captureConsole();
    await expect(approveMain(["--agent", `0x${"ab".repeat(20)}`, "--yes"])).resolves.toBe(0);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(typeof init?.body).toBe("string");
    const body = JSON.parse(init?.body as string) as { action: ApproveAgentAction; signature: { r: Hex; s: Hex; v: number } };
    const signer = await recoverTypedDataAddress({
      ...approveAgentTypedData(body.action),
      signature: serializeSignature({ r: body.signature.r, s: body.signature.s, v: BigInt(body.signature.v) }),
    });
    expect(signer).toBe(privateKeyToAddress(key));
  });

  it("refuses a master address that does not match the key, and sandbox mode", async () => {
    captureConsole();
    vi.stubEnv("HL_MASTER_TESTNET_PRIVATE_KEY", generatePrivateKey());
    await expect(approveMain(["--agent", `0x${"ab".repeat(20)}`])).rejects.toThrow(/NEAR_NETWORK=testnet/);
    vi.stubEnv("NEAR_NETWORK", "testnet");
    vi.stubEnv("HL_MASTER_ADDRESS", `0x${"12".repeat(20)}`);
    await expect(approveMain(["--agent", `0x${"ab".repeat(20)}`])).rejects.toThrow(/does not match/);
  });
});

describe("env file helpers", () => {
  const example = readFileSync(ENV_EXAMPLE_FILE, "utf8");

  it("replaces a value and keeps the inline comment and the rest of the file", () => {
    const next = upsertEnvValues(example, { HL_MASTER_ADDRESS: `0x${"ab".repeat(20)}` });
    expect(next).toContain(`HL_MASTER_ADDRESS=0x${"ab".repeat(20)}              # testnet-only master (0x...)`);
    expect(next.split("\n").length).toBe(example.split("\n").length);
    expect(envFileValue(next, "HL_MASTER_ADDRESS")).toBe(`0x${"ab".repeat(20)}`);
    expect(envFileValue(next, "OWNER_PRIVATE_KEY")).toBeUndefined();
  });

  it("appends missing names and rejects unsafe values", () => {
    expect(upsertEnvValues("A=1\n", { NEW_NAME: "x" })).toBe("A=1\nNEW_NAME=x\n");
    expect(() => upsertEnvValues("", { A: "has space" })).toThrow();
    expect(() => upsertEnvValues("", { "bad-name": "x" })).toThrow();
  });
});

describe("gen-testnet-evm-key CLI", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clawguard-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the key only into the env file (mode 600) and prints only the address", () => {
    const envPath = join(dir, ".env");
    const out = captureConsole();
    expect(genKeyMain([], envPath)).toBe(0);

    const written = readFileSync(envPath, "utf8");
    const key = envFileValue(written, "HL_MASTER_TESTNET_PRIVATE_KEY");
    const address = envFileValue(written, "HL_MASTER_ADDRESS");
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(address).toBe(privateKeyToAddress(key as `0x${string}`));
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    // The file is the .env.example template filled in: every other line is unchanged.
    expect(written.split("\n").length).toBe(readFileSync(ENV_EXAMPLE_FILE, "utf8").split("\n").length);

    const printed = out.join("\n");
    expect(printed).not.toContain(key);
    expect(printed).not.toContain((key ?? "").slice(2));
    expect(printed).toContain(`HL_MASTER_ADDRESS=${address ?? ""}`);
    expect(out).toContain("The server never holds mainnet keys or signs for users."); // copy rule: wherever keys are explained
  });

  it("refuses to replace an existing key without --force", () => {
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "NEAR_NETWORK=sandbox\n");
    captureConsole();
    expect(genKeyMain([], envPath)).toBe(0);
    const firstKey = envFileValue(readFileSync(envPath, "utf8"), "HL_MASTER_TESTNET_PRIVATE_KEY");
    expect(genKeyMain([], envPath)).toBe(1);
    expect(envFileValue(readFileSync(envPath, "utf8"), "HL_MASTER_TESTNET_PRIVATE_KEY")).toBe(firstKey);
    expect(genKeyMain(["--force"], envPath)).toBe(0);
    expect(envFileValue(readFileSync(envPath, "utf8"), "HL_MASTER_TESTNET_PRIVATE_KEY")).not.toBe(firstKey);
  });

  it.each([undefined, "sandbox", "testnet"])(
    "keeps its network rules: NEAR_NETWORK=%s is fine (D-16 is for the NEAR key command only); mainnet is not",
    (network) => {
      const envPath = join(dir, ".env");
      vi.stubEnv("NEAR_NETWORK", network);
      captureConsole();
      expect(genKeyMain([], envPath)).toBe(0);
      expect(envFileValue(readFileSync(envPath, "utf8"), "HL_MASTER_TESTNET_PRIVATE_KEY")).toMatch(/^0x[0-9a-f]{64}$/);
      vi.stubEnv("NEAR_NETWORK", "mainnet");
      const before = readFileSync(envPath, "utf8");
      expect(() => genKeyMain(["--force"], envPath)).toThrow(/^ERR_MAINNET_REFUSED/);
      expect(readFileSync(envPath, "utf8")).toBe(before);
    },
  );

  it("never replaces an existing key without --force when a later empty line hides it (read-back check, file unchanged)", () => {
    const envPath = join(dir, ".env");
    const existing = generatePrivateKey(); // made at run time, never committed
    const content = `NEAR_NETWORK=sandbox\nHL_MASTER_TESTNET_PRIVATE_KEY=${existing}\nHL_MASTER_TESTNET_PRIVATE_KEY=\n`;
    writeFileSync(envPath, content, { mode: 0o600 });
    const out = captureConsole();
    let err: unknown;
    try {
      genKeyMain([], envPath);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("would not read back");
    expect(readFileSync(envPath, "utf8")).toBe(content);
    expect(readdirSync(dir)).toEqual([".env"]);
    expect(`${(err as Error).message}\n${out.join("\n")}`).not.toContain(existing.slice(2));
  });
});
