//! Owner and guardian methods.
//!
//! Owner-only methods check the caller first (`ERR_NOT_OWNER`), then require exactly 1
//! yoctoNEAR attached: function-call access keys cannot attach deposits, so this proves a
//! full-access key of the owner signed. Tightening rules applies at once; loosening waits
//! `loosen_delay_sec` and needs `confirm_rules`. The guardian can only pause and cancel a
//! pending loosening, never loosen or unpause.
//!
//! Deliberately absent: `set_owner` (no ownership transfer in v1) and a setter for
//! `mpc_contract_id` (immutable).

use near_sdk::json_types::U128;
use near_sdk::{AccountId, assert_one_yocto, env, near, require};

use crate::errors::{
    ERR_AGENT_EXISTS, ERR_INVALID_RULES, ERR_NO_PENDING_RULES, ERR_NOT_AGENT, ERR_NOT_OWNER,
    ERR_NOT_OWNER_OR_GUARDIAN, ERR_REASON_TOO_LONG, ERR_TOO_EARLY,
};
use crate::order::MAX_MEMO_BYTES;
use crate::rules::{self, day_of};
use crate::types::{AgentState, Rules};
use crate::{AgentRecord, ClawGuard, ClawGuardExt, events};

/// Longest pause reason, in UTF-8 bytes (same bound as a proposal memo).
pub const MAX_REASON_BYTES: usize = MAX_MEMO_BYTES;
const NS_PER_SEC: u64 = 1_000_000_000;

#[near]
impl ClawGuard {
    /// Owner, 1 yocto. Registers `agent_id` with `rules` (version 1), stored with every EVM
    /// address in lowercase. Panics `ERR_AGENT_EXISTS` or `ERR_INVALID_RULES`.
    #[payable]
    pub fn register_agent(&mut self, agent_id: AccountId, rules: Rules) {
        self.assert_owner_one_yocto();
        require!(!self.agents.contains_key(&agent_id), ERR_AGENT_EXISTS);
        let rules = stored_rules(rules);
        self.registrations += 1;
        let state = AgentState::new(rules, day_of(env::block_timestamp()));
        let rules_version = state.rules_version;
        self.agents.insert(
            agent_id.clone(),
            AgentRecord {
                state,
                registration: self.registrations,
            },
        );
        self.agents_count += 1;
        events::agent_registered(&agent_id, rules_version);
    }

    /// Owner, 1 yocto. Removes the agent; its future proposals panic `ERR_NOT_AGENT`.
    #[payable]
    pub fn remove_agent(&mut self, agent_id: AccountId) {
        self.assert_owner_one_yocto();
        let record = self
            .agents
            .remove(&agent_id)
            .unwrap_or_else(|| env::panic_str(ERR_NOT_AGENT));
        self.agents_count -= 1;
        events::agent_removed(&agent_id, record.state.rules_version);
    }

    /// Owner, 1 yocto. Tighter-or-equal on every field: applies now (`rules_version + 1`, any
    /// pending change dropped, `rules_updated{tightened:true}`). Any loosening: stored as
    /// pending until `now + loosen_delay_sec` (replacing an older pending), `rules_pending`.
    /// Compared and stored with every EVM address in lowercase, so re-sending the same rules
    /// with checksummed addresses is not a loosening.
    #[payable]
    pub fn set_rules(&mut self, agent_id: AccountId, rules: Rules) {
        self.assert_owner_one_yocto();
        let rules = stored_rules(rules);
        let eta_ns =
            env::block_timestamp().saturating_add(self.loosen_delay_sec.saturating_mul(NS_PER_SEC));
        let state = &mut self.agent_mut(&agent_id).state;
        if rules::first_loosening(&state.rules, &rules).is_none() {
            state.rules = rules;
            state.rules_version += 1;
            state.pending = None;
            events::rules_updated(&agent_id, state.rules_version, true);
        } else {
            state.pending = Some((rules, eta_ns.into()));
            events::rules_pending(&agent_id, eta_ns);
        }
    }

