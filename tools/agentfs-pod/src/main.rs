//! AgentFS Pod helper: exposes an Xpod Pod container as an AgentFS lower
//! filesystem over the authenticated Pod HTTP surface, mounted via a userspace
//! NFS server (no system nfsd, no macFUSE on macOS).

mod fixture;
mod mount;
mod mount_control;
mod pod_fs;
mod session;
mod clean_cache;

use agentfs_sdk::FileSystem;
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use clean_cache::CleanBodyCache;
use session::SessionOverlay;
use pod_fs::{PodHttpFileSystem, ROOT_INO};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Parser)]
#[command(name = "agentfs-pod", version, about = "Mount an Xpod Pod as an AgentFS filesystem")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start the userspace NFS server and mount the Pod (daemon by default).
    Mount {
        /// Pod container URL, e.g. http://127.0.0.1:3000/alice/
        #[arg(long)]
        server: String,
        /// Directory to mount onto.
        #[arg(long)]
        mountpoint: PathBuf,
        /// Mount backend: userspace NFS or Linux FUSE.
        #[arg(long, default_value = "nfs")]
        backend: String,
        /// Bearer token used for Pod HTTP requests.
        #[arg(long, env = "XPOD_AGENTFS_TOKEN")]
        token: Option<String>,
        /// Durable pending-operation directory (survives restart).
        #[arg(long)]
        session_dir: Option<PathBuf>,
        /// Run in the foreground instead of daemonizing.
        #[arg(long)]
        foreground: bool,
    },
    /// Unmount a previously mounted Pod filesystem.
    Unmount {
        #[arg(long)]
        mountpoint: PathBuf,
        #[arg(long)]
        session_dir: Option<PathBuf>,
    },
    /// Flush any client-side pending operations to the Pod.
    Commit {
        #[arg(long)]
        pod_root: String,
        #[arg(long)]
        session_dir: Option<PathBuf>,
        #[arg(long, env = "XPOD_AGENTFS_TOKEN")]
        token: Option<String>,
    },
    /// Read-only reconciliation of prior requests whose receipts were lost.
    Recover {
        #[arg(long)]
        pod_root: String,
        #[arg(long)]
        session_dir: Option<PathBuf>,
        #[arg(long, env = "XPOD_AGENTFS_TOKEN")]
        token: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Report backend readiness without mounting.
    Status {
        #[arg(long, env = "XPOD_AGENTFS_TOKEN")]
        token: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Exercise the Pod backend against an in-process HTTP fixture (no OS mount).
    Selftest {
        #[arg(long)]
        json: bool,
    },
}

fn default_session_dir() -> PathBuf {
    if let Ok(value) = std::env::var("XPOD_AGENTFS_SESSION") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".xpod").join("agentfs")
}

fn uid_gid() -> (u32, u32) {
    unsafe { (libc::getuid(), libc::getgid()) }
}

fn session_binding(transport_root: &str) -> (String, String) {
    // The loopback transport port changes on every authentication proxy start.
    // Persist the canonical Pod and authenticated identity, never that port.
    let root = std::env::var("XPOD_AGENTFS_POD_ROOT").unwrap_or_else(|_| transport_root.to_string());
    let identity = std::env::var("XPOD_AGENTFS_IDENTITY").unwrap_or_else(|_| "direct-helper".into());
    (root, identity)
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Mount { server, mountpoint, backend, token, session_dir, foreground } => {
            run_mount(&server, &mountpoint, &backend, token, session_dir, foreground)
        }
        Command::Unmount { mountpoint, session_dir } => {
            run_unmount(&mountpoint, session_dir)
        }
        Command::Commit { pod_root, session_dir, token } => run_commit(&pod_root, session_dir, token),
        Command::Recover { pod_root, session_dir, token, json } => run_recover(&pod_root, session_dir, token, json),
        Command::Status { token, json } => run_status(token, json),
        Command::Selftest { json } => run_selftest(json),
    };
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("agentfs-pod: {error:#}");
            std::process::ExitCode::from(if error.downcast_ref::<MountPending>().is_some() || error.downcast_ref::<mount_control::PendingUnmount>().is_some() { 75 } else { 1 })
        }
    }
}

fn build_fs(
    server: &str,
    token: Option<String>,
    session_dir: Option<PathBuf>,
) -> Result<Arc<Mutex<dyn FileSystem + Send>>> {
    let (uid, gid) = uid_gid();
    let (pod_root, identity) = session_binding(server);
    let (overlay, clean) = match session_dir.as_deref() {
        Some(dir) => (
            Some(Arc::new(SessionOverlay::open(dir, &pod_root, &identity)?)),
            CleanBodyCache::open(dir, &pod_root, &identity)?.map(Arc::new),
        ),
        None => (None, None),
    };
    let fs = PodHttpFileSystem::new(server, token, uid, gid, overlay, clean)?;
    Ok(Arc::new(Mutex::new(fs)))
}

