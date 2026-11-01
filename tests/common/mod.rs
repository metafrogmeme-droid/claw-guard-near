//! Shared near-workspaces helpers for the Claw Guard sandbox tests.
//! Sandbox only: a local NEAR node with root account `test.near`. Not audited.
//! Every key here is a fresh sandbox key or the mock-mpc test key: worthless, never use them
//! anywhere else.
//!
//! [`setup`] gives a ready sandbox (fixed sandbox ids):
//! * `mock-mpc.test.near`: mock MPC signer, deployed and initialized (`new {}`).
//! * `clawguard.test.near`: the guard, deployed and initialized in one batch from its own
//!   account (`new` is `#[private]`), owner `owner.test.near`, guardian `guardian.test.near`.
//! * `owner.test.near`: full-access key (the trusted owner).
//! * `agent-1.test.near`: created by `test.near` in ONE batch (CreateAccount + Transfer +
//!   AddKey) with ONLY a function-call key: receiver `clawguard.test.near`, methods
//!   `["propose_order"]`, allowance 1 NEAR.
//! * `guardian.test.near`: same pattern, function-call key for `["pause"]` only.
//! * the agent registered with [`default_rules`].

// Each test binary uses a different subset of these helpers.
#![allow(dead_code)]

use anyhow::{Context, Result, anyhow, bail, ensure};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use near_workspaces::network::Sandbox as SandboxNetwork;
use near_workspaces::operations::Function;
use near_workspaces::result::{ExecutionFinalResult, ExecutionOutcome};
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{AccessKey, Account, AccountId, Contract, Worker};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

// ---- ids ----

pub const ROOT_ID: &str = "test.near";
pub const OWNER_ID: &str = "owner.test.near";
pub const CONTRACT_ID: &str = "clawguard.test.near";
pub const MPC_ID: &str = "mock-mpc.test.near";
pub const AGENT_ID: &str = "agent-1.test.near";
pub const GUARDIAN_ID: &str = "guardian.test.near";

pub const HL_PATH: &str = "hl-testnet-1";
pub const BASE_PATH: &str = "base-sepolia-1";
/// Base Sepolia chain id (hardcoded in the contract).
pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84_532;

// ---- init and rules ----

/// `sign_gas_tgas` in the guard's init args: static gas for the MPC `sign` call.
pub const SIGN_GAS_TGAS: u64 = 100;
pub const LOOSEN_DELAY_SEC: u64 = 600;
/// Gas an agent attaches to `propose_order` (300 Tgas).
pub const PROPOSE_GAS: Gas = Gas::from_tgas(300);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

pub const USDC_SYMBOL: &str = "USDC";
/// Circle test USDC on Base Sepolia, lowercase.
pub const USDC_ADDRESS: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
/// The one allowed receiver in [`default_rules`].
pub const RECEIVER: &str = "0x1111111111111111111111111111111111111111";

const NS_PER_MS: u64 = 1_000_000;
const NS_PER_DAY: u64 = 86_400 * 1_000_000_000;

// ---- balances (sandbox units) ----

const CONTRACT_BALANCE: NearToken = NearToken::from_near(20);
const MPC_BALANCE: NearToken = NearToken::from_near(10);
const OWNER_BALANCE: NearToken = NearToken::from_near(20);
/// The agent account gets 0.5 NEAR; its key may spend at most 1 NEAR on gas.
const AGENT_BALANCE: NearToken = NearToken::from_millinear(500);
const KEY_ALLOWANCE: NearToken = NearToken::from_near(1);
const GUARDIAN_BALANCE: NearToken = NearToken::from_millinear(500);

/// A deployed sandbox: accounts, contracts and the keys described in the module docs.
pub struct Sandbox {
    pub worker: Worker<SandboxNetwork>,
    /// `test.near`.
    pub root: Account,
    /// `owner.test.near`, full-access key.
    pub owner: Account,
    /// `clawguard.test.near`. Its signer is the contract account's own full-access key.
    pub guard: Contract,
    /// `mock-mpc.test.near`. Its signer is the mock's own key (needed for `set_fail`).
    pub mpc: Contract,
    /// `agent-1.test.near`; the signer is its function-call key (the only key it has).
    pub agent: Account,
    /// `guardian.test.near`; the signer is its function-call key for `pause`.
    pub guardian: Account,
}

/// Deploys everything and registers `agent-1.test.near` with [`default_rules`].
pub async fn setup() -> Result<Sandbox> {
    let sandbox = deploy().await?;
    let expires_at_ns = sandbox.now_ns().await? + 7 * NS_PER_DAY;
    let result = sandbox
        .register_agent(AGENT_ID, &default_rules(expires_at_ns))
        .await?;
    ensure!(
        result.is_success(),
        "register_agent failed: {:?}",
        result.into_result().err()
    );
    Ok(sandbox)
}

/// Deploys both contracts and creates the accounts and keys, without registering an agent.
/// The sandbox node every test starts (same as `scripts/sandbox_env.sh` and the demo).
pub const SANDBOX_NODE_VERSION: &str = "2.14.0";

