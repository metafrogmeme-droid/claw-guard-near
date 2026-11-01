//! Claw Guard: Signing Gate for AI Agents. NEAR policy contract.
//! Prototype. Testnet only. Not audited.
//!
//! An agent can only *propose* orders (`propose_order`). The contract checks every proposal
//! against its owner's rules ([`rules::evaluate`], fixed order, first failure wins) and stores a
//! receipt either way. Only when every rule passes does it build the exact payload itself and
//! ask the NEAR MPC network to sign it; the signature lands in the receipt in `on_signed`.
//!
//! Testnet guards: `new` refuses unless the contract and the MPC contract are both `.testnet`
//! (or both `.test.near`, sandbox). Only a wasm built with `--features mainnet` also accepts a
//! `.near` contract with MPC `v1.signer` (docs/MAINNET.md); targets stay testnet either way. The Hyperliquid phantom-agent source `"b"` and the EVM
//! chain id 84532 are compile-time constants in [`eip712`] and [`evm`].
//!
//! Modules:
//! * [`types`]: wire types. [`errors`]: decision strings and panic codes.
//! * [`rules`]: pure evaluation, rules validation, tighten-vs-loosen. [`admin`]: owner and
//!   guardian methods. [`receipts`]: receipt ring buffer and views. [`events`]: NEP-297.
//! * [`mpc`]: `sign` request and response. [`order`], [`hl`], [`eip712`], [`msgpack`],
//!   [`evm`], [`util`]: checked fields and the payload encoders.

pub mod admin;
pub mod eip712;
pub mod errors;
pub mod events;
pub mod evm;
pub mod hl;
pub mod mpc;
pub mod msgpack;
pub mod order;
pub mod receipts;
pub mod rules;
pub mod types;
pub mod util;

#[cfg(test)]
mod test_fixtures;
#[cfg(test)]
mod tests;

use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::Value;
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, env, near, require,
};

use crate::errors::{
    ALLOWED, Blocked, ERR_MAINNET_REFUSED, ERR_NO_PENDING_SIGNATURE, ERR_NOT_AGENT,
    ERR_NOT_ENOUGH_GAS, NOT_SIGNED, REASON_SIGN_CALL_FAILED, REASON_UNREADABLE_RESPONSE,
};
use crate::mpc::{CALLBACK_GAS, GAS_MARGIN, MpcSignature};
use crate::receipts::{DEFAULT_MAX_RECEIPTS, ReceiptLog};
use crate::rules::{Approved, EvalContext, day_of};
use crate::types::{
    AgentState, Decision, GuardStatus, PreviewResult, Proposal, Receipt, Status, Target,
};

/// Account-id suffixes the contract may run under. The contract and the MPC contract must
/// share one: `.testnet` (NEAR testnet) or `.test.near` (local sandbox).
pub const ALLOWED_NETWORK_SUFFIXES: [&str; 2] = [".testnet", ".test.near"];
/// The MPC method that signs a payload.
const MPC_SIGN_METHOD: &str = "sign";
/// `Decision.receipt_id` of a blocked order whose receipt was not stored (storage reserve).
pub const NO_RECEIPT_ID: u64 = 0;

/// True if `contract_id` and `mpc_contract_id` both end in the same allowed suffix.
pub fn is_allowed_network(contract_id: &AccountId, mpc_contract_id: &AccountId) -> bool {
    ALLOWED_NETWORK_SUFFIXES.iter().any(|suffix| {
        contract_id.as_str().ends_with(suffix) && mpc_contract_id.as_str().ends_with(suffix)
    })
}

/// The NEAR mainnet MPC contract (docs.near.org, chain signatures).
pub const MAINNET_MPC_CONTRACT_ID: &str = "v1.signer";

/// True only for a NEAR mainnet pair: `contract_id` is a named `.near` account (not the
/// sandbox's `.test.near`) and `mpc_contract_id` is exactly [`MAINNET_MPC_CONTRACT_ID`].
/// Always compiled and tested; `new` accepts it only in a build with the `mainnet` feature.
pub fn is_mainnet_pair(contract_id: &AccountId, mpc_contract_id: &AccountId) -> bool {
    let contract = contract_id.as_str();
    mpc_contract_id.as_str() == MAINNET_MPC_CONTRACT_ID
        && contract.ends_with(".near")
        && !contract.ends_with(".test.near")
}

/// True in a wasm built with `--features mainnet` (docs/MAINNET.md). The default build, used by
/// CI, the sandbox demo and testnet, stays testnet-only.
pub const MAINNET_ENABLED: bool = cfg!(feature = "mainnet");