    /// Owner, 1 yocto. Applies the pending rules once their eta has passed. Panics
    /// `ERR_NO_PENDING_RULES` or `ERR_TOO_EARLY`.
    #[payable]
    pub fn confirm_rules(&mut self, agent_id: AccountId) {
        self.assert_owner_one_yocto();
        let now_ns = env::block_timestamp();
        let state = &mut self.agent_mut(&agent_id).state;
        let Some((pending, eta_ns)) = &state.pending else {
            env::panic_str(ERR_NO_PENDING_RULES)
        };
        require!(now_ns >= eta_ns.0, ERR_TOO_EARLY);
        // `set_rules` validated these before storing them; checked again (fail closed) so that
        // nothing invalid, such as the unreadable `sz_decimals` marker of D-11, takes effect.
        if let Err(field) = rules::validate_rules(pending) {
            invalid_rules(field)
        }
        let (rules, _) = state.pending.take().expect("checked above");
        state.rules = rules;
        state.rules_version += 1;
        events::rules_updated(&agent_id, state.rules_version, false);
    }

    /// Owner (1 yocto) or guardian (no deposit needed). Drops the pending rules. Panics
    /// `ERR_NO_PENDING_RULES` if there are none.
    #[payable]
    pub fn cancel_pending_rules(&mut self, agent_id: AccountId) {
        let caller = env::predecessor_account_id();
        if caller == self.owner_id {
            assert_one_yocto();
        } else {
            require!(self.is_guardian(&caller), ERR_NOT_OWNER_OR_GUARDIAN);
        }
        let state = &mut self.agent_mut(&agent_id).state;
        require!(state.pending.take().is_some(), ERR_NO_PENDING_RULES);
    }

    /// Owner or guardian, no deposit (a guardian function-call key can call it). Pauses every
    /// agent; pausing again replaces the reason. Panics `ERR_REASON_TOO_LONG` above 140 bytes
    /// (UTF-8), so a pause grows the contract state by at most 144 bytes: blocked receipts keep
    /// that much storage free (`record_blocked`), so the guardian can always pause.
    pub fn pause(&mut self, reason: String) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || self.is_guardian(&caller),
            ERR_NOT_OWNER_OR_GUARDIAN
        );
        require!(reason.len() <= MAX_REASON_BYTES, ERR_REASON_TOO_LONG);
        events::paused(&caller, &reason);
        self.paused = true;
        self.pause_reason = Some(reason);
    }

    /// Owner, 1 yocto. Lifts the pause (the guardian cannot).
    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner_one_yocto();
        self.paused = false;
        let cleared = self.pause_reason.take();
        events::unpaused(&self.owner_id, cleared.as_deref());
    }

    /// Owner, 1 yocto. Sets or clears the guardian.
    #[payable]
    pub fn set_guardian(&mut self, guardian_id: Option<AccountId>) {
        self.assert_owner_one_yocto();
        self.guardian_id = guardian_id;
    }

    /// Owner, 1 yocto. Deposit and static gas for each MPC `sign` call.
    #[payable]
    pub fn set_sign_config(&mut self, sign_deposit_yocto: U128, sign_gas_tgas: u64) {
        self.assert_owner_one_yocto();
        self.sign_deposit_yocto = sign_deposit_yocto.0;
        self.sign_gas_tgas = sign_gas_tgas;
    }
}

impl ClawGuard {
    /// Caller check first, then the deposit check.
    fn assert_owner_one_yocto(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            ERR_NOT_OWNER
        );
        assert_one_yocto();
    }

    fn is_guardian(&self, account_id: &AccountId) -> bool {
        self.guardian_id.as_ref() == Some(account_id)
    }

    fn agent_mut(&mut self, agent_id: &AccountId) -> &mut AgentRecord {
        self.agents
            .get_mut(agent_id)
            .unwrap_or_else(|| env::panic_str(ERR_NOT_AGENT))
    }
}

/// Owner rules in their stored form (addresses lowercase); panics `ERR_INVALID_RULES (<field>)`.
/// This is also where a market `sz_decimals` above 6 is refused as `ERR_INVALID_RULES (markets)`,
/// including one that was not a JSON integer from 0 to 255 at all (read as
/// `types::INVALID_SZ_DECIMALS`, owner decision D-11).
fn stored_rules(rules: Rules) -> Rules {
    rules::normalize_rules(rules).unwrap_or_else(|field| invalid_rules(field))
}

fn invalid_rules(field: &str) -> ! {
    env::panic_str(&format!("{ERR_INVALID_RULES} ({field})"))
}