pub async fn deploy() -> Result<Sandbox> {
    let wasm = claw_guard_tests::contract_wasm().map_err(|e| anyhow!(e))?;
    let claw_guard_wasm = std::fs::read(&wasm.claw_guard)
        .with_context(|| format!("reading {}", wasm.claw_guard.display()))?;
    let mock_mpc_wasm = std::fs::read(&wasm.mock_mpc)
        .with_context(|| format!("reading {}", wasm.mock_mpc.display()))?;

    // near-workspaces 0.23.0 defaults to neard 2.13.4; the tests, the demo and scripts/sandbox_env.sh
    // all use the sandbox node 2.14.0 (D-21 pins near-workspaces 0.23.0 with near-sdk 5.29.1).
    let worker = near_workspaces::sandbox_with_version(SANDBOX_NODE_VERSION).await?;
    let root = worker.root_account()?;
    ensure!(
        root.id().as_str() == ROOT_ID,
        "unexpected root {}",
        root.id()
    );

    let mpc = deploy_and_init(
        &worker,
        &root,
        "mock-mpc",
        MPC_BALANCE,
        &mock_mpc_wasm,
        json!({}),
    )
    .await?;
    let init_args = json!({
        "owner_id": OWNER_ID,
        "guardian_id": GUARDIAN_ID,
        "mpc_contract_id": MPC_ID,
        "sign_deposit_yocto": "1",
        "sign_gas_tgas": SIGN_GAS_TGAS,
        "loosen_delay_sec": LOOSEN_DELAY_SEC,
    });
    let guard = deploy_and_init(
        &worker,
        &root,
        "clawguard",
        CONTRACT_BALANCE,
        &claw_guard_wasm,
        init_args,
    )
    .await?;
    ensure!(guard.id().as_str() == CONTRACT_ID && mpc.id().as_str() == MPC_ID);

    let owner = root
        .create_subaccount("owner")
        .initial_balance(OWNER_BALANCE)
        .transact()
        .await?
        .into_result()?;
    let agent = create_function_call_account(
        &worker,
        &root,
        AGENT_ID,
        AGENT_BALANCE,
        guard.id(),
        &["propose_order"],
    )
    .await?;
    let guardian = create_function_call_account(
        &worker,
        &root,
        GUARDIAN_ID,
        GUARDIAN_BALANCE,
        guard.id(),
        &["pause"],
    )
    .await?;

    Ok(Sandbox {
        worker,
        root,
        owner,
        guard,
        mpc,
        agent,
        guardian,
    })
}

/// Creates `<name>.test.near` with a full-access key, then deploys `wasm` and calls
/// `new(init_args)` in one batch signed by the new account itself.
async fn deploy_and_init(
    worker: &Worker<SandboxNetwork>,
    root: &Account,
    name: &str,
    balance: NearToken,
    wasm: &[u8],
    init_args: Value,
) -> Result<Contract> {
    let account = root
        .create_subaccount(name)
        .initial_balance(balance)
        .transact()
        .await?
        .into_result()?;
    let result = account
        .batch(account.id())
        .deploy(wasm)
        .call(
            Function::new("new")
                .args_json(init_args)
                .gas(Gas::from_tgas(30)),
        )
        .transact()
        .await?;
    ensure!(
        result.is_success(),
        "deploy + init of {} failed: {:?}",
        account.id(),
        result.into_result().err()
    );
    Ok(Contract::from_secret_key(
        account.id().clone(),
        account.secret_key().clone(),
        worker,
    ))
}

/// Creates `account_id` (a direct sub-account of `test.near`) in ONE batch transaction:
/// CreateAccount + Transfer + AddKey(function-call key for `receiver` / `methods`, allowance
/// 1 NEAR). The account never has a full-access key. Returns it with that key as signer.
pub async fn create_function_call_account(
    worker: &Worker<SandboxNetwork>,
    root: &Account,
    account_id: &str,
    balance: NearToken,
    receiver: &AccountId,
    methods: &[&str],
) -> Result<Account> {
    let account_id: AccountId = account_id.parse()?;
    let key = SecretKey::from_random(KeyType::ED25519);
    let result = root
        .batch(&account_id)
        .create_account()
        .transfer(balance)
        .add_key(
            key.public_key(),
            AccessKey::function_call_access(receiver, methods, Some(KEY_ALLOWANCE)),
        )
        .transact()
        .await?;
    ensure!(
        result.is_success(),
        "creating {account_id} failed: {:?}",
        result.into_result().err()
    );
    Ok(Account::from_secret_key(account_id, key, worker))
}

