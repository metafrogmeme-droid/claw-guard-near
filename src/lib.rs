//! Helpers for the Claw Guard sandbox integration tests in `tests/`.
//! Sandbox only. Not audited.
//!
//! std only: [`contract_wasm`] runs `scripts/build_contracts.sh` once per test process and
//! hands back the two wasm paths, so a test never deploys a stale build (the script returns in
//! well under a second when nothing changed). The near-workspaces helpers themselves live in
//! `tests/common/mod.rs`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Cargo package name of the policy contract.
pub const CLAW_GUARD_CRATE: &str = "claw-guard";
/// Cargo package name of the sandbox-only MPC mock.
pub const MOCK_MPC_CRATE: &str = "mock-mpc";
/// Prebuilt artifacts: a directory laid out like `target/near`
/// (`<dir>/claw_guard/claw_guard.wasm`, `<dir>/mock_mpc/mock_mpc.wasm`). When set, the tests
/// deploy these files and do not run the build script (e.g. CI after a separate build step).
pub const WASM_DIR_ENV: &str = "CLAWGUARD_WASM_DIR";

/// Paths of the two contract wasm files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractWasm {
    pub claw_guard: PathBuf,
    pub mock_mpc: PathBuf,
}

/// The repository root (this package lives there).
pub fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// `<near_dir>/<lib>/<lib>.wasm`, the layout `scripts/build_contracts.sh` writes under
/// `<target>/near`.
pub fn wasm_path_in(near_dir: &Path, crate_name: &str) -> PathBuf {
    let lib = crate_name.replace('-', "_");
    near_dir.join(&lib).join(format!("{lib}.wasm"))
}

/// Builds both contracts (once per process) and returns their wasm paths. With
/// `CLAWGUARD_WASM_DIR` set it uses the files there instead and only checks that they exist.
pub fn contract_wasm() -> Result<&'static ContractWasm, String> {
    static WASM: OnceLock<Result<ContractWasm, String>> = OnceLock::new();
    WASM.get_or_init(|| match std::env::var_os(WASM_DIR_ENV) {
        Some(dir) => prebuilt_wasm(&repo_root().join(dir)),
        None => run_build_script(),
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn prebuilt_wasm(near_dir: &Path) -> Result<ContractWasm, String> {
    let wasm = ContractWasm {
        claw_guard: wasm_path_in(near_dir, CLAW_GUARD_CRATE),
        mock_mpc: wasm_path_in(near_dir, MOCK_MPC_CRATE),
    };
    for path in [&wasm.claw_guard, &wasm.mock_mpc] {
        if !path.is_file() {
            return Err(format!(
                "{} is missing (from {WASM_DIR_ENV}); build it or unset {WASM_DIR_ENV}",
                path.display()
            ));
        }
    }
    Ok(wasm)
}

fn run_build_script() -> Result<ContractWasm, String> {
    let script = repo_root().join("scripts").join("build_contracts.sh");
    let output = Command::new("bash")
        .arg(&script)
        .current_dir(repo_root())
        .output()
        .map_err(|e| format!("could not run {}: {e}", script.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} failed ({}):\n{}",
            script.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    parse_build_output(&String::from_utf8_lossy(&output.stdout))
}

/// Parses the script's stdout: one `<crate>=<path>` line per contract.
pub fn parse_build_output(stdout: &str) -> Result<ContractWasm, String> {
    let mut claw_guard = None;
    let mut mock_mpc = None;
    for line in stdout.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (name, path) = line
            .split_once('=')
            .ok_or_else(|| format!("unexpected build_contracts.sh output line: {line:?}"))?;
        let slot = match name {
            CLAW_GUARD_CRATE => &mut claw_guard,
            MOCK_MPC_CRATE => &mut mock_mpc,
            _ => return Err(format!("unknown contract in build output: {name:?}")),
        };
        *slot = Some(PathBuf::from(path));
    }
    match (claw_guard, mock_mpc) {
        (Some(claw_guard), Some(mock_mpc)) => Ok(ContractWasm {
            claw_guard,
            mock_mpc,
        }),
        _ => Err(format!(
            "build_contracts.sh did not report both wasm paths:\n{stdout}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_script_output() {
        let out = "claw-guard=/r/target/near/claw_guard/claw_guard.wasm\n\
                   mock-mpc=/r/target/near/mock_mpc/mock_mpc.wasm\n";
        assert_eq!(
            parse_build_output(out).unwrap(),
            ContractWasm {
                claw_guard: "/r/target/near/claw_guard/claw_guard.wasm".into(),
                mock_mpc: "/r/target/near/mock_mpc/mock_mpc.wasm".into(),
            }
        );
        assert!(parse_build_output("claw-guard=/a.wasm\n").is_err());
        assert!(parse_build_output("garbage\n").is_err());
        assert!(parse_build_output("other=/x.wasm\nclaw-guard=/a\nmock-mpc=/b\n").is_err());
    }

    #[test]
    fn wasm_paths_use_the_lib_name() {
        let path = wasm_path_in(Path::new("/r/target/near"), MOCK_MPC_CRATE);
        assert_eq!(path, Path::new("/r/target/near/mock_mpc/mock_mpc.wasm"));
        let path = wasm_path_in(Path::new("/r/target/near"), CLAW_GUARD_CRATE);
        assert_eq!(path, Path::new("/r/target/near/claw_guard/claw_guard.wasm"));
    }
}
