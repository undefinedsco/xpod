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
use std::process::{Child, Command, ExitStatus, Stdio};
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
pub async fn mount_nfs(fs: Arc<Mutex<dyn FileSystem + Send>>, mountpoint: &Path) -> Result<(u32, CommandObservation)> {
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
    let target = mountpoint.to_path_buf();
    let observation = tokio::task::spawn_blocking(move || mount_syscall(port, &target)).await??;
    Ok((port, observation))
}

const STARTUP_OBSERVATION: Duration = Duration::from_secs(15);
pub(crate) const UNMOUNT_OBSERVATION: Duration = Duration::from_secs(300);

/// An observation deadline is not cancellation or proof that the child exited.
pub struct CommandObservation {
    stage: &'static str,
    pub child: Child,
    pub status: Option<ExitStatus>,
    wait_error: Option<String>,
}

impl CommandObservation {
    pub fn refresh(&mut self) {
        if self.status.is_none() {
            match self.child.try_wait() {
                Ok(status) => { self.status = status; self.wait_error = None; }
                Err(error) => self.wait_error = Some(error.to_string()),
            }
        }
    }

    pub fn require_success(&self) -> Result<()> {
        use std::os::unix::process::ExitStatusExt;
        match self.status {
            Some(status) if status.success() => Ok(()),
            Some(status) => anyhow::bail!(
                "{} pid={} actual_exit={:?} actual_signal={:?}",
                self.stage, self.child.id(), status.code(), status.signal()
            ),
            None => anyhow::bail!(
                "{} pid={} pending actual_wait=null{}",
                self.stage, self.child.id(),
                if self.wait_error.is_some() { " wait_error=true" } else { " observation_timeout=true" }
            ),
        }
    }
}

pub(crate) fn observe_command(command: &mut Command, stage: &'static str, timeout: Duration) -> Result<CommandObservation> {
    let mut observation = spawn_command(command, stage)?;
    let start = Instant::now();
    loop {
        observation.refresh();
        if observation.status.is_some() || observation.wait_error.is_some() || start.elapsed() >= timeout {
            return Ok(observation);
        }
        std::thread::sleep(Duration::from_millis(10).min(timeout.saturating_sub(start.elapsed())));
    }
}

pub(crate) fn spawn_command(command: &mut Command, stage: &'static str) -> Result<CommandObservation> {
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let child = command.spawn().with_context(|| format!("{stage} spawn failed"))?;
    Ok(CommandObservation { stage, child, status: None, wait_error: None })
}

#[cfg(test)]
/// Spawn a command whose stdin is configured by the caller. Redirection through
/// `Stdio` keeps this on the `posix_spawn` fast path; with no `pre_exec` hook
/// there is no fork-before-exec window in which an unrelated parallel child
/// could inherit the caller's descriptors.
pub(crate) fn spawn_stdin_command(command: &mut Command, stage: &'static str) -> Result<CommandObservation> {
    command.stdout(Stdio::null()).stderr(Stdio::null());
    let child = command.spawn().with_context(|| format!("{stage} spawn failed"))?;
    Ok(CommandObservation { stage, child, status: None, wait_error: None })
}

pub(crate) fn spawn_unmount(target: &Path) -> Result<CommandObservation> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/sbin/umount");
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new("umount");
    spawn_command(command.arg(target), "umount")
}

/// Resolve only a verified local parent, never stat the mounted target.
pub fn unmount_target(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir()?.join(path) };
    let name = absolute.file_name().context("unmount target name missing")?;
    let parent = absolute.parent().context("unmount target parent missing")?;
    Ok(canonical_mountpoint(parent)?.join(name))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountIdentity {
    pub target: PathBuf,
    pub(crate) source: Vec<u8>,
    pub(crate) filesystem: Vec<u8>,
    pub(crate) id: Vec<u8>,
}

impl MountIdentity {
    pub fn is_expected_fuse(&self) -> bool {
        (self.filesystem == b"fuse" || self.filesystem == b"fuse.agentfs-pod") && self.source == b"agentfs-pod"
    }

    pub fn is_expected_nfs(&self) -> bool {
        self.filesystem == b"nfs" && self.source == b"127.0.0.1:/"
    }
}

#[derive(Clone, Debug)]
pub enum MountState {
    Mounted(MountIdentity),
    Absent,
    Unknown(String),
}