/// The network check `new` runs: a testnet or sandbox pair, or (mainnet build only) the
/// mainnet pair.
fn network_accepted(contract_id: &AccountId, mpc_contract_id: &AccountId) -> bool {
    is_allowed_network(contract_id, mpc_contract_id)
        || (MAINNET_ENABLED && is_mainnet_pair(contract_id, mpc_contract_id))
}

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Receipts,
    PendingSigns,
}

/// A registered agent. `registration` tells two registrations of the same account apart, so a
/// late `on_signed` never releases a reservation into a newer registration's counters.
#[near(serializers = [borsh])]
pub(crate) struct AgentRecord {
    pub(crate) state: AgentState,
    pub(crate) registration: u64,
}

/// What an in-flight signature request reserved (kept apart so the receipt JSON stays as
/// specified, and so `on_signed` works even after the receipt left the ring buffer).
#[near(serializers = [borsh])]
pub(crate) struct PendingSign {
    pub(crate) agent_id: AccountId,
    pub(crate) registration: u64,
    pub(crate) day: u64,
    pub(crate) spend: u128,
    pub(crate) target: Target,
    pub(crate) payload_hash: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ClawGuard {
    owner_id: AccountId,
    guardian_id: Option<AccountId>,
    /// Immutable: there is no setter.
    mpc_contract_id: AccountId,
    sign_deposit_yocto: u128,
    sign_gas_tgas: u64,
    loosen_delay_sec: u64,
    paused: bool,
    pause_reason: Option<String>,
    agents: LookupMap<AccountId, AgentRecord>,
    agents_count: u32,
    /// Registrations ever made; numbers each [`AgentRecord`].
    registrations: u64,
    receipts: ReceiptLog,
    /// Receipt id → reservation of a signature request in flight.
    pending_signs: LookupMap<u64, PendingSign>,
}

#[near]
impl ClawGuard {
    /// Initializes the guard. Must be called by the contract account itself (deploy + init in
    /// one batch). Panics `ERR_MAINNET_REFUSED` unless this account and `mpc_contract_id` both
    /// end with `.testnet`, or both with `.test.near`. A wasm built with the `mainnet` feature
    /// also accepts a `.near` account with MPC `v1.signer` ([`is_mainnet_pair`]).
    #[init]
    #[private]
    pub fn new(
        owner_id: AccountId,
        guardian_id: Option<AccountId>,
        mpc_contract_id: AccountId,
        sign_deposit_yocto: U128,
        sign_gas_tgas: u64,
        loosen_delay_sec: u64,
    ) -> Self {
        require!(
            network_accepted(&env::current_account_id(), &mpc_contract_id),
            ERR_MAINNET_REFUSED
        );
        Self {
            owner_id,
            guardian_id,
            mpc_contract_id,
            sign_deposit_yocto: sign_deposit_yocto.0,
            sign_gas_tgas,
            loosen_delay_sec,
            paused: false,
            pause_reason: None,
            agents: LookupMap::new(StorageKey::Agents),
            agents_count: 0,
            registrations: 0,
            receipts: ReceiptLog::new(StorageKey::Receipts, DEFAULT_MAX_RECEIPTS),
            pending_signs: LookupMap::new(StorageKey::PendingSigns),
        }
    }

    /// The only method an agent's function-call key can call. Not payable.
    ///
    /// Blocked: stores a `Blocked` receipt, emits `order_blocked` and returns the decision (no
    /// panic, so the receipt persists). If the balance would no longer cover the storage reserve
    /// (`(storage + 4096 bytes) × byte cost`), no receipt is stored: the event and the decision
    /// are the same, with `receipt_id` `"0"` (Q-44). Allowed: reserves the spend and one order,
    /// consumes the nonce, stores a `PendingSignature` receipt, emits `order_allowed` and calls
    /// MPC `sign`; the decision then comes from [`Self::on_signed`].
    ///
    /// Panics `ERR_NOT_AGENT` for an unregistered caller and `ERR_NOT_ENOUGH_GAS` when an
    /// allowed order did not attach enough gas for the signature; nothing is stored then.
    pub fn propose_order(&mut self, proposal: Proposal) -> PromiseOrValue<Decision> {
        let agent_id = env::predecessor_account_id();
        let now_ns = env::block_timestamp();
        let record = self
            .agents
            .get(&agent_id)
            .unwrap_or_else(|| env::panic_str(ERR_NOT_AGENT));
        let rules_version = record.state.rules_version;
        let verdict = rules::evaluate(&record.state, &self.eval_context(now_ns), &proposal);
        match verdict {
            Err(blocked) => PromiseOrValue::Value(self.record_blocked(
                agent_id,
                &proposal,
                rules_version,
                blocked,
            )),
            Ok(approved) => PromiseOrValue::Promise(self.request_signature(
                agent_id,
                proposal,
                rules_version,
                approved,
                now_ns,
            )),
        }
    }