impl Sandbox {
    /// Current block timestamp (ns).
    pub async fn now_ns(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    /// Current block timestamp (ms): a fresh HL `nonce_ms` is this plus a small offset.
    pub async fn now_ms(&self) -> Result<u64> {
        Ok(self.now_ns().await? / NS_PER_MS)
    }

    /// Owner calls `register_agent` with 1 yoctoNEAR.
    pub async fn register_agent(
        &self,
        agent_id: &str,
        rules: &Value,
    ) -> Result<ExecutionFinalResult> {
        Ok(self
            .owner
            .call(self.guard.id(), "register_agent")
            .args_json(json!({"agent_id": agent_id, "rules": rules}))
            .deposit(ONE_YOCTO)
            .transact()
            .await?)
    }

    /// The agent calls `propose_order({"proposal": proposal})` with 300 Tgas.
    pub async fn propose(&self, proposal: &Value) -> Result<ExecutionFinalResult> {
        self.propose_with_gas(proposal, PROPOSE_GAS).await
    }

    pub async fn propose_with_gas(
        &self,
        proposal: &Value,
        gas: Gas,
    ) -> Result<ExecutionFinalResult> {
        Ok(self
            .agent
            .call(self.guard.id(), "propose_order")
            .args_json(json!({"proposal": proposal}))
            .gas(gas)
            .transact()
            .await?)
    }

    /// `get_receipt({"id": "<id>"})`.
    pub async fn receipt(&self, id: &str) -> Result<Value> {
        self.view_guard("get_receipt", json!({"id": id})).await
    }

    /// `get_rules({"agent_id": "agent-1.test.near"})`.
    pub async fn agent_state(&self) -> Result<Value> {
        self.view_guard("get_rules", json!({"agent_id": AGENT_ID}))
            .await
    }

    pub async fn status(&self) -> Result<Value> {
        self.view_guard("get_status", json!({})).await
    }

    pub async fn view_guard(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.guard.view(method).args_json(args).await?.json()?)
    }

    /// Successful `sign` calls the mock has served.
    pub async fn sign_count(&self) -> Result<u64> {
        Ok(self.mpc.view("sign_count").await?.json()?)
    }

    /// The mock's EVM address for (`predecessor`, `path`).
    pub async fn derived_address(&self, predecessor: &str, path: &str) -> Result<String> {
        Ok(self
            .mpc
            .view("derived_address")
            .args_json(json!({"predecessor": predecessor, "path": path}))
            .await?
            .json()?)
    }

    /// Makes the mock's `sign` panic (or work again). Signed by the mock account itself.
    pub async fn set_mpc_fail(&self, fail: bool) -> Result<()> {
        let result = self
            .mpc
            .call("set_fail")
            .args_json(json!({"fail": fail}))
            .transact()
            .await?;
        ensure!(
            result.is_success(),
            "set_fail failed: {:?}",
            result.into_result().err()
        );
        Ok(())
    }
}

// ---- rules and proposals (wire JSON, see the R1 interface notes) ----

/// The unit-test fixture rules plus `sz_decimals` (BTC 5, ETH 4), expiring at
/// `expires_at_ns`: HL markets BTC (asset 3, max size 0.01) and ETH (asset 4, max size 0.1),
/// per-order notional cap 1000 quote units, leverage up to 3x, USDC on Base Sepolia (5 per
/// transfer) to one receiver, daily cap 2000 quote units, 10 orders per day.
pub fn default_rules(expires_at_ns: u64) -> Value {
    json!({
        "targets": ["HlTestnet", "BaseSepolia"],
        "markets": [
            {"name": "BTC", "asset": 3, "max_order_sz": "0.01", "sz_decimals": 5},
            {"name": "ETH", "asset": 4, "max_order_sz": "0.1", "sz_decimals": 4}
        ],
        "max_order_notional": "1000000000",
        "max_leverage": 3,
        "tokens": [
            {"symbol": USDC_SYMBOL, "address": USDC_ADDRESS, "decimals": 6, "max_per_order": "5000000"}
        ],
        "receivers": [RECEIVER],
        "daily_cap": "2000000000",
        "max_orders_per_day": 10,
        "expires_at_ns": expires_at_ns.to_string(),
        "reduce_only_required": false
    })
}

/// An HL limit order proposal (Gtc, not reduce-only).
pub fn hl_order(market: &str, is_buy: bool, limit_px: &str, sz: &str, nonce_ms: u64) -> Value {
    json!({
        "target": "HlTestnet",
        "order": {"HlOrder": {
            "market": market,
            "is_buy": is_buy,
            "limit_px": limit_px,
            "sz": sz,
            "reduce_only": false,
            "tif": "Gtc",
            "nonce_ms": nonce_ms.to_string()
        }},
        "memo": null
    })
}

/// A Base Sepolia ERC-20 transfer proposal with the fees of the shared EVM vectors.
pub fn evm_transfer(token: &str, to: &str, amount: u128, nonce: u64) -> Value {
    json!({
        "target": "BaseSepolia",
        "order": {"EvmTransfer": {
            "token": token,
            "to": to,
            "amount": amount.to_string(),
            "nonce": nonce.to_string(),
            "gas_limit": "65000",
            "max_fee_per_gas": "1000000000",
            "max_priority_fee_per_gas": "1000000"
        }},
        "memo": null
    })
}

// ---- execution results ----

