// Dev-only helper. Testnet only (Base Sepolia, chain id 84532).
// Generates EIP-1559 ERC-20 transfer vectors with viem so the claw-guard
// contract's hand-rolled RLP encoder can be checked byte for byte.
//   node offchain/scripts/evm_vectors.mjs offchain/test/vectors
// The test key is derived at runtime from a public label; it is worthless.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  encodeFunctionData, keccak256, serializeTransaction, toBytes, parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CHAIN_ID = 84532;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const account = privateKeyToAccount(keccak256(toBytes("clawguard-test-vectors-only")));

const CASES = [
  // name, to, amount, nonce, gas, maxFee, maxPriority
  ["usdc_1_to_owner", "0x1111111111111111111111111111111111111111", 1000000n, 0n, 65000n, 1000000000n, 1000000n],
  ["usdc_small_nonce_7", "0x2222222222222222222222222222222222222222", 1n, 7n, 60000n, 120000000n, 0n],
  ["usdc_big_values", "0xbad0000000000000000000000000000000000bad", 340282366920938463463374607431768211455n, 1023n, 200000n, 100000000000n, 100000000000n],
  ["usdc_nonce_127_edge", "0x3333333333333333333333333333333333333333", 127n, 127n, 21000n, 128n, 127n],
  ["usdc_nonce_128_edge", "0x4444444444444444444444444444444444444444", 128n, 128n, 21001n, 256n, 255n],
];

const out = process.argv[2] ?? "offchain/test/vectors";
mkdirSync(out, { recursive: true });
const vectors = [];
for (const [name, to, amount, nonce, gas, maxFeePerGas, maxPriorityFeePerGas] of CASES) {
  const tx = {
    type: "eip1559", chainId: CHAIN_ID, nonce: Number(nonce), to: USDC, value: 0n,
    data: encodeFunctionData({ abi: erc20, functionName: "transfer", args: [to, amount] }),
    gas, maxFeePerGas, maxPriorityFeePerGas, accessList: [],
  };
  const unsigned = serializeTransaction(tx);
  const signedRaw = await account.signTransaction(tx);
  vectors.push({
    name,
    request: {
      token: "USDC", to, amount: amount.toString(), nonce: nonce.toString(), gas_limit: gas.toString(),
      max_fee_per_gas: maxFeePerGas.toString(), max_priority_fee_per_gas: maxPriorityFeePerGas.toString(),
    },
    chain_id: CHAIN_ID, token_address: USDC, data: tx.data,
    unsigned_tx: unsigned, payload_hash: keccak256(unsigned),
    signer: account.address.toLowerCase(), signed_tx: signedRaw,
  });
}
const meta = { generator: "offchain/scripts/evm_vectors.mjs", lib: "viem", chain_id: CHAIN_ID,
  note: "Testnet only. Test key derived from a public label; worthless." };
writeFileSync(join(out, "evm_transfers.json"), JSON.stringify({ meta, vectors }, null, 2) + "\n");
console.log(`wrote ${vectors.length} EVM transfer vectors to ${out}`);