fn state_from_snapshot(path: &Path, snapshot: Result<Vec<MountIdentity>>) -> MountState {
    match snapshot {
        Ok(entries) => {
            let mut matching = entries.into_iter().filter(|entry| entry.target == path);
            match (matching.next(), matching.next()) {
                (None, _) => MountState::Absent,
                (Some(entry), None) => MountState::Mounted(entry),
                _ => MountState::Unknown("multiple mounts at target".into()),
            }
        }
        Err(error) => MountState::Unknown(error.to_string()),
    }
}

pub fn mount_state(path: &Path) -> MountState {
    if !path.is_absolute() { return MountState::Unknown("mount observation requires an absolute recorded target".into()); }
    state_from_snapshot(path, mount_snapshot())
}

pub fn wait_for_mount(mountpoint: &Path, timeout: Duration, backend: &str, session: &Path) -> Result<MountIdentity> {
    let start = Instant::now();
    loop {
        match mount_state(mountpoint) {
            MountState::Mounted(identity) if backend == "nfs" && identity.is_expected_nfs() => {
                if crate::mount_control::ready(session, mountpoint, &identity)? { return Ok(identity); }
            },
            MountState::Mounted(identity) if backend == "fuse" && identity.is_expected_fuse() => return Ok(identity),
            MountState::Mounted(_) => anyhow::bail!("unexpected mount at startup target"),
            MountState::Unknown(error) => anyhow::bail!("mount readiness unknown: {error}"),
            MountState::Absent => {},
        }
        if start.elapsed() >= timeout { anyhow::bail!("mount readiness observation timed out"); }
        std::thread::sleep(Duration::from_millis(100).min(timeout.saturating_sub(start.elapsed())));
    }
}

// Linux mountinfo escapes are byte encodings, not shell quoting or URL escapes.
#[cfg(any(target_os = "linux", test))]
fn mountinfo_decode(value: &[u8]) -> Result<Vec<u8>> {
    let mut decoded = Vec::new();
    let mut i = 0;
    while i < value.len() {
        if value[i] == b'\\' {
            let escape = value.get(i + 1..i + 4).context("truncated mountinfo escape")?;
            let byte = match escape { b"040" => b' ', b"011" => b'\t', b"012" => b'\n', b"134" => b'\\', _ => anyhow::bail!("invalid mountinfo escape") };
            decoded.push(byte); i += 4;
        } else { decoded.push(value[i]); i += 1; }
    }
    Ok(decoded)
}

#[cfg(any(target_os = "linux", test))]
fn parse_mountinfo(bytes: &[u8]) -> Result<Vec<MountIdentity>> {
    use std::os::unix::ffi::OsStringExt;
    if bytes.is_empty() || !bytes.ends_with(b"\n") { anyhow::bail!("empty or truncated mountinfo"); }
    let mut entries = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
        let fields: Vec<&[u8]> = line.split(|byte| *byte == b' ').collect();
        let separator = fields.iter().position(|field| *field == b"-").context("missing mountinfo separator")?;
        if separator < 6 || fields.len() != separator + 4 { anyhow::bail!("malformed mountinfo row"); }
        let id = std::str::from_utf8(fields[0])?.parse::<u64>()?;
        std::str::from_utf8(fields[1])?.parse::<u64>()?;
        entries.push(MountIdentity {
            target: PathBuf::from(std::ffi::OsString::from_vec(mountinfo_decode(fields[4])?)),
            source: mountinfo_decode(fields[separator + 2])?,
            filesystem: fields[separator + 1].to_vec(),
            id: id.to_ne_bytes().to_vec(),
        });
    }
    Ok(entries)
}

#[cfg(target_os = "linux")]
fn mount_snapshot() -> Result<Vec<MountIdentity>> {
    use std::io::Read;
    const LIMIT: u64 = 8 * 1024 * 1024;
    let mut bytes = Vec::new();
    std::fs::File::open("/proc/self/mountinfo")?.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT { anyhow::bail!("mountinfo exceeds observation limit"); }
    parse_mountinfo(&bytes)
}