/// The `Decision` the transaction ended with (for an allowed order: the `on_signed` value).
pub fn decision_json(result: ExecutionFinalResult) -> Result<Value> {
    ensure!(
        result.is_success(),
        "transaction failed: {:?}",
        result.clone().into_result().err()
    );
    Ok(result.json()?)
}

/// Every `EVENT_JSON:` log of the transaction, parsed, in order.
pub fn events(result: &ExecutionFinalResult) -> Result<Vec<Value>> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).context("event JSON"))
        .collect()
}

/// Names of the claw-guard events of the transaction, in order.
pub fn event_names(result: &ExecutionFinalResult) -> Result<Vec<String>> {
    Ok(events(result)?
        .iter()
        .filter(|e| e["standard"] == "clawguard")
        .filter_map(|e| e["event"].as_str().map(str::to_owned))
        .collect())
}

/// Receipt outcomes that executed on `account` (refunds go to the signer, so for a contract
/// this is the function calls it ran).
pub fn outcomes_on<'a>(
    result: &'a ExecutionFinalResult,
    account: &str,
) -> Vec<&'a ExecutionOutcome> {
    result
        .receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id.as_str() == account)
        .collect()
}

/// Gas burnt by each receipt, as `<executor>=<Tgas>` (for the gas table in docs).
pub fn gas_breakdown(result: &ExecutionFinalResult) -> String {
    let receipts: Vec<String> = result
        .receipt_outcomes()
        .iter()
        .filter(|o| o.gas_burnt.as_gas() > 0)
        .map(|o| format!("{}={}", o.executor_id, tgas(o.gas_burnt)))
        .collect();
    format!(
        "total={} Tgas (tx={}; receipts: {})",
        tgas(result.total_gas_burnt),
        tgas(result.outcome().gas_burnt),
        receipts.join(", ")
    )
}

/// Gas as Tgas with two decimals.
pub fn tgas(gas: Gas) -> String {
    format!("{:.2}", gas.as_gas() as f64 / 1e12)
}

// ---- crypto (signature recovery the way a relayer or verifier does it) ----

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

pub fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hex with an optional `0x`, either case.
pub fn decode_hex(hex: &str) -> Result<Vec<u8>> {
    let digits = hex
        .strip_prefix("0x")
        .or_else(|| hex.strip_prefix("0X"))
        .unwrap_or(hex);
    ensure!(digits.len().is_multiple_of(2), "odd-length hex {hex:?}");
    (0..digits.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&digits[i..i + 2], 16).with_context(|| format!("hex {hex:?}")))
        .collect()
}

pub fn decode_hex32(hex: &str) -> Result<[u8; 32]> {
    decode_hex(hex)?
        .try_into()
        .map_err(|v: Vec<u8>| anyhow!("expected 32 bytes, got {}", v.len()))
}

/// `0x` + last 20 bytes of keccak256(x ‖ y), lowercase.
pub fn evm_address(key: &VerifyingKey) -> String {
    let point = key.to_sec1_point(false);
    format!("0x{}", encode_hex(&keccak256(&point.as_bytes()[1..])[12..]))
}

/// Recovers the signer address of `prehash` from `r`, `s` (32 bytes each) and a recovery id.
pub fn recover_address(
    prehash: &[u8; 32],
    r: [u8; 32],
    s: [u8; 32],
    recovery_id: u8,
) -> Result<String> {
    let signature = Signature::from_scalars(r, s).map_err(|e| anyhow!("bad r/s: {e}"))?;
    let recovery_id =
        RecoveryId::from_byte(recovery_id).ok_or_else(|| anyhow!("bad recovery id"))?;
    let key = VerifyingKey::recover_from_prehash(prehash, &signature, recovery_id)
        .map_err(|e| anyhow!("recovery failed: {e}"))?;
    Ok(evm_address(&key))
}

/// Recovers the signer of a receipt `{"r":"0x…","s":"0x…","v":n}` over `payload_hash`;
/// `v_offset` is 27 for Hyperliquid and 0 for EIP-1559.
pub fn recover_receipt_signer(payload_hash: &str, sig: &Value, v_offset: u8) -> Result<String> {
    let v = sig["v"].as_u64().context("sig.v")?;
    let recovery_id = u8::try_from(v)?
        .checked_sub(v_offset)
        .context("v below offset")?;
    recover_address(
        &decode_hex32(payload_hash)?,
        decode_hex32(sig["r"].as_str().context("sig.r")?)?,
        decode_hex32(sig["s"].as_str().context("sig.s")?)?,
        recovery_id,
    )
}

// ---- minimal RLP for EIP-1559 (type 2) transactions ----