fn build_concrete(
    server: &str,
    token: Option<String>,
    session_dir: Option<PathBuf>,
) -> Result<Arc<PodHttpFileSystem>> {
    let (uid, gid) = uid_gid();
    let (pod_root, identity) = session_binding(server);
    let (overlay, clean) = match session_dir.as_deref() {
        Some(dir) => (
            Some(Arc::new(SessionOverlay::open(dir, &pod_root, &identity)?)),
            CleanBodyCache::open(dir, &pod_root, &identity)?.map(Arc::new),
        ),
        None => (None, None),
    };
    Ok(Arc::new(PodHttpFileSystem::new(server, token, uid, gid, overlay, clean)?))
}

#[derive(Debug)]
struct MountPending(String);
impl std::fmt::Display for MountPending {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str(&self.0) }
}
impl std::error::Error for MountPending {}

fn run_mount(
    server: &str,
    mountpoint: &PathBuf,
    backend: &str,
    token: Option<String>,
    session_dir: Option<PathBuf>,
    foreground: bool,
) -> Result<()> {
    if backend != "nfs" && backend != "fuse" {
        anyhow::bail!("unsupported mount backend: {backend}");
    }
    let mountpoint = mount::canonical_mountpoint(mountpoint)?;

    if !foreground {
        // Daemonize by re-execing ourselves in foreground mode and waiting for
        // the mount to become ready, so the caller can return immediately.
        let exe = std::env::current_exe().context("cannot resolve current executable")?;
        let mut command = std::process::Command::new(exe);
        command
            .arg("mount")
            .arg("--server")
            .arg(server)
            .arg("--mountpoint")
            .arg(&mountpoint)
            .arg("--backend")
            .arg(backend)
            .arg("--session-dir")
            .arg(session_dir.clone().unwrap_or_else(default_session_dir))
            .arg("--foreground")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Some(token) = &token {
            command.env("XPOD_AGENTFS_TOKEN", token);
        }
        let mut child = command.spawn().context("failed to start the mount daemon")?;
        match mount::wait_for_mount(&mountpoint, Duration::from_secs(15), backend, &session_dir.clone().unwrap_or_else(default_session_dir)) {
            Ok(_) => {
                println!("mounted at {}", mountpoint.display());
                return Ok(());
            }
            Err(primary) => {
                // A slow mount may already be serving kernel requests. Do not
                // kill its server, or pretend signal delivery is actual wait.
                use std::os::unix::process::ExitStatusExt;
                let detail = match child.try_wait() {
                    Ok(Some(status)) => {
                        if !status.success() && matches!(mount::mount_state(&mountpoint), mount::MountState::Absent) {
                            anyhow::bail!("{primary}; daemon pid={} actual_exit={:?} actual_signal={:?}", child.id(), status.code(), status.signal());
                        }
                        format!("{primary}; daemon pid={} actual_exit={:?} actual_signal={:?}; readiness unresolved", child.id(), status.code(), status.signal())
                    }
                    Ok(None) => format!("{primary}; daemon retained_pid={} pending actual_wait=null", child.id()),
                    Err(_) => format!("{primary}; daemon retained_pid={} pending actual_wait=null secondary=wait_error", child.id()),
                };
                return Err(MountPending(detail).into());
            }
        }
    }

    let session = session_dir.unwrap_or_else(default_session_dir);
    if backend == "fuse" {
        let concrete = build_concrete(server, token, Some(session.clone()))?;
        return run_fuse_owned(concrete, &session, &mountpoint);
    }
    mount::validate_local_session_path(&session)?;
    let fs = build_fs(server, token, Some(session.clone()))?;
    let control = Arc::new(mount_control::RuntimeControl::acquire(&session, &mountpoint)?);
    let runtime = agentfs::get_runtime();
    runtime.block_on(async move {
        let control_state = Arc::new(std::sync::Mutex::new(mount_control::State::default()));
        let mut completion = tokio::spawn(control.clone().serve(control_state.clone(), mountpoint.clone()));
        let mut command = match mount::mount_nfs(fs, &mountpoint).await {
            Ok((port, observation)) => {
                eprintln!("agentfs-pod: NFS server on 127.0.0.1:{port}; observing mount at {}", mountpoint.display());
                if let Err(error) = observation.require_success() {
                    eprintln!("agentfs-pod: {error}; preserving NFS server while mount state is unresolved");
                }
                Some(observation)
            }
            Err(_) => {
                eprintln!("agentfs-pod: NFS startup unresolved; preserving runtime and control");
                None
            }
        };
        let mut control_available = true;
        let mut binding_error_reported = false;
        let mut binding_ready = false;
        loop {
            if let Some(observation) = &mut command { observation.refresh(); }
            if !binding_ready && command.as_ref().is_some_and(|observation| observation.status.is_some_and(|status| status.success())) {
                if let mount::MountState::Mounted(identity) = mount::mount_state(&mountpoint) {
                    if identity.is_expected_nfs() {
                        let bound = control.bind_identity(&identity).and_then(|_| {
                            let mut state = control_state.lock().map_err(|_| anyhow::anyhow!("runtime state poisoned"))?;
                            state.binding = Some(mount_control::Binding::from_mount(&identity));
                            Ok(())
                        });
                        match bound {
                            Ok(()) => binding_ready = true,
                            Err(_) if !binding_error_reported => {
                                eprintln!("agentfs-pod: runtime binding unresolved; preserving NFS server");
                                binding_error_reported = true;
                            }
                            Err(_) => {},
                        }
                    }
                }
            }
            // Absent/Unknown/replaced table entries never retire the server.
            // Only the runtime-owned child's bound actual-unmount completion
            // permits ending this runtime and its independently held lease.
            tokio::select! {
                result = &mut completion, if control_available => {
                    match result {
                        Ok(Ok(())) if command.as_ref().is_some_and(|observation| observation.require_success().is_ok()) => break,
                        Ok(Ok(())) => {
                            eprintln!("agentfs-pod: completion proof inconsistent; preserving NFS server");
                            control_available = false;
                        }
                        _ => {
                            eprintln!("agentfs-pod: lifecycle control unresolved; preserving NFS server");
                            control_available = false;
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
            }
        }
        Ok::<(), anyhow::Error>(())
    })
}

// FUSE's blocking mount and the shared private control live in the actual
// daemon. Its lease is released only after actual mount-thread completion.
fn run_fuse_owned(fs: Arc<dyn agentfs_sdk::FileSystem>, session: &std::path::Path, target: &std::path::Path) -> Result<()> {
    mount::validate_local_session_path(session)?;
    let control = Arc::new(mount_control::RuntimeControl::acquire_for_backend(session, target, mount_control::Backend::Fuse)?);
    let target = target.to_path_buf();
    agentfs::get_runtime().block_on(async move {
        let state = Arc::new(std::sync::Mutex::new(mount_control::State::default()));
        let mut completion = tokio::spawn(control.clone().serve(state.clone(), target.clone()));
        let mount_target = target.clone();
        let mount_control = control.clone(); let mount_state = state.clone();
        let fsname = control.fuse_name()?;
        let created = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session_created = created.clone();
        let mut mount_task = tokio::task::spawn_blocking(move || mount::mount_fuse(fs, &mount_target, fsname, || {
            // This callback is inside the successful, still-owned FUSE Session.
            // Its unique fsname must match our owner, not a foreign startup mount.
            session_created.store(true, std::sync::atomic::Ordering::SeqCst);
            let identity = match mount::mount_state(&mount_target) {
                mount::MountState::Mounted(identity) => identity,
                _ => anyhow::bail!("owned FUSE session kernel binding unavailable"),
            };
            mount_control.bind_identity(&identity)?;
            mount_state.lock().map_err(|_| anyhow::anyhow!("runtime state poisoned"))?.binding = Some(mount_control::Binding::from_mount(&identity));
            Ok(())
        }));
        let mut mount_result = None;
        let mut control_available = true;
        loop {
            tokio::select! {
                result = &mut completion, if control_available => {
                    if !matches!(result, Ok(Ok(()))) {
                        control_available = false;
                        eprintln!("agentfs-pod: lifecycle control unresolved; preserving FUSE runtime");
                        continue;
                    }
                    // Successful OS-unmount completion alone cannot stand in
                    // for fuser's actual return; join the real blocking task.
                    if let Some(result) = mount_result { return result; }
                    return mount_task.await.context("FUSE mount task failed")?;
                }
                result = &mut mount_task, if mount_result.is_none() => {
                    let result = result.unwrap_or_else(|error| Err(anyhow::anyhow!("FUSE mount task failed: {error}")));
                    if !created.load(std::sync::atomic::Ordering::SeqCst) { completion.abort(); let _ = completion.await; return result.and_then(|_| Err(anyhow::anyhow!("FUSE startup ended before ownership binding"))); }
                    // External detach is not an owned actual-unmount proof.
                    // Retain control/lease; do not claim closure or stop proxy.
                    mount_result = Some(result);
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
            }
        }
    })
}

fn run_unmount(mountpoint: &PathBuf, session_dir: Option<PathBuf>) -> Result<()> {
    let target = mount::unmount_target(mountpoint)?;
    let session = session_dir.unwrap_or_else(default_session_dir);
    agentfs::get_runtime().block_on(async move {
        mount_control::unmount(&session, &target).await
    })
}

fn run_commit(pod_root: &str, session_dir: Option<PathBuf>, token: Option<String>) -> Result<()> {
    let dir = session_dir.unwrap_or_else(default_session_dir);
    let (canonical_root, identity) = session_binding(pod_root);
    let overlay = SessionOverlay::open(&dir, &canonical_root, &identity)?;
    let pending = overlay.pending_paths()?;
    if pending.is_empty() {
        println!("commit complete (no pending operations)");
        return Ok(());
    }
    let client = pod_fs::PodClient::new(pod_root, token)?;
    let report = overlay.commit(&client)?;
    println!(
        "commit applied={} conflicts={} errors={}",
        report.applied,
        report.conflicts.len(),
        report.errors.len()
    );
    for path in &report.conflicts {
        eprintln!("agentfs-pod: conflict kept for {path} (first baseline preserved)");
    }
    for error in &report.errors {
        eprintln!("agentfs-pod: pending kept: {error}");
    }
    if report.conflicts.is_empty() && report.errors.is_empty() {
        return Ok(());
    }
    anyhow::bail!(
        "{} pending operation(s) were not committed and were preserved",
        report.conflicts.len() + report.errors.len()
    )
}

fn run_recover(pod_root: &str, session_dir: Option<PathBuf>, token: Option<String>, json: bool) -> Result<()> {
    let dir = session_dir.unwrap_or_else(default_session_dir);
    let (canonical_root, identity) = session_binding(pod_root);
    let overlay = SessionOverlay::open(&dir, &canonical_root, &identity)?;
    let client = pod_fs::PodClient::new(pod_root, token)?;
    let report = overlay.recover(&client)?;
    if json { println!("{}", serde_json::to_string(&report)?); }
    else {
        println!("recovery confirmed={} retryable={} conflicts={} errors={}",
            report.confirmed.len(), report.retryable.len(), report.conflicts.len(), report.errors.len());
        for path in &report.confirmed { println!("confirmed: {path}"); }
        for path in &report.retryable { println!("retryable with original baseline: {path}"); }
        for path in &report.conflicts { eprintln!("conflict preserved: {path}"); }
        for error in &report.errors { eprintln!("unresolved: {error}"); }
    }
    if !report.conflicts.is_empty() || !report.errors.is_empty() {
        anyhow::bail!("recovery left unresolved operations; local content and original baselines preserved");
    }
    Ok(())
}

fn run_status(token: Option<String>, json: bool) -> Result<()> {
    let server = std::env::var("XPOD_AGENTFS_SERVER").unwrap_or_else(|_| "http://127.0.0.1:3000/".to_string());
    let client = pod_fs::PodClient::new(&server, token)?;
    let runtime = agentfs::get_runtime();
    let reachable = runtime.block_on(async { client.head("").await.is_ok() });
    if json {
        println!(
            "{{\"server\":\"{}\",\"reachable\":{},\"platform\":\"{}\",\"backend\":\"nfs\"}}",
            server,
            reachable,
            std::env::consts::OS
        );
    } else {
        println!("server: {server}");
        println!("reachable: {reachable}");
        println!("platform: {}", std::env::consts::OS);
        println!("backend: nfs (userspace NFS; no system nfsd required)");
    }
    Ok(())
}

struct Check {
    name: &'static str,
    ok: bool,
    detail: String,
}

fn run_selftest(json: bool) -> Result<()> {
    let pod = fixture::FixturePod::start(vec![
        ("alpha.txt".to_string(), "ALPHA_BODY_0123456789\n".to_string()),
        ("big.txt".to_string(), format!("{}\nBIG_END\n", "x".repeat(200_000))),
    ])
    .context("failed to start the in-process Pod fixture")?;

    let runtime = agentfs::get_runtime();
    let mut checks: Vec<Check> = Vec::new();

    runtime.block_on(async {
        let (uid, gid) = uid_gid();
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("selftest-token".to_string()), uid, gid, None, None)?;

        // readdir is metadata only.
        pod.reset_log();
        let names = fs.readdir(ROOT_INO).await?.unwrap_or_default();
        let body_gets = pod
            .log()
            .into_iter()
            .filter(|entry| entry.path.starts_with("/pod/") && entry.method == "GET")
            .count();
        checks.push(Check {
            name: "readdir-no-body",
            ok: names.iter().any(|name| name == "alpha.txt") && body_gets == 0,
            detail: format!("names={names:?} bodyGets={body_gets}"),
        });

        // stat metadata without body transfer.
        let stat = fs.lookup(ROOT_INO, "alpha.txt").await?;
        checks.push(Check {
            name: "stat-size",
            ok: stat.as_ref().map(|value| value.size) == Some(22),
            detail: format!("size={:?}", stat.as_ref().map(|value| value.size)),
        });

        // Range read returns exactly the requested slice.
        let ino = fs
            .lookup(ROOT_INO, "alpha.txt")
            .await?
            .map(|_| 0)
            .unwrap_or(0);
        let _ = ino;
        let handle = open_path(&fs, "alpha.txt", libc::O_RDONLY).await?;
        pod.reset_log();
        let slice = handle.pread(6, 9).await?;
        let ranged_bytes: usize = pod.log().iter().map(|entry| entry.response_bytes).sum();
        checks.push(Check {
            name: "range-read",
            ok: String::from_utf8_lossy(&slice) == "BODY_0123" && ranged_bytes == 9,
            detail: format!("slice={:?} bytes={ranged_bytes}", String::from_utf8_lossy(&slice)),
        });

        // Conditional create + write-through.
        let (_, created) = fs.create_file(ROOT_INO, "created.txt", 0o644, uid, gid).await?;
        created.pwrite(0, b"HELLO").await?;
        checks.push(Check {
            name: "conditional-create-write",
            ok: pod.body("created.txt").as_deref() == Some("HELLO"),
            detail: format!("body={:?}", pod.body("created.txt")),
        });

        // Second create must conflict instead of overwriting.
        let conflict = fs.create_file(ROOT_INO, "created.txt", 0o644, uid, gid).await.is_err();
        checks.push(Check { name: "create-conflict", ok: conflict, detail: format!("conflict={conflict}") });

        // External modification is observed (no body cache).
        pod.mutate("alpha.txt", "REMOTE_UPDATE\n");
        let reread = open_path(&fs, "alpha.txt", libc::O_RDONLY).await?;
        let fresh = reread.pread(0, 64).await?;
        checks.push(Check {
            name: "external-update-visible",
            ok: String::from_utf8_lossy(&fresh) == "REMOTE_UPDATE\n",
            detail: format!("fresh={:?}", String::from_utf8_lossy(&fresh)),
        });

        // Stale version overwrite must fail rather than clobber the remote.
        let handle = open_path(&fs, "alpha.txt", libc::O_RDWR).await?;
        pod.mutate("alpha.txt", "REMOTE_MOVED_ON\n");
        let stale = handle.pwrite(0, b"LOCAL\n").await;
        checks.push(Check {
            name: "stale-write-conflict",
            ok: stale.is_err() && pod.body("alpha.txt").as_deref() == Some("REMOTE_MOVED_ON\n"),
            detail: format!("stale={:?}", stale.err().map(|error| error.to_string())),
        });

        Ok::<(), anyhow::Error>(())
    })?;

    let all_ok = checks.iter().all(|check| check.ok);
    if json {
        let payload = serde_json::json!({
            "status": if all_ok { "pass" } else { "fail" },
            "checks": checks.iter().map(|check| serde_json::json!({
                "name": check.name,
                "ok": check.ok,
                "detail": check.detail,
            })).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else {
        for check in &checks {
            println!("{} {}: {}", if check.ok { "PASS" } else { "FAIL" }, check.name, check.detail);
        }
    }
    if all_ok {
        Ok(())
    } else {
        anyhow::bail!("selftest failed")
    }
}

async fn open_path(fs: &PodHttpFileSystem, path: &str, flags: i32) -> Result<agentfs_sdk::BoxedFile> {
    let stats = fs
        .lookup(ROOT_INO, path)
        .await?
        .ok_or_else(|| anyhow::anyhow!("{path} not found"))?;
    let ino = stats.ino;
    fs.open(ino, flags).await.map_err(Into::into)
}

#[cfg(test)]
mod mount_lifecycle_tests {
    use super::*;

    #[test]
    fn only_typed_daemon_pending_uses_pending_failure_code() {
        let error: anyhow::Error = MountPending("fixture pending actual_wait=null".into()).into();
        assert!(error.downcast_ref::<MountPending>().is_some());
        assert!(anyhow::anyhow!("ordinary failure").downcast_ref::<MountPending>().is_none());
    }
}
