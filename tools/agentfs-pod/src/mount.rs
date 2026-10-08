//! Userspace NFS mount for the Pod filesystem.
//!
//! Reuses the pinned upstream `nfsserve` userspace NFS server and `AgentNFS`
//! adapter (`agentfs::nfsserve`, `agentfs::nfs`). It does **not** require a
//! system `nfsd`; only the final `mount_nfs`/`mount` syscall needs mount
//! privilege. We mount with `noac,actimeo=0` so the kernel NFS client does not
//! mask external Pod modifications (upstream's default NFS options cache
//! attributes and would violate the Pod cache-invalidation requirement).

use agentfs::nfs::AgentNFS;
use agentfs::nfsserve::tcp::{NFSTcp, NFSTcpListener};
use agentfs_sdk::FileSystem;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const DEFAULT_NFS_PORT: u32 = 11111;

pub fn find_available_port(start: u32) -> Result<u32> {
    for port in start..start + 100 {
        if std::net::TcpListener::bind(format!("127.0.0.1:{port}")).is_ok() {
            return Ok(port);
        }
    }
    anyhow::bail!("no free localhost port in {start}..{}", start + 100)
}

/// Start the userspace NFS server and mount it. Returns the bound port.
/// The caller must keep the returned runtime alive (foreground mode) or spawn a
/// detached child (daemon mode).
pub async fn mount_nfs(fs: Arc<Mutex<dyn FileSystem + Send>>, mountpoint: &Path) -> Result<u32> {
    if !mountpoint.exists() {
        anyhow::bail!("mountpoint does not exist: {}", mountpoint.display());
    }
    let nfs = AgentNFS::new(fs);
    let port = find_available_port(DEFAULT_NFS_PORT)?;
    let listener = NFSTcpListener::bind(&format!("127.0.0.1:{port}"), nfs)
        .await
        .context("failed to bind the userspace NFS server")?;
    tokio::spawn(async move {
        if let Err(error) = listener.handle_forever().await {
            eprintln!("agentfs-pod: NFS server error: {error}");
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    mount_syscall(port, mountpoint)?;
    Ok(port)
}

pub fn wait_for_mount(mountpoint: &Path, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if is_mountpoint(mountpoint) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg(unix)]
pub fn is_mountpoint(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let Some(parent) = path.parent() else {
        return false;
    };
    if parent.as_os_str().is_empty() {
        return false;
    }
    match std::fs::metadata(parent) {
        Ok(parent_meta) => meta.dev() != parent_meta.dev(),
        Err(_) => false,
    }
}

#[cfg(not(unix))]
pub fn is_mountpoint(_path: &Path) -> bool {
    false
}

#[cfg(target_os = "macos")]
fn mount_syscall(port: u32, mountpoint: &Path) -> Result<()> {
    let options = format!(
        "locallocks,vers=3,tcp,port={port},mountport={port},soft,timeo=100,retrans=2,noac,actimeo=0,nobrowse"
    );
    let output = Command::new("/sbin/mount_nfs")
        .args(["-o", &options, "127.0.0.1:/", &mountpoint.to_string_lossy()])
        .output()
        .context("failed to execute /sbin/mount_nfs")?;
    if !output.status.success() {
        anyhow::bail!(
            "mount_nfs failed (mount privilege is required; userspace nfsd is NOT needed): {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn mount_syscall(port: u32, mountpoint: &Path) -> Result<()> {
    let options = format!(
        "vers=3,tcp,port={port},mountport={port},nolock,soft,timeo=100,retrans=2,noac,actimeo=0"
    );
    let output = Command::new("mount")
        .args(["-t", "nfs", "-o", &options, "127.0.0.1:/", &mountpoint.to_string_lossy()])
        .output()
        .context("failed to execute mount")?;
    if !output.status.success() {
        anyhow::bail!(
            "mount -t nfs failed (mount privilege is required; userspace nfsd is NOT needed): {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn mount_syscall(_port: u32, _mountpoint: &Path) -> Result<()> {
    anyhow::bail!("NFS mount is only implemented for macOS and Linux")
}

pub fn unmount(mountpoint: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/sbin/umount");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("umount");
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let mut command = Command::new("umount");

    let output = command.arg(mountpoint).output().context("failed to execute umount")?;
    if output.status.success() {
        return Ok(());
    }
    // Force/lazy fallback.
    #[cfg(target_os = "macos")]
    let mut force = Command::new("/sbin/umount");
    #[cfg(not(target_os = "macos"))]
    let mut force = Command::new("umount");
    #[cfg(target_os = "linux")]
    force.arg("-l");
    #[cfg(target_os = "macos")]
    force.arg("-f");
    let forced = force.arg(mountpoint).output();
    if matches!(forced, Ok(result) if result.status.success()) {
        return Ok(());
    }
    anyhow::bail!("umount failed: {}", String::from_utf8_lossy(&output.stderr).trim())
}

/// Linux FUSE backend: reuses the pinned upstream `agentfs::fuse::mount`
/// (no fuser/sandbox dependency added). `auto_unmount=false` keeps it working
/// without fusermount3 on a minimal container.
#[cfg(target_os = "linux")]
pub fn mount_fuse(fs: Arc<dyn agentfs_sdk::FileSystem>, mountpoint: &Path) -> Result<()> {
    use agentfs::fuse::FuseMountOptions;
    let opts = FuseMountOptions {
        mountpoint: mountpoint.to_path_buf(),
        auto_unmount: false,
        allow_root: false,
        allow_other: false,
        fsname: "agentfs-pod".to_string(),
        uid: None,
        gid: None,
    };
    agentfs::fuse::mount(fs, opts, agentfs::get_runtime())
}

#[cfg(target_os = "linux")]
pub fn fuse_available() -> bool {
    Path::new("/dev/fuse").exists()
}

#[cfg(not(target_os = "linux"))]
pub fn mount_fuse(_fs: Arc<dyn agentfs_sdk::FileSystem>, _mountpoint: &Path) -> Result<()> {
    anyhow::bail!("FUSE is only supported on Linux")
}

pub fn canonical_mountpoint(mountpoint: &Path) -> Result<PathBuf> {
    if !mountpoint.exists() {
        anyhow::bail!("mountpoint does not exist: {}", mountpoint.display());
    }
    Ok(std::fs::canonicalize(mountpoint)?)
}
