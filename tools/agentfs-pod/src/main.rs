//! AgentFS Pod helper: exposes an Xpod Pod container as an AgentFS lower
//! filesystem over the authenticated Pod HTTP surface, mounted via a userspace
//! NFS server (no system nfsd, no macFUSE on macOS).

mod fixture;
mod mount;
mod pod_fs;
mod session;

use agentfs_sdk::FileSystem;
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
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
            let _ = session_dir;
            mount::unmount(&mountpoint).map_err(Into::into)
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
            std::process::ExitCode::from(1)
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
    let overlay = session_dir
        .map(|dir| SessionOverlay::open(&dir, &pod_root, &identity).map(Arc::new))
        .transpose()?;
    let fs = PodHttpFileSystem::new(server, token, uid, gid, overlay)?;
    Ok(Arc::new(Mutex::new(fs)))
}

fn build_concrete(
    server: &str,
    token: Option<String>,
    session_dir: Option<PathBuf>,
) -> Result<Arc<PodHttpFileSystem>> {
    let (uid, gid) = uid_gid();
    let (pod_root, identity) = session_binding(server);
    let overlay = session_dir
        .map(|dir| SessionOverlay::open(&dir, &pod_root, &identity).map(Arc::new))
        .transpose()?;
    Ok(Arc::new(PodHttpFileSystem::new(server, token, uid, gid, overlay)?))
}

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
    if mount::is_mountpoint(&mountpoint) {
        anyhow::bail!("mountpoint is already mounted: {}", mountpoint.display());
    }

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
        let child = command.spawn().context("failed to start the mount daemon")?;
        if mount::wait_for_mount(&mountpoint, Duration::from_secs(15)) {
            println!("mounted {} at {}", server, mountpoint.display());
            std::mem::forget(child);
            return Ok(());
        }
        let mut child = child;
        let _ = child.kill();
        anyhow::bail!("mount did not become ready within 15s (is mount privilege available?)");
    }

    let session = session_dir.unwrap_or_else(default_session_dir);
    if backend == "fuse" {
        let concrete = build_concrete(server, token, Some(session.clone()))?;
        // Upstream fuser::mount2 blocks until this mount is unmounted. Polling
        // the path afterwards can attach our lifetime to a later remount and
        // leave the old daemon alive indefinitely.
        mount::mount_fuse(concrete, &mountpoint)?;
        return Ok(());
    }
    let fs = build_fs(server, token, Some(session))?;
    let runtime = agentfs::get_runtime();
    runtime.block_on(async move {
        let port = mount::mount_nfs(fs, &mountpoint).await?;
        use std::os::unix::fs::MetadataExt;
        let device = std::fs::metadata(&mountpoint)?.dev();
        eprintln!("agentfs-pod: NFS server on 127.0.0.1:{port}; mounted at {}", mountpoint.display());
        // Stay alive until the mount disappears (e.g. `agentfs-pod unmount`).
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if !mount::is_mountpoint(&mountpoint) || std::fs::metadata(&mountpoint).map(|metadata| metadata.dev()).ok() != Some(device) {
                break;
            }
        }
        Ok::<(), anyhow::Error>(())
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
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("selftest-token".to_string()), uid, gid, None)?;

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