    /// MPC callback. Success: receipt `Signed` with the signature, event `signature_ready`.
    /// Anything else (failed call, timeout, unusable response): receipt `SignFailed`, the
    /// reservation is released if it is still the same UTC day, event `signature_failed`.
    #[private]
    pub fn on_signed(
        &mut self,
        receipt_id: U64,
        #[callback_result(max_bytes = mpc::MAX_RESPONSE_BYTES)] result: Result<Value, PromiseError>,
    ) -> Decision {
        let id = receipt_id.0;
        let pending = self
            .pending_signs
            .remove(&id)
            .unwrap_or_else(|| env::panic_str(ERR_NO_PENDING_SIGNATURE));
        let signature = match &result {
            Ok(response) => MpcSignature::from_response(response).ok_or(REASON_UNREADABLE_RESPONSE),
            Err(_) => Err(REASON_SIGN_CALL_FAILED),
        };
        match signature {
            Ok(signature) => {
                let sig = signature.to_sig(pending.target);
                if let Some(receipt) = self.receipts.get_mut(id) {
                    receipt.status = Status::Signed;
                    receipt.signature = Some(sig.clone());
                }
                events::signature_ready(id, &pending.payload_hash);
                Decision {
                    allowed: true,
                    receipt_id,
                    rule_code: None,
                    message: ALLOWED.to_owned(),
                    signature: Some(sig),
                }
            }
            Err(reason) => {
                self.release(&pending);
                if let Some(receipt) = self.receipts.get_mut(id) {
                    receipt.status = Status::SignFailed;
                    receipt.rule_code = None;
                    receipt.message = NOT_SIGNED.to_owned();
                }
                events::signature_failed(id, reason);
                Decision {
                    allowed: false,
                    receipt_id,
                    rule_code: None,
                    message: NOT_SIGNED.to_owned(),
                    signature: None,
                }
            }
        }
    }

    // ---- views ----

    pub fn get_status(&self) -> GuardStatus {
        GuardStatus {
            owner: self.owner_id.clone(),
            guardian: self.guardian_id.clone(),
            paused: self.paused,
            pause_reason: self.pause_reason.clone(),
            mpc_contract_id: self.mpc_contract_id.clone(),
            agents_count: self.agents_count,
            receipts_count: self.receipts.total().into(),
        }
    }

    /// The agent's rules, pending change and counters as of the current UTC day (counters of
    /// an earlier day read as zero), or `null` if the account is not a registered agent.
    pub fn get_rules(&self, agent_id: AccountId) -> Option<AgentState> {
        let today = day_of(env::block_timestamp());
        self.agents
            .get(&agent_id)
            .map(|record| record.state.view_on(today))
    }

    /// `[["HlTestnet","hl-testnet-1"],["BaseSepolia","base-sepolia-1"]]`.
    pub fn get_paths(&self) -> Vec<(Target, String)> {
        Target::ALL
            .iter()
            .map(|target| (*target, target.derivation_path().to_owned()))
            .collect()
    }

    /// Runs the same evaluation as `propose_order` without storing anything. Panics
    /// `ERR_NOT_AGENT` for an account that is not registered.
    pub fn preview_payload(&self, agent_id: AccountId, proposal: Proposal) -> PreviewResult {
        let record = self
            .agents
            .get(&agent_id)
            .unwrap_or_else(|| env::panic_str(ERR_NOT_AGENT));
        let ctx = self.eval_context(env::block_timestamp());
        match rules::evaluate(&record.state, &ctx, &proposal) {
            Ok(approved) => PreviewResult::Ok(approved.payload_hash_hex()),
            Err(blocked) => PreviewResult::Err(blocked.message),
        }
    }
}

impl ClawGuard {
    fn eval_context(&self, now_ns: u64) -> EvalContext<'_> {
        EvalContext {
            paused: self.paused,
            pause_reason: self.pause_reason.as_deref().unwrap_or_default(),
            now_ns,
            account_balance: env::account_balance().as_yoctonear(),
            storage_usage: env::storage_usage(),
            storage_byte_cost: env::storage_byte_cost().as_yoctonear(),
            sign_deposit: self.sign_deposit_yocto,
        }
    }