/// Splits an RLP item at the start of `data` into (header length, payload length, is_list).
fn rlp_header(data: &[u8]) -> Result<(usize, usize, bool)> {
    let first = *data.first().context("empty RLP")?;
    let long = |base: u8| -> Result<(usize, usize)> {
        let len_of_len = usize::from(first - base);
        let bytes = data.get(1..1 + len_of_len).context("short RLP length")?;
        let len = bytes
            .iter()
            .fold(0usize, |acc, b| (acc << 8) | usize::from(*b));
        Ok((1 + len_of_len, len))
    };
    let (header, len, list) = match first {
        0x00..=0x7f => (0, 1, false),
        0x80..=0xb7 => (1, usize::from(first - 0x80), false),
        0xb8..=0xbf => {
            let (h, l) = long(0xb7)?;
            (h, l, false)
        }
        0xc0..=0xf7 => (1, usize::from(first - 0xc0), true),
        0xf8..=0xff => {
            let (h, l) = long(0xf7)?;
            (h, l, true)
        }
    };
    ensure!(data.len() >= header + len, "truncated RLP");
    Ok((header, len, list))
}

/// The raw encodings of the items of an RLP list that spans all of `data`.
fn rlp_list_items(data: &[u8]) -> Result<Vec<&[u8]>> {
    let (header, len, list) = rlp_header(data)?;
    ensure!(list && header + len == data.len(), "not a single RLP list");
    let mut rest = &data[header..];
    let mut items = Vec::new();
    while !rest.is_empty() {
        let (h, l, _) = rlp_header(rest)?;
        items.push(&rest[..h + l]);
        rest = &rest[h + l..];
    }
    Ok(items)
}

/// The content of an RLP string item.
fn rlp_string(item: &[u8]) -> Result<&[u8]> {
    let (header, len, list) = rlp_header(item)?;
    ensure!(!list, "expected an RLP string");
    Ok(&item[header..header + len])
}

fn rlp_encode_length(len: usize, base: u8) -> Vec<u8> {
    if len <= 55 {
        vec![base + len as u8]
    } else {
        let bytes: Vec<u8> = len
            .to_be_bytes()
            .into_iter()
            .skip_while(|b| *b == 0)
            .collect();
        let mut out = vec![base + 55 + bytes.len() as u8];
        out.extend(bytes);
        out
    }
}

fn rlp_list(payload: &[u8]) -> Vec<u8> {
    let mut out = rlp_encode_length(payload.len(), 0xc0);
    out.extend_from_slice(payload);
    out
}

/// An unsigned integer given big-endian (leading zeros are dropped).
fn rlp_uint(be: &[u8]) -> Vec<u8> {
    let trimmed: Vec<u8> = be.iter().copied().skip_while(|b| *b == 0).collect();
    match trimmed.as_slice() {
        [b] if *b < 0x80 => vec![*b],
        bytes => {
            let mut out = rlp_encode_length(bytes.len(), 0x80);
            out.extend_from_slice(bytes);
            out
        }
    }
}