#[cfg(target_os = "macos")]
fn mount_snapshot() -> Result<Vec<MountIdentity>> {
    use std::os::unix::ffi::OsStringExt;
    fn name(value: &[libc::c_char]) -> Result<Vec<u8>> {
        let end = value.iter().position(|byte| *byte == 0).context("unterminated mount name")?;
        Ok(value[..end].iter().map(|byte| *byte as u8).collect())
    }
    for _ in 0..3 {
        // SAFETY: existing locked libc owns the Darwin layout and signature.
        // NOWAIT reads retained kernel mount information, never target metadata.
        let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
        if count < 0 { return Err(std::io::Error::last_os_error().into()); }
        if count == 0 { anyhow::bail!("empty kernel mount snapshot"); }
        let capacity = usize::try_from(count)?.checked_add(16).context("mount count overflow")?;
        if capacity > 65536 { anyhow::bail!("mount snapshot exceeds observation limit"); }
        let size = capacity.checked_mul(std::mem::size_of::<libc::statfs>()).context("mount buffer overflow")?;
        let mut records: Vec<libc::statfs> = (0..capacity).map(|_| unsafe { std::mem::zeroed() }).collect();
        let filled = unsafe { libc::getfsstat(records.as_mut_ptr(), i32::try_from(size)?, libc::MNT_NOWAIT) };
        if filled < 0 { return Err(std::io::Error::last_os_error().into()); }
        if filled as usize >= capacity { continue; }
        records.truncate(filled as usize);
        let mut entries = Vec::new();
        for record in records {
            // fsid is kernel observation identity, not cryptographic ownership.
            // SAFETY: opaque fsid storage is initialized by zeroing and
            // getfsstat. Read only its actual libc-provided size/layout.
            let id = unsafe { std::slice::from_raw_parts(
                (&record.f_fsid as *const libc::fsid_t).cast::<u8>(),
                std::mem::size_of::<libc::fsid_t>()
            ) }.to_vec();
            entries.push(MountIdentity {
                target: PathBuf::from(std::ffi::OsString::from_vec(name(&record.f_mntonname)?)),
                source: name(&record.f_mntfromname)?, filesystem: name(&record.f_fstypename)?, id,
            });
        }
        return Ok(entries);
    }
    anyhow::bail!("mount snapshot changed during bounded observation")
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn mount_snapshot() -> Result<Vec<MountIdentity>> { anyhow::bail!("mount observation unsupported on this platform") }

#[cfg(target_os = "macos")]
fn mount_syscall(port: u32, mountpoint: &Path) -> Result<CommandObservation> {
    let options = format!("locallocks,vers=3,tcp,port={port},mountport={port},soft,timeo=100,retrans=2,noac,actimeo=0,nobrowse");
    observe_command(Command::new("/sbin/mount_nfs").args(["-o", &options, "127.0.0.1:/"]).arg(mountpoint), "mount_nfs", STARTUP_OBSERVATION)
}

#[cfg(target_os = "linux")]
fn mount_syscall(port: u32, mountpoint: &Path) -> Result<CommandObservation> {
    let options = format!("vers=3,tcp,port={port},mountport={port},nolock,soft,timeo=100,retrans=2,noac,actimeo=0");
    observe_command(Command::new("mount").args(["-t", "nfs", "-o", &options, "127.0.0.1:/"]).arg(mountpoint), "mount", STARTUP_OBSERVATION)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn mount_syscall(_port: u32, _mountpoint: &Path) -> Result<CommandObservation> { anyhow::bail!("NFS mount unsupported on this platform") }

pub fn unmount(mountpoint: &Path) -> Result<CommandObservation> {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/sbin/umount");
    #[cfg(not(target_os = "macos"))]
    let mut command = Command::new("umount");
    let observation = observe_command(command.arg(mountpoint), "umount", UNMOUNT_OBSERVATION)?;
    // Dropping Child does not kill it. A pending flush remains unresolved;
    // the normal API never force/lazy detaches or pretends it was waited.
    observation.require_success()?;
    match mount_state(mountpoint) {
        MountState::Absent => {
            eprintln!("agentfs-pod: umount pid={} actual_exit=0 actual_signal=null", observation.child.id());
            Ok(observation)
        },
        MountState::Mounted(_) => anyhow::bail!("umount pid={} actual_exit=0 but target remains mounted", observation.child.id()),
        MountState::Unknown(error) => anyhow::bail!("umount pid={} actual_exit=0 but mount absence unknown: {error}", observation.child.id()),
    }
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

pub fn validate_local_session_path(mountpoint: &Path) -> Result<()> {
    // Reject mounted ancestors before resolving symlinks or touching the path.
    // A fresh lexical local target is the only supported startup input.
    let absolute = if mountpoint.is_absolute() { mountpoint.to_path_buf() } else { std::env::current_dir()?.join(mountpoint) };
    if absolute.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        anyhow::bail!("startup mountpoint must not contain parent traversal");
    }
    let entries = mount_snapshot()?;
    ensure_fresh_local(&absolute, entries.clone())?;
    validate_local_resolution(&absolute, &entries, 0)?;
    Ok(())
}

pub fn canonical_mountpoint(mountpoint: &Path) -> Result<PathBuf> {
    validate_local_session_path(mountpoint)?;
    if !mountpoint.exists() {
        anyhow::bail!("mountpoint does not exist: {}", mountpoint.display());
    }
    let canonical = std::fs::canonicalize(mountpoint)?;
    ensure_fresh_local(&canonical, mount_snapshot()?)?;
    Ok(canonical)
}

fn ensure_fresh_local(path: &Path, entries: Vec<MountIdentity>) -> Result<()> {
    for entry in entries {
        if entry.target == path { anyhow::bail!("startup target is already mounted"); }
        if path.starts_with(&entry.target) && (entry.filesystem == b"nfs" || entry.filesystem == b"nfs4") {
            anyhow::bail!("startup target is inside an existing NFS mount");
        }
    }
    Ok(())
}

// Follow symlinks only while each prefix is known to be outside existing NFS.
// canonicalize itself stays at the fresh-local startup boundary afterwards.
fn validate_local_resolution(path: &Path, entries: &[MountIdentity], depth: usize) -> Result<()> {
    if depth >= 40 { anyhow::bail!("too many startup symlinks"); }
    let mut prefix = PathBuf::new();
    for component in path.components() {
        prefix.push(component.as_os_str());
        if entries.iter().any(|entry| prefix.starts_with(&entry.target) && (entry.filesystem == b"nfs" || entry.filesystem == b"nfs4")) {
            anyhow::bail!("startup path resolves inside existing NFS mount");
        }
        let metadata = match std::fs::symlink_metadata(&prefix) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            let destination = std::fs::read_link(&prefix)?;
            let replacement = if destination.is_absolute() { destination } else { prefix.parent().context("symlink parent missing")?.join(destination) };
            let replacement = replacement.join(path.strip_prefix(&prefix)?);
            let mut normalized = PathBuf::new();
            for part in replacement.components() {
                match part {
                    std::path::Component::ParentDir => { if !normalized.pop() { anyhow::bail!("startup path escapes root"); } }
                    std::path::Component::CurDir => {},
                    _ => normalized.push(part.as_os_str()),
                }
            }
            ensure_fresh_local(&normalized, entries.to_vec())?;
            return validate_local_resolution(&normalized, entries, depth + 1);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn barrier_command() -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read release; exit 0"]);
        command
    }

    #[test]
    fn unmount_resolves_only_local_parent_alias_without_touching_target() {
        use std::os::unix::ffi::OsStringExt;
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
            .join(".test-data/agent-directory-workers/gpt-6.1-sol-native-mount-lifecycle-design/path-fixtures");
        std::fs::create_dir_all(&root).unwrap();
        let directory = root.join(format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&directory).unwrap();
        let parent = directory.join("parent"); std::fs::create_dir(&parent).unwrap();
        let alias = directory.join("alias"); std::os::unix::fs::symlink(&parent, &alias).unwrap();
        let target = std::ffi::OsString::from_vec(vec![b't', 0xff]);
        assert_eq!(unmount_target(&alias.join(&target)).unwrap(), std::fs::canonicalize(&parent).unwrap().join(&target));
        #[cfg(target_os = "macos")]
        assert_eq!(unmount_target(Path::new("/tmp/nonexistent-owned-fixture-target")).unwrap(), Path::new("/private/tmp/nonexistent-owned-fixture-target"));
        let dead = MountIdentity { target: parent.clone(), source: b"127.0.0.1:/".to_vec(), filesystem: b"nfs".to_vec(), id: vec![1] };
        assert!(validate_local_resolution(&alias, &[dead], 0).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[ignore = "historical RED: run explicitly, must fail only after barrier release/actual wait"]
    fn legacy_output_exceeds_observation_budget() {
        let mut command = barrier_command();
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let started = Instant::now();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            stdin.write_all(b"release\n").unwrap();
        });
        let output = child.wait_with_output().unwrap();
        let elapsed = started.elapsed();
        release.join().unwrap();
        assert!(output.status.success());
        assert!(elapsed < Duration::from_millis(50), "legacy output exceeded observation deadline: {elapsed:?}");
    }

    #[test]
    fn command_timeout_retains_child_until_actual_wait() {
        // Sleep is a bounded self-closing fixture. Deadline never signals it.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 0.25; exit 0"]);
        let started = Instant::now();
        let mut observed = observe_command(&mut command, "fixture", Duration::from_millis(30)).unwrap();
        assert!(observed.status.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(observed.require_success().unwrap_err().to_string().contains("actual_wait=null"));
        assert!(observed.child.wait().unwrap().success());
        observed.refresh();
        assert!(observed.status.unwrap().success());
    }

    #[test]
    fn actual_nonzero_is_preserved_without_fallback() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "exit 42"]);
        let observed = observe_command(&mut command, "umount", Duration::from_secs(2)).unwrap();
        assert_eq!(observed.status.unwrap().code(), Some(42));
        assert!(observed.require_success().unwrap_err().to_string().contains("actual_exit=Some(42)"));
    }

    #[test]
    fn noisy_child_and_inherited_descriptors_do_not_hold_output() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "i=0; while [ $i -lt 20000 ]; do printf '0123456789012345678901234567890123456789'; printf 'error0123456789012345678901234567890123456789' >&2; i=$((i+1)); done; sleep 0.3 & exit 0"]);
        let observed = observe_command(&mut command, "noisy", Duration::from_secs(5)).unwrap();
        observed.require_success().unwrap();
    }

    #[test]
    fn spawn_failure_is_not_success_or_wait() {
        let error = observe_command(&mut Command::new("/definitely-missing-agentfs-fixture"), "fixture", Duration::from_secs(1)).err().unwrap();
        assert!(error.to_string().contains("fixture spawn failed"));
    }

    #[test]
    fn mountinfo_decodes_paths_and_rejects_unknown_snapshots() {
        let row = b"12 1 0:42 / /private/a\\040b rw - nfs 127.0.0.1:/ rw\n";
        let entries = parse_mountinfo(row).unwrap();
        assert_eq!(entries[0].target, Path::new("/private/a b"));
        assert!(entries[0].is_expected_nfs());
        assert!(matches!(state_from_snapshot(Path::new("/private/a b"), Ok(entries.clone())), MountState::Mounted(_)));
        assert!(matches!(state_from_snapshot(Path::new("/missing"), Ok(entries)), MountState::Absent));
        for malformed in [b"".as_slice(), b"12 broken\n", b"12 1 0:42 / /mnt rw - nfs 127.0.0.1:/ rw", b"12 1 0:42 / /bad\\000 rw - nfs 127.0.0.1:/ rw\n"] {
            assert!(matches!(state_from_snapshot(Path::new("/mnt"), parse_mountinfo(malformed)), MountState::Unknown(_)));
        }
    }

    #[test]
    fn table_only_probe_handles_nonexistent_target_and_foreign_mount() {
        let path = Path::new("/this-path-must-not-be-statted-agentfs");
        let mut entries = parse_mountinfo(b"12 1 0:42 / /this-path-must-not-be-statted-agentfs rw - nfs 192.0.2.1:/ rw\n").unwrap();
        assert!(!entries[0].is_expected_nfs());
        assert!(ensure_fresh_local(path, entries.clone()).is_err());
        entries[0].target = PathBuf::from("/already-nfs");
        assert!(ensure_fresh_local(Path::new("/already-nfs/child"), entries).is_err());
    }

    #[test]
    fn asynchronous_command_observation_keeps_runtime_responsive() {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let observation = tokio::task::spawn_blocking(|| {
                observe_command(Command::new("/bin/sh").args(["-c", "sleep 0.2; exit 0"]), "fixture", Duration::from_secs(2)).unwrap()
            });
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert!(!observation.is_finished(), "fixture must still be running when runtime heartbeat fires");
            observation.await.unwrap().require_success().unwrap();
        });
    }
}
