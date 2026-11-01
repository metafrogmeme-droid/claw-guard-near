//! NEP-297 events, logged as
//! `EVENT_JSON:{"standard":"clawguard","version":"1.0.0","event":"<name>","data":[{...}]}`.
//!
//! `data` is always a one-element array. Ids and timestamps are decimal strings (like the
//! receipt JSON), versions are numbers, targets and rule codes use their wire names.

use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, Value, json};
use near_sdk::{AccountId, env};

use crate::errors::RuleCode;
use crate::types::Target;

pub const STANDARD: &str = "clawguard";
pub const VERSION: &str = "1.0.0";

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Envelope<'a> {
    standard: &'a str,
    version: &'a str,
    event: &'a str,
    data: [Value; 1],
}

fn emit(event: &str, data: Value) {
    let envelope = Envelope {
        standard: STANDARD,
        version: VERSION,
        event,
        data: [data],
    };
    let json = serde_json::to_string(&envelope).expect("event serializes");
    env::log_str(&format!("EVENT_JSON:{json}"));
}

pub fn agent_registered(agent_id: &AccountId, rules_version: u32) {
    emit(
        "agent_registered",
        json!({"agent_id": agent_id, "rules_version": rules_version}),
    );
}

pub fn agent_removed(agent_id: &AccountId, rules_version: u32) {
    emit(
        "agent_removed",
        json!({"agent_id": agent_id, "rules_version": rules_version}),
    );
}

pub fn rules_updated(agent_id: &AccountId, rules_version: u32, tightened: bool) {
    emit(
        "rules_updated",
        json!({"agent_id": agent_id, "rules_version": rules_version, "tightened": tightened}),
    );
}

pub fn rules_pending(agent_id: &AccountId, eta_ns: u64) {
    emit(
        "rules_pending",
        json!({"agent_id": agent_id, "eta_ns": eta_ns.to_string()}),
    );
}

pub fn order_blocked(
    receipt_id: u64,
    agent_id: &AccountId,
    target: Target,
    rule_code: RuleCode,
    message: &str,
) {
    emit(
        "order_blocked",
        json!({
            "receipt_id": receipt_id.to_string(),
            "agent_id": agent_id,
            "target": target,
            "rule_code": rule_code,
            "message": message,
        }),
    );
}

pub fn order_allowed(
    receipt_id: u64,
    agent_id: &AccountId,
    target: Target,
    payload_hash: &str,
    derivation_path: &str,
) {
    emit(
        "order_allowed",
        json!({
            "receipt_id": receipt_id.to_string(),
            "agent_id": agent_id,
            "target": target,
            "payload_hash": payload_hash,
            "derivation_path": derivation_path,
        }),
    );
}

pub fn signature_ready(receipt_id: u64, payload_hash: &str) {
    emit(
        "signature_ready",
        json!({"receipt_id": receipt_id.to_string(), "payload_hash": payload_hash}),
    );
}

pub fn signature_failed(receipt_id: u64, reason: &str) {
    emit(
        "signature_failed",
        json!({"receipt_id": receipt_id.to_string(), "reason": reason}),
    );
}

pub fn paused(by: &AccountId, reason: &str) {
    emit("paused", json!({"by": by, "reason": reason}));
}

/// `reason` is the pause reason that was cleared (`null` if the guard was not paused).
pub fn unpaused(by: &AccountId, reason: Option<&str>) {
    emit("unpaused", json!({"by": by, "reason": reason}));
}

/// Test helper: the parsed `EVENT_JSON` logs of the current mocked call.
#[cfg(test)]
pub(crate) fn logged_events() -> Vec<Value> {
    near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).expect("event is JSON"))
        .collect()
}