fn be_to_u64(bytes: &[u8]) -> Result<u64> {
    ensure!(bytes.len() <= 8, "integer too long");
    Ok(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
}

/// `0x02 ‖ rlp([...unsigned fields, y_parity, r, s])` from the receipt's unsigned tx
/// `0x02 ‖ rlp([chain_id, nonce, max_priority_fee, max_fee, gas, to, value, data,
/// access_list])`.
pub fn signed_eip1559_tx(
    unsigned_tx: &[u8],
    y_parity: u8,
    r: [u8; 32],
    s: [u8; 32],
) -> Result<Vec<u8>> {
    let (&tx_type, body) = unsigned_tx.split_first().context("empty tx")?;
    ensure!(tx_type == 0x02, "not an EIP-1559 tx");
    let items = rlp_list_items(body)?;
    ensure!(
        items.len() == 9,
        "unsigned EIP-1559 tx has {} fields",
        items.len()
    );
    let mut payload: Vec<u8> = items.concat();
    payload.extend(rlp_uint(&[y_parity]));
    payload.extend(rlp_uint(&r));
    payload.extend(rlp_uint(&s));
    let mut out = vec![0x02];
    out.extend(rlp_list(&payload));
    Ok(out)
}

/// What a node does with a raw signed EIP-1559 tx: decode it, rebuild the signing payload,
/// hash it, and recover the sender. Returns (chain id, signing hash, sender address).
pub fn recover_eip1559_sender(signed_tx: &[u8]) -> Result<(u64, [u8; 32], String)> {
    let (&tx_type, body) = signed_tx.split_first().context("empty tx")?;
    ensure!(tx_type == 0x02, "not an EIP-1559 tx");
    let items = rlp_list_items(body)?;
    if items.len() != 12 {
        bail!("signed EIP-1559 tx has {} fields", items.len());
    }
    let chain_id = be_to_u64(rlp_string(items[0])?)?;
    let mut unsigned = vec![0x02];
    unsigned.extend(rlp_list(&items[..9].concat()));
    let hash = keccak256(&unsigned);
    let y_parity = u8::try_from(be_to_u64(rlp_string(items[9])?)?)?;
    let pad32 = |bytes: &[u8]| -> Result<[u8; 32]> {
        ensure!(bytes.len() <= 32, "signature scalar too long");
        let mut out = [0u8; 32];
        out[32 - bytes.len()..].copy_from_slice(bytes);
        Ok(out)
    };
    let r = pad32(rlp_string(items[10])?)?;
    let s = pad32(rlp_string(items[11])?)?;
    Ok((chain_id, hash, recover_address(&hash, r, s, y_parity)?))
}

// =============================================================================================
// Helpers for the negative-key, injection, pause and balance suites. Sandbox only.
// =============================================================================================

use near_workspaces::AccountDetailsPatch;
use near_workspaces::error::{ErrorKind, RpcErrorCode};
use near_workspaces::types::AccountDetails;

/// An account with a `propose_order` key on the guard that the owner never registered.
pub const STRANGER_ID: &str = "agent-2.test.near";

/// `Decision.message` of an allowed order.
pub const MSG_ALLOWED: &str = "Allowed: within your limits";
/// near-sdk's panic for an owner method called without exactly 1 yoctoNEAR.
pub const ONE_YOCTO_PANIC: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
/// yoctoNEAR per byte of storage (`storage_amount_per_byte`, 10^19 on every NEAR network).
pub const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// Mirrors claw-guard `rules::RECEIPT_STORAGE_RESERVE_BYTES`: free storage kept for a receipt.
pub const RECEIPT_STORAGE_RESERVE_BYTES: u64 = 4096;

// ---- demo rules ----

/// Per-order notional cap of the demo rules: 500 quote units (wire unit 1e-6).
pub const DEMO_MAX_ORDER_NOTIONAL: u128 = 500_000_000;
/// Daily cap of the demo rules: 1200 quote units (wire unit 1e-6), shared by both targets.
pub const DEMO_DAILY_CAP: u128 = 1_200_000_000;
/// Per-transfer cap of USDC in the demo rules: 5 USDC (raw units, 6 decimals).
pub const DEMO_USDC_MAX_PER_ORDER: u128 = 5_000_000;

/// The demo / prompt-injection rules. The TypeScript demo's `demo/rules.json` is
/// this JSON with `expires_at_ns` = block time + 7 days filled in at setup:
/// BTC (asset 3, max size 0.01, sz_decimals 5) and ETH (asset 4, max size 0.1, sz_decimals 4),
/// 500 quote units per order, leverage up to 3x, USDC up to 5 per transfer to the one owner
/// test address [`RECEIVER`], a daily cap of 1200 quote units and 10 orders per day.
///
/// With these numbers the scenario's step 1 (0.001 BTC at 50000 = 50 units) passes, and
/// step 6 (0.01 BTC at 50000 = 500 units, exactly the per-order cap) is allowed twice
/// (50 + 500 + 500 = 1050) before the third would reach 1550 > 1200 (`DAILY_CAP`).
pub fn demo_rules(expires_at_ns: u64) -> Value {
    json!({
        "targets": ["HlTestnet", "BaseSepolia"],
        "markets": [
            {"name": "BTC", "asset": 3, "max_order_sz": "0.01", "sz_decimals": 5},
            {"name": "ETH", "asset": 4, "max_order_sz": "0.1", "sz_decimals": 4}
        ],
        "max_order_notional": DEMO_MAX_ORDER_NOTIONAL.to_string(),
        "max_leverage": 3,
        "tokens": [{
            "symbol": USDC_SYMBOL,
            "address": USDC_ADDRESS,
            "decimals": 6,
            "max_per_order": DEMO_USDC_MAX_PER_ORDER.to_string()
        }],
        "receivers": [RECEIVER],
        "daily_cap": DEMO_DAILY_CAP.to_string(),
        "max_orders_per_day": 10,
        "expires_at_ns": expires_at_ns.to_string(),
        "reduce_only_required": false
    })
}

/// Like [`setup`], but registers `agent-1.test.near` with `rules(block time + 7 days)`.
pub async fn setup_with_rules(rules: impl FnOnce(u64) -> Value) -> Result<Sandbox> {
    let sandbox = deploy().await?;
    let expires_at_ns = sandbox.now_ns().await? + 7 * NS_PER_DAY;
    let result = sandbox
        .register_agent(AGENT_ID, &rules(expires_at_ns))
        .await?;
    ensure!(
        result.is_success(),
        "register_agent failed: {:?}",
        result.into_result().err()
    );
    Ok(sandbox)
}

/// An HL `updateLeverage` proposal.
pub fn hl_update_leverage(market: &str, is_cross: bool, leverage: u8, nonce_ms: u64) -> Value {
    json!({
        "target": "HlTestnet",
        "order": {"HlUpdateLeverage": {
            "market": market,
            "is_cross": is_cross,
            "leverage": leverage,
            "nonce_ms": nonce_ms.to_string()
        }},
        "memo": null
    })
}

/// Hands out HL `nonce_ms` values the guard accepts: the current block time in ms (inside the
/// ±5 min window), but always above the last value handed out (nonces strictly increase).
#[derive(Debug, Default)]
pub struct HlNonces {
    last: u64,
}

impl HlNonces {
    pub async fn next(&mut self, sb: &Sandbox) -> Result<u64> {
        let nonce = sb.now_ms().await?.max(self.last + 1);
        self.last = nonce;
        Ok(nonce)
    }
}

// ---- outcome checks ----

/// Asserts the transaction succeeded and hands it back (for its logs and outcomes).
pub fn expect_success(result: ExecutionFinalResult) -> Result<ExecutionFinalResult> {
    ensure!(
        result.is_success(),
        "transaction failed: {:?}",
        result.clone().into_result().err()
    );
    Ok(result)
}

/// Asserts the proposal was blocked by `rule_code` with exactly `message`: the decision says
/// so, the only event is `order_blocked`, and no receipt ran on the MPC. Returns the decision.
pub fn expect_blocked(
    result: ExecutionFinalResult,
    rule_code: &str,
    message: &str,
) -> Result<Value> {
    ensure!(
        outcomes_on(&result, MPC_ID).is_empty(),
        "a blocked order reached the MPC: {}",
        gas_breakdown(&result)
    );
    let names = event_names(&result)?;
    ensure!(
        names == ["order_blocked"],
        "events of a blocked order: {names:?}"
    );
    let decision = decision_json(result)?;
    let expected = json!({
        "allowed": false,
        "receipt_id": decision["receipt_id"],
        "rule_code": rule_code,
        "message": message,
        "signature": null
    });
    ensure!(
        decision == expected,
        "decision\n  got:  {decision}\n  want: {expected}"
    );
    Ok(decision)
}

/// Asserts the proposal was allowed and signed: exactly one successful receipt on the MPC,
/// events `order_allowed` then `signature_ready`, and a decision with a signature. Returns the
/// decision.
pub fn expect_allowed(result: ExecutionFinalResult) -> Result<Value> {
    let mpc = outcomes_on(&result, MPC_ID);
    ensure!(
        mpc.len() == 1 && mpc[0].is_success(),
        "an allowed order must make exactly one successful MPC call: {}",
        gas_breakdown(&result)
    );
    let names = event_names(&result)?;
    ensure!(
        names == ["order_allowed", "signature_ready"],
        "events of an allowed order: {names:?}"
    );
    let decision = decision_json(result)?;
    ensure!(
        decision["allowed"] == true
            && decision["rule_code"].is_null()
            && decision["message"] == MSG_ALLOWED
            && decision["signature"].is_object(),
        "not an allowed decision: {decision}"
    );
    Ok(decision)
}

/// How the protocol refuses a transaction its access key may not sign (nearcore
/// `InvalidAccessKeyError`). Such a transaction is never included in a block: it burns no gas
/// and changes nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyRejection<'a> {
    /// A function-call key signs only a transaction with one `FunctionCall` action: no
    /// Transfer, AddKey, DeleteKey, DeployContract, CreateAccount, DeleteAccount, no batches.
    RequiresFullAccess,
    /// A function-call key cannot attach a deposit.
    DepositWithFunctionCall,
    /// The transaction goes to another contract than the key's receiver.
    ReceiverMismatch {
        tx_receiver: &'a str,
        ak_receiver: &'a str,
    },
    /// The method is not in the key's method list.
    MethodNameMismatch(&'a str),
}

impl KeyRejection<'_> {
    /// The error as the RPC reports it (Debug form of nearcore's `InvalidTxError`).
    pub fn rpc_error(&self) -> String {
        let kind = match self {
            Self::RequiresFullAccess => "RequiresFullAccess".to_owned(),
            Self::DepositWithFunctionCall => "DepositWithFunctionCall".to_owned(),
            Self::ReceiverMismatch {
                tx_receiver,
                ak_receiver,
            } => format!(
                "ReceiverMismatch {{ tx_receiver: AccountId({tx_receiver:?}), ak_receiver: {ak_receiver:?} }}"
            ),
            Self::MethodNameMismatch(method) => {
                format!("MethodNameMismatch {{ method_name: {method:?} }}")
            }
        };
        format!("HandlerError(InvalidTransaction {{ context: InvalidAccessKeyError({kind}) }})")
    }
}