    fn new_receipt(
        agent_id: AccountId,
        proposal: Proposal,
        rules_version: u32,
        status: Status,
    ) -> Receipt {
        Receipt {
            id: U64(0), // assigned by ReceiptLog::push
            agent_id,
            target: proposal.target,
            proposal,
            status,
            rule_code: None,
            message: String::new(),
            payload_hash: None,
            signed_body: None,
            derivation_path: None,
            signature: None,
            rules_version,
            block_height: env::block_height().into(),
            timestamp_ns: env::block_timestamp().into(),
        }
    }

    /// Stores a `Blocked` receipt only while the balance still covers
    /// `(storage_usage + RECEIPT_STORAGE_RESERVE_BYTES) × byte_cost` (same inputs as step 13,
    /// without the sign deposit); otherwise stores nothing and reports receipt id 0 (ids start at
    /// 1). Either way it emits `order_blocked` and returns the decision; nothing is ever signed
    /// here. So blocked receipts never use the last 4096 bytes, and `pause` (at most 144 more
    /// bytes) always fits, however many blocked proposals a hijacked agent sends.
    fn record_blocked(
        &mut self,
        agent_id: AccountId,
        proposal: &Proposal,
        rules_version: u32,
        blocked: Blocked,
    ) -> Decision {
        let target = proposal.target;
        let id = if rules::keeps_receipt_reserve(&self.eval_context(env::block_timestamp())) {
            let receipt = Receipt {
                rule_code: Some(blocked.code),
                message: blocked.message.clone(),
                ..Self::new_receipt(
                    agent_id.clone(),
                    receipts::stored_proposal(proposal),
                    rules_version,
                    Status::Blocked,
                )
            };
            self.receipts.push(receipt)
        } else {
            NO_RECEIPT_ID
        };
        events::order_blocked(id, &agent_id, target, blocked.code, &blocked.message);
        Decision {
            allowed: false,
            receipt_id: id.into(),
            rule_code: Some(blocked.code),
            message: blocked.message,
            signature: None,
        }
    }

    fn request_signature(
        &mut self,
        agent_id: AccountId,
        proposal: Proposal,
        rules_version: u32,
        approved: Approved,
        now_ns: u64,
    ) -> Promise {
        // Fail closed before anything is written: without enough gas the sign or the callback
        // could not run.
        let sign_gas = self
            .sign_gas_tgas
            .checked_mul(Gas::from_tgas(1).as_gas())
            .map(Gas::from_gas);
        let required = sign_gas
            .and_then(|gas| gas.checked_add(CALLBACK_GAS))
            .and_then(|gas| gas.checked_add(GAS_MARGIN));
        let remaining = env::prepaid_gas().saturating_sub(env::used_gas());
        let (Some(sign_gas), Some(required)) = (sign_gas, required) else {
            env::panic_str(ERR_NOT_ENOUGH_GAS)
        };
        require!(remaining >= required, ERR_NOT_ENOUGH_GAS);

        let day = day_of(now_ns);
        let record = self
            .agents
            .get_mut(&agent_id)
            .unwrap_or_else(|| env::panic_str(ERR_NOT_AGENT));
        record.state.reserve(day, approved.spend, approved.nonce);
        let registration = record.registration;

        let payload_hash = approved.payload_hash_hex();
        let target = approved.target;
        let path = approved.derivation_path;
        let receipt = Receipt {
            message: ALLOWED.to_owned(),
            payload_hash: Some(payload_hash.clone()),
            signed_body: Some(approved.signed_body),
            derivation_path: Some(path.to_owned()),
            ..Self::new_receipt(
                agent_id.clone(),
                receipts::allowed_proposal(proposal),
                rules_version,
                Status::PendingSignature,
            )
        };
        let id = self.receipts.push(receipt);
        events::order_allowed(id, &agent_id, target, &payload_hash, path);
        self.pending_signs.insert(
            id,
            PendingSign {
                agent_id,
                registration,
                day,
                spend: approved.spend,
                target,
                payload_hash,
            },
        );

        // The deposit comes from the contract's own balance: function-call keys cannot attach
        // one. Unused gas goes to `sign` (the MPC yields until the network answers).
        Promise::new(self.mpc_contract_id.clone())
            .function_call_weight(
                MPC_SIGN_METHOD,
                mpc::sign_args(path, &approved.payload_hash),
                NearToken::from_yoctonear(self.sign_deposit_yocto),
                sign_gas,
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_signed(U64(id)),
            )
    }

    /// Gives back a failed request's reservation, if the agent is still the same registration
    /// and it is still the same UTC day.
    fn release(&mut self, pending: &PendingSign) {
        let today = day_of(env::block_timestamp());
        if let Some(record) = self.agents.get_mut(&pending.agent_id)
            && record.registration == pending.registration
        {
            record.state.release(pending.day, today, pending.spend);
        }
    }
}