/// Asserts that the RPC refused to accept the transaction, for exactly `expected`.
pub fn assert_rejected_by_protocol<T: std::fmt::Debug>(
    result: near_workspaces::Result<T>,
    expected: KeyRejection<'_>,
) -> Result<()> {
    let err = match result {
        Ok(accepted) => {
            bail!("the protocol accepted a transaction it must refuse ({expected:?}): {accepted:?}")
        }
        Err(err) => err,
    };
    ensure!(
        *err.kind() == ErrorKind::Rpc(RpcErrorCode::BroadcastTxFailure),
        "expected a refused broadcast ({expected:?}), got {err:?}"
    );
    let details = format!("{err:?}");
    ensure!(
        details.contains(&expected.rpc_error()),
        "expected {}\n  got {details}",
        expected.rpc_error()
    );
    Ok(())
}

/// Asserts that the transaction executed and its (single) function call panicked with exactly
/// `message`, e.g. `ERR_NOT_AGENT`.
pub fn assert_contract_panic(result: &ExecutionFinalResult, message: &str) -> Result<()> {
    let failure = match result.clone().into_result() {
        Ok(success) => bail!("expected the panic {message:?}, but the call succeeded: {success:?}"),
        Err(failure) => failure,
    };
    let expected = format!(
        "Action #0: ExecutionError({:?})",
        format!("Smart contract panicked: {message}")
    );
    ensure!(
        failure.to_string() == expected,
        "expected {expected}\n  got {failure}"
    );
    Ok(())
}

/// The `EVENT_JSON:` lines logged by receipts that ran on `account`, one inner vector per
/// receipt, in the order the RPC lists the receipts.
pub fn event_logs_on<'a>(result: &'a ExecutionFinalResult, account: &str) -> Vec<Vec<&'a str>> {
    outcomes_on(result, account)
        .into_iter()
        .map(|outcome| {
            outcome
                .logs
                .iter()
                .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
                .collect()
        })
        .collect()
}

// ---- calls, views and sandbox patches ----

impl Sandbox {
    /// `account` calls `method(args)` on the guard with `deposit` and 30 Tgas. Returns the raw
    /// result: `Err` when the protocol refused the transaction, `Ok` with a failure when the
    /// contract panicked.
    pub async fn call_guard_as(
        &self,
        account: &Account,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> near_workspaces::Result<ExecutionFinalResult> {
        account
            .call(self.guard.id(), method)
            .args_json(args)
            .deposit(deposit)
            .gas(Gas::from_tgas(30))
            .transact()
            .await
    }

    /// The guardian's function-call key calls `pause(reason)` (no deposit).
    pub async fn guardian_pause(&self, reason: &str) -> Result<ExecutionFinalResult> {
        Ok(self
            .call_guard_as(
                &self.guardian,
                "pause",
                json!({"reason": reason}),
                NearToken::from_yoctonear(0),
            )
            .await?)
    }

    /// The owner calls `unpause` with 1 yoctoNEAR.
    pub async fn owner_unpause(&self) -> Result<ExecutionFinalResult> {
        Ok(self
            .call_guard_as(&self.owner, "unpause", json!({}), ONE_YOCTO)
            .await?)
    }

    /// The owner calls `set_sign_config` with 1 yoctoNEAR; fails unless it succeeds.
    pub async fn set_sign_config(
        &self,
        sign_deposit_yocto: u128,
        sign_gas_tgas: u64,
    ) -> Result<()> {
        let result = self
            .call_guard_as(
                &self.owner,
                "set_sign_config",
                json!({
                    "sign_deposit_yocto": sign_deposit_yocto.to_string(),
                    "sign_gas_tgas": sign_gas_tgas
                }),
                ONE_YOCTO,
            )
            .await?;
        ensure!(
            result.is_success(),
            "set_sign_config failed: {:?}",
            result.into_result().err()
        );
        Ok(())
    }

    /// `get_receipts({"from_id": "<from_id>", "limit": <limit>})`.
    pub async fn receipts(&self, from_id: u64, limit: u32) -> Result<Vec<Value>> {
        let page = self
            .view_guard(
                "get_receipts",
                json!({"from_id": from_id.to_string(), "limit": limit}),
            )
            .await?;
        page.as_array()
            .cloned()
            .context("get_receipts returns an array")
    }

    /// Account details (balance, storage usage) of the guard contract.
    pub async fn guard_account(&self) -> Result<AccountDetails> {
        Ok(self.guard.view_account().await?)
    }

    /// Sets the guard account's balance with a sandbox state patch, keeping everything else
    /// (storage usage, code) as it is.
    pub async fn patch_guard_balance(&self, balance: NearToken) -> Result<()> {
        self.worker
            .patch(self.guard.id())
            .account_from_current(move |current| {
                AccountDetailsPatch::from(current).balance(balance)
            })
            .transact()
            .await?;
        let now = self.guard_account().await?.balance;
        ensure!(
            now == balance,
            "balance patch not applied: {now} != {balance}"
        );
        Ok(())
    }

    /// Simulates an attacker who got a full-access key onto `account_id`: the key is written
    /// with the sandbox state patch (`sandbox_patch_state`), not by a transaction (which the
    /// account's own keys could never sign). Returns the new key.
    pub async fn patch_in_full_access_key(&self, account_id: &AccountId) -> Result<SecretKey> {
        let key = SecretKey::from_random(KeyType::ED25519);
        self.worker
            .patch(account_id)
            .access_key(key.public_key(), AccessKey::full_access())
            .transact()
            .await?;
        let visible = self
            .worker
            .view_access_key(account_id, &key.public_key())
            .await
            .is_ok();
        ensure!(visible, "key patch on {account_id} not applied");
        Ok(key)
    }
}

/// The smallest guard balance that still pays a signature request (the
/// `INSUFFICIENT_CONTRACT_BALANCE` rule): `(storage + 4096 bytes) × byte cost + deposit`.
pub fn sign_balance_floor(storage_usage: u64, sign_deposit_yocto: u128) -> u128 {
    u128::from(storage_usage + RECEIPT_STORAGE_RESERVE_BYTES) * STORAGE_BYTE_COST
        + sign_deposit_yocto
}
