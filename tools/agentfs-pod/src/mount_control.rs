//! Private local NFS lifecycle coordination, independent of the session journal.
//! An ordinary unmount's actual completion, not a mount-table hint, retires NFS.
use crate::mount::{self, CommandObservation, MountIdentity, MountState};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixListener as StdListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

const DIRECTORY: &str = ".nfs-runtime";
const LEASE: &str = "runtime.lease";
const RECORD: &str = "owner.json";
const SOCKET: &str = "control.sock";
const MAGIC: &str = "xpod-agentfs-nfs-runtime-v1";
const LIMIT: usize = 4096;
const IO_BUDGET: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FileIdentity { device: u64, inode: u64 }
impl FileIdentity {
    fn of(metadata: &fs::Metadata) -> Self { Self { device: metadata.dev(), inode: metadata.ino() } }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Binding { source: Vec<u8>, filesystem: Vec<u8>, id: Vec<u8> }
impl Binding {
    pub fn from_mount(identity: &MountIdentity) -> Self {
        Self { source: identity.source.clone(), filesystem: identity.filesystem.clone(), id: identity.id.clone() }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Owner {
    schema_version: u32,
    marker: String,
    uid: u32,
    nonce: String,
    target: Vec<u8>,
    binding: Option<Binding>,
    closed: Option<Closed>,
    directory: FileIdentity,
    lease: FileIdentity,
    socket: FileIdentity,
    socket_directory_path: Vec<u8>,
    socket_directory: FileIdentity,
    record: FileIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Closed { pid: u32, actual_exit: i32, actual_signal: Option<i32>, binding: Binding, cleanup_complete: bool }

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Unmount { nonce: String, target: Vec<u8> },
    Status { nonce: String, target: Vec<u8> },
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum Reply {
    Pending { nonce: String, pid: u32, actual_wait: bool, actual_exit: Option<i32>, actual_signal: Option<i32>, kernel: KernelObservation },
    Failed { nonce: String, pid: u32, actual_exit: Option<i32>, actual_signal: Option<i32> },
    Rejected { class: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum KernelObservation { Absent, Mounted, Unknown }

impl KernelObservation {
    fn classify(observed: &MountState, owner: &Owner, binding: &Binding) -> Self {
        match observed {
            MountState::Absent => Self::Absent,
            MountState::Mounted(identity) if identity.target.as_os_str().as_bytes() == owner.target
                && identity.is_expected_nfs() && Binding::from_mount(identity) == *binding => Self::Mounted,
            // Foreign or changed bindings cannot attest the owned mount's state.
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug)]
struct PendingSnapshot {
    nonce: String, pid: u32, actual_wait: bool,
    actual_exit: Option<i32>, actual_signal: Option<i32>, kernel: KernelObservation,
}
impl PendingSnapshot {
    fn from_child(nonce: String, child: &CommandObservation, kernel: KernelObservation) -> Self {
        use std::os::unix::process::ExitStatusExt;
        Self { nonce, pid: child.child.id(), actual_wait: child.status.is_some(),
            actual_exit: child.status.and_then(|status| status.code()),
            actual_signal: child.status.and_then(|status| status.signal()), kernel }
    }
    fn reply(self) -> Reply {
        Reply::Pending { nonce: self.nonce, pid: self.pid, actual_wait: self.actual_wait,
            actual_exit: self.actual_exit, actual_signal: self.actual_signal, kernel: self.kernel }
    }
}

fn pending_message(last: Option<&PendingSnapshot>, reason: &str) -> String {
    match last {
        Some(snapshot) => format!("umount pid={} {reason} last_known_actual_wait={} last_known_actual_exit={:?} last_known_actual_signal={:?} last_known_kernel={:?}; runtime retained",
            snapshot.pid, snapshot.actual_wait, snapshot.actual_exit, snapshot.actual_signal, snapshot.kernel),
        None => format!("umount {reason} actual_wait=null; runtime retained"),
    }
}

#[derive(Default)]
pub struct State {
    pub binding: Option<Binding>,
    child: Option<CommandObservation>,
}

fn current_uid() -> u32 { unsafe { libc::geteuid() } }
fn private_metadata(path: &Path, socket: bool) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    let valid_type = if socket { metadata.file_type().is_socket() } else { metadata.file_type().is_file() };
    if !valid_type || metadata.uid() != current_uid() || metadata.mode() & 0o7777 != 0o600 || metadata.nlink() != 1 {
        anyhow::bail!("private runtime file ownership/type/permissions unknown");
    }
    Ok(metadata)
}
fn directory_identity(path: &Path) -> Result<FileIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() || metadata.uid() != current_uid() || metadata.mode() & 0o7777 != 0o700 {
        anyhow::bail!("private runtime directory ownership/type/permissions unknown");
    }
    Ok(FileIdentity::of(&metadata))
}
fn open_private(path: &Path) -> Result<File> {
    let file = OpenOptions::new().read(true).write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC).open(path)?;
    let path_metadata = private_metadata(path, false)?;
    if FileIdentity::of(&file.metadata()?) != FileIdentity::of(&path_metadata) {
        anyhow::bail!("private runtime file was replaced");
    }
    Ok(file)
}
fn valid_nonce(value: &str) -> bool { value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) }
fn nonce() -> Result<String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn check_names(directory: &Path, transient_nonce: Option<&str>) -> Result<()> {
    // Bounded, nonrecursive inspection of this sole program-owned directory.
    // During the atomic owner.json replacement the live owner transiently
    // exposes exactly one private regular file named owner.<nonce>.new for the
    // recorded nonce. Tolerate only that program-owned writer; any other name,
    // a non-private transient, or a fourth entry is foreign and fails closed.
    let expected = transient_nonce.map(|nonce| format!("owner.{nonce}.new"));
    let mut entries = 0usize;
    let mut transient_seen = false;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        entries += 1;
        if entries > 3 { anyhow::bail!("unknown runtime entry retained"); }
        let name = entry.file_name();
        if name == LEASE || name == RECORD { continue; }
        let is_recorded_transient = !transient_seen
            && expected.as_deref().is_some_and(|expected| name.as_bytes() == expected.as_bytes());
        if is_recorded_transient {
            // The atomic writer may rename the transient to owner.json between
            // read_dir and this observation; a vanished path is that rename.
            match private_metadata(&entry.path(), false) {
                Ok(_) => {},
                Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {},
                Err(error) => return Err(error).context("runtime transient ownership unknown"),
            }
            transient_seen = true;
            continue;
        }
        anyhow::bail!("unknown runtime entry retained");
    }
    Ok(())
}
fn recorded_owner_nonce(directory: &Path) -> Result<Option<String>> {
    // A live writer's transient is keyed to the marker nonce that is stable
    // across every store_owner replacement.
    match fs::symlink_metadata(directory.join(RECORD)) {
        Ok(_) => Ok(Some(read_owner(directory)?.nonce)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn read_owner(directory: &Path) -> Result<Owner> {
    let mut file = open_private(&directory.join(RECORD))?;
    let identity = FileIdentity::of(&file.metadata()?);
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file).take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > LIMIT { anyhow::bail!("runtime marker exceeds bound"); }
    let owner: Owner = serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("malformed runtime marker"))?;
    if owner.schema_version != 1 || owner.marker != MAGIC || owner.uid != current_uid() || !valid_nonce(&owner.nonce) || owner.record != identity || owner.directory != directory_identity(directory)? {
        anyhow::bail!("runtime marker ownership unknown");
    }
    recorded_target(&owner)?;
    Ok(owner)
}
fn ownership_unchanged(actual: &Owner, expected: &Owner) -> bool {
    // `verify_owned_after` holds the owner mutex across the clone and the disk
    // read, so no legitimate same-owner replacement can advance `record` (the
    // marker inode) or `closed` (the terminal proof) inside that window. The
    // full identity - including both - must therefore be exactly equal. Any
    // difference is a foreign same-binding replacement and fails closed; the
    // previous field-slack comparison silently accepted external record swaps.
    actual == expected
}
fn recorded_target(owner: &Owner) -> Result<PathBuf> {
    if owner.target.contains(&0) || owner.target.split(|byte| *byte == b'/').any(|part| part == b"." || part == b"..") {
        anyhow::bail!("recorded runtime target invalid; retained");
    }
    let target = PathBuf::from(std::ffi::OsString::from_vec(owner.target.clone()));
    if !target.is_absolute() || target.file_name().is_none() { anyhow::bail!("recorded runtime target must be an absolute byte path"); }
    Ok(target)
}

fn socket_path(owner: &Owner) -> Result<PathBuf> {
    let path = PathBuf::from(std::ffi::OsString::from_vec(owner.socket_directory_path.clone()));
    let name = path.file_name().context("socket directory name missing")?.as_bytes();
    if path.parent() != Some(Path::new("/tmp")) || !name.starts_with(b"xpod-nfs-") || name.len() != 15 || !name[9..].iter().all(|byte| byte.is_ascii_alphanumeric()) {
        anyhow::bail!("socket directory is outside fixed program scope");
    }
    Ok(path)
}
fn socket_directory(owner: &Owner) -> Result<PathBuf> {
    let path = socket_path(owner)?;
    if directory_identity(&path)? != owner.socket_directory { anyhow::bail!("socket directory replaced; retained"); }
    Ok(path)
}
fn new_socket_directory() -> Result<PathBuf> {
    let mut template = b"/tmp/xpod-nfs-XXXXXX\0".to_vec();
    // mkdtemp atomically creates this single private local IPC directory.
    if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() { return Err(std::io::Error::last_os_error().into()); }
    template.pop();
    let path = PathBuf::from(std::ffi::OsString::from_vec(template));
    directory_identity(&path)?;
    Ok(path)
}
fn remove_socket_resources(owner: &Owner) -> Result<()> {
    let directory = socket_directory(owner)?;
    let mut entries = fs::read_dir(&directory)?;
    match (entries.next(), entries.next()) {
        (Some(entry), None) => {
            if entry?.file_name() != SOCKET { anyhow::bail!("unknown socket directory entry retained"); }
        },
        _ => anyhow::bail!("unknown socket directory entry retained"),
    }
    remove_known(&directory.join(SOCKET), owner.socket, true)?;
    if directory_identity(&directory)? != owner.socket_directory { anyhow::bail!("socket directory changed; retained"); }
    fs::remove_dir(directory)?;
    Ok(())
}
fn remove_known(path: &Path, expected: FileIdentity, socket: bool) -> Result<()> {
    if FileIdentity::of(&private_metadata(path, socket)?) != expected { anyhow::bail!("runtime resource replaced; retained"); }
    fs::remove_file(path)?;
    Ok(())
}

pub struct RuntimeControl {
    directory: PathBuf,
    lease: File,
    listener: StdListener,
    owner: Mutex<Owner>,
}
impl RuntimeControl {
    pub fn acquire(session: &Path, target: &Path) -> Result<Self> {
        Self::acquire_observed(session, target, mount::mount_state)
    }

    fn acquire_observed(session: &Path, target: &Path, observe: impl Fn(&Path) -> MountState) -> Result<Self> {
        let session = mount::canonical_mountpoint(session).context("canonical private session unavailable")?;
        directory_identity(&session)?;
        if !target.is_absolute() { anyhow::bail!("runtime target must be absolute"); }
        let directory = session.join(DIRECTORY);
        match DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(error) => return Err(error.into()),
        }
        let directory_id = directory_identity(&directory)?;
        check_names(&directory, recorded_owner_nonce(&directory)?.as_deref())?;
        let lease_path = directory.join(LEASE);
        let mut lease = match OpenOptions::new().read(true).write(true).create_new(true).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&lease_path) {
            Ok(mut file) => { file.write_all(MAGIC.as_bytes())?; file.sync_all()?; file },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => open_private(&lease_path)?,
            Err(error) => return Err(error.into()),
        };
        if FileIdentity::of(&lease.metadata()?) != FileIdentity::of(&private_metadata(&lease_path, false)?) { anyhow::bail!("runtime lease replaced"); }
        let mut marker = Vec::new();
        lease.seek(SeekFrom::Start(0))?;
        std::io::Read::by_ref(&mut lease).take(128).read_to_end(&mut marker)?;
        if marker != MAGIC.as_bytes() { anyhow::bail!("unknown runtime lease retained"); }
        // Kernel releases this independent runtime lease on process death.
        if unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 { anyhow::bail!("NFS runtime lease is live or unavailable"); }
        let lease_id = FileIdentity::of(&lease.metadata()?);
        match fs::symlink_metadata(directory.join(RECORD)) {
            Ok(_) => {
                let old = read_owner(&directory)?;
                if old.lease != lease_id { anyhow::bail!("stale runtime lease identity mismatch"); }
                let old_target = recorded_target(&old)?;
                // A released lease proves owner death, never kernel unmount.
                // Do not stat/canonicalize this potentially dead NFS target.
                if !matches!(observe(&old_target), MountState::Absent) {
                    anyhow::bail!("prior runtime target mounted or unknown; locator retained");
                }
                if old.closed.is_some() { reconcile_socket_resources(&old)?; } else { remove_socket_resources(&old)?; }
                remove_known(&directory.join(RECORD), old.record, false)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // With no marker there is no authority to discover or sweep
                // any prior /tmp directory. Unknown crash remnants stay put.
            }
            Err(error) => return Err(error.into()),
        }
        check_names(&directory, None)?;
        let socket_directory_path = new_socket_directory()?;
        let socket_directory_id = directory_identity(&socket_directory_path)?;
        let listener = StdListener::bind(socket_directory_path.join(SOCKET)).context("private UNIX control bind failed")?;
        fs::set_permissions(socket_directory_path.join(SOCKET), fs::Permissions::from_mode(0o600))?;
        let socket = FileIdentity::of(&private_metadata(&socket_directory_path.join(SOCKET), true)?);
        let nonce = nonce()?;
        let temporary = directory.join(format!("owner.{nonce}.new"));
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&temporary)?;
        let owner = Owner { schema_version: 1, marker: MAGIC.into(), uid: current_uid(), nonce, target: target.as_os_str().as_bytes().to_vec(), binding: None, closed: None, directory: directory_id, lease: lease_id, socket, socket_directory_path: socket_directory_path.as_os_str().as_bytes().to_vec(), socket_directory: socket_directory_id, record: FileIdentity::of(&file.metadata()?) };
        let bytes = serde_json::to_vec(&owner)?;
        if bytes.len() > LIMIT { anyhow::bail!("runtime binding exceeds protocol limit"); }
        file.write_all(&bytes)?; file.sync_all()?;
        // Private directory + held lease exclude cooperating writers. Crash
        // remnants or hostile same-UID races are unknown, never garbage swept.
        if fs::symlink_metadata(directory.join(RECORD)).is_ok() { anyhow::bail!("runtime marker appeared unexpectedly"); }
        fs::rename(&temporary, directory.join(RECORD))?;
        File::open(&directory)?.sync_all()?;
        listener.set_nonblocking(true)?;
        Ok(Self { directory, lease, listener, owner: Mutex::new(owner) })
    }

    fn verify_owned(&self) -> Result<Owner> { self.verify_owned_after(|| {}) }

    /// `between` runs after the expected marker is cloned and before the disk
    /// read, so a controlled actual writer update can be linearized exactly in
    /// that window. Production passes a no-op.
    ///
    /// The owner mutex is held across the clone and the disk read: a legitimate
    /// same-owner atomic replacement (which necessarily changes the record
    /// inode while preserving the immutable binding) can only run inside
    /// `store_owner_before_rename`, which also takes this mutex. Without the
    /// lock a successful update would be misread as a foreign ownership change.
    fn verify_owned_after(&self, between: impl FnOnce()) -> Result<Owner> {
        let stored = self.owner.lock().map_err(|_| anyhow::anyhow!("runtime owner poisoned"))?;
        let expected = stored.clone();
        between();
        check_names(&self.directory, Some(&expected.nonce))?;
        let owner = read_owner(&self.directory)?;
        if !ownership_unchanged(&owner, &expected) || owner.lease != FileIdentity::of(&self.lease.metadata()?) {
            anyhow::bail!("runtime ownership changed");
        }
        if FileIdentity::of(&private_metadata(&socket_directory(&owner)?.join(SOCKET), true)?) != owner.socket { anyhow::bail!("runtime socket replaced; retained"); }
        Ok(owner)
    }

    fn store_owner(&self, updated: Owner) -> Result<()> { self.store_owner_before_rename(updated, || {}) }

    /// `between_write_and_rename` runs after the replacement marker is fully
    /// written and fsynced and before the atomic rename, so a controlled live
    /// reader can observe the sole program-owned transient. Production no-op.
    fn store_owner_before_rename(&self, mut updated: Owner, between_write_and_rename: impl FnOnce()) -> Result<()> {
        let mut stored = self.owner.lock().map_err(|_| anyhow::anyhow!("runtime owner poisoned"))?;
        let temporary = self.directory.join(format!("owner.{}.new", stored.nonce));
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&temporary)?;
        updated.record = FileIdentity::of(&file.metadata()?);
        let bytes = serde_json::to_vec(&updated)?;
        if bytes.len() > LIMIT { anyhow::bail!("runtime binding exceeds protocol limit"); }
        file.write_all(&bytes)?; file.sync_all()?;
        between_write_and_rename();
        if read_owner(&self.directory)? != *stored { anyhow::bail!("runtime marker changed; retained"); }
        fs::rename(&temporary, self.directory.join(RECORD))?;
        *stored = updated;
        File::open(&self.directory)?.sync_all()?;
        Ok(())
    }

    pub fn bind_identity(&self, identity: &MountIdentity) -> Result<()> {
        let verified = self.verify_owned()?;
        if identity.target.as_os_str().as_bytes() != verified.target || !identity.is_expected_nfs() { anyhow::bail!("mount identity binding mismatch"); }
        let binding = Binding::from_mount(identity);
        if let Some(previous) = &verified.binding {
            if previous != &binding { anyhow::bail!("runtime mount identity changed"); }
            return Ok(());
        }
        let mut updated = verified; updated.binding = Some(binding);
        self.store_owner(updated)
    }

    pub async fn serve(self: Arc<Self>, state: Arc<Mutex<State>>, target: PathBuf) -> Result<()> {
        let observed_target = target.clone();
        self.serve_with_observer(state, Arc::new(move || mount::mount_state(&observed_target)),
            Arc::new(move || mount::spawn_unmount(&target)), IO_BUDGET).await
    }

    async fn serve_with_observer(self: Arc<Self>, state: Arc<Mutex<State>>,
        observe: Arc<dyn Fn() -> MountState + Send + Sync>,
        spawn: Arc<dyn Fn() -> Result<CommandObservation> + Send + Sync>, budget: Duration) -> Result<()> {
        self.serve_with_hooks(state, observe, spawn, Arc::new(remove_socket_resources), budget).await
    }

    async fn serve_with_hooks(self: Arc<Self>, state: Arc<Mutex<State>>,
        observe: Arc<dyn Fn() -> MountState + Send + Sync>,
        spawn: Arc<dyn Fn() -> Result<CommandObservation> + Send + Sync>,
        cleanup: Arc<dyn Fn(&Owner) -> Result<()> + Send + Sync>, budget: Duration) -> Result<()> {
        use std::os::unix::process::ExitStatusExt;
        let listener = UnixListener::from_std(self.listener.try_clone()?)?;
        loop {
            // Observation lives outside every request future, including lost ACKs.
            let completed = {
                let mut state = state.lock().map_err(|_| anyhow::anyhow!("runtime state poisoned"))?;
                if let Some(child) = state.child.as_mut() {
                    child.refresh();
                    if child.status.map(|status| status.success()).unwrap_or(false) && matches!(observe(), MountState::Absent) {
                        Some(Closed { pid: child.child.id(), actual_exit: 0, actual_signal: None, cleanup_complete: false,
                            binding: state.binding.clone().context("mount binding unresolved")? })
                    } else { None }
                } else { None }
            };
            if let Some(closed) = completed {
                let mut owner = self.verify_owned()?;
                owner.closed = Some(closed);
                // This strictly bound terminal proof survives transport loss.
                self.store_owner(owner)?;
                let owner = self.verify_owned()?;
                // Failure can be partial; stop the proven-complete server rather
                // than keep an unreachable listener. A new lease holder reconciles.
                if cleanup(&owner).is_err() {
                    eprintln!("agentfs-pod: ordinary unmount closed; IPC cleanup unresolved");
                } else {
                    let mut updated = owner;
                    updated.closed.as_mut().expect("closed proof established").cleanup_complete = true;
                    if self.store_owner(updated).is_err() {
                        eprintln!("agentfs-pod: ordinary unmount closed; cleanup receipt unresolved");
                    }
                }
                return Ok(());
            }
            let accepted = tokio::select! {
                accepted = listener.accept() => Some(accepted),
                _ = tokio::time::sleep(Duration::from_millis(20)) => None,
            };
            let Some(accepted) = accepted else { continue; };
            let (mut stream, _) = match accepted { Ok(connection) => connection, Err(_) => continue };
            let outcome: Result<Reply> = async {
                peer_uid(&stream)?;
                let owner = self.verify_owned()?;
                let request: Request = read_frame(&mut stream, budget).await?;
                let (nonce, target, start) = match request {
                    Request::Unmount { nonce, target } => (nonce, target, true),
                    Request::Status { nonce, target } => (nonce, target, false),
                };
                if nonce != owner.nonce || target != owner.target { anyhow::bail!("control binding mismatch"); }
                let mut state = state.lock().map_err(|_| anyhow::anyhow!("runtime state poisoned"))?;
                let binding = state.binding.clone().context("mount startup remains unresolved")?;
                if owner.binding.as_ref() != Some(&binding) { anyhow::bail!("runtime marker binding unresolved"); }
                let observed = observe();
                let kernel = KernelObservation::classify(&observed, &owner, &binding);
                let same_mount = kernel == KernelObservation::Mounted;
                if let Some(child) = state.child.as_mut() { child.refresh(); }
                let retry = state.child.as_ref().and_then(|child| child.status).map(|status| !status.success()).unwrap_or(false);
                if start && (state.child.is_none() || retry) {
                    if !same_mount { anyhow::bail!("mount identity unknown or changed"); }
                    state.child = Some(spawn()?);
                }
                let child = state.child.as_ref().context("no owned unmount operation")?;
                match child.status {
                    Some(status) if !status.success() => Ok(Reply::Failed { nonce: owner.nonce, pid: child.child.id(), actual_exit: status.code(), actual_signal: status.signal() }),
                    _ => Ok(PendingSnapshot::from_child(owner.nonce, child, kernel).reply()),
                }
            }.await;
            let reply = outcome.unwrap_or(Reply::Rejected { class: "control_unresolved".into() });
            // A peer disconnect never changes ownership, operation or lifetime.
            let _ = write_frame(&mut stream, &reply, budget).await;
        }
    }
}

#[cfg(target_os = "macos")]
fn peer_uid(stream: &UnixStream) -> Result<()> {
    let mut uid = 0; let mut gid = 0;
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != current_uid() { anyhow::bail!("control peer UID mismatch"); }
    Ok(())
}
#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> Result<()> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut credentials as *mut libc::ucred).cast(), &mut size) } != 0 || size as usize != std::mem::size_of::<libc::ucred>() || credentials.uid != current_uid() { anyhow::bail!("control peer UID mismatch"); }
    Ok(())
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn peer_uid(_stream: &UnixStream) -> Result<()> { anyhow::bail!("control peer validation unsupported"); }

async fn read_frame<T: serde::de::DeserializeOwned>(stream: &mut UnixStream, budget: Duration) -> Result<T> {
    tokio::time::timeout(budget, async {
        let mut length = [0u8; 4]; stream.read_exact(&mut length).await?;
        let size = u32::from_be_bytes(length) as usize;
        if size == 0 || size > LIMIT { anyhow::bail!("control frame exceeds bound"); }
        let mut bytes = vec![0; size]; stream.read_exact(&mut bytes).await?;
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("malformed control frame"))
    }).await.context("control read observation timed out")?
}
async fn write_frame<T: Serialize>(stream: &mut UnixStream, value: &T, budget: Duration) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.is_empty() || bytes.len() > LIMIT { anyhow::bail!("control frame exceeds bound"); }
    tokio::time::timeout(budget, async {
        stream.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
        stream.write_all(&bytes).await?; stream.flush().await?;
        Ok(())
    }).await.context("control write observation timed out")?
}

fn live_owner(session: &Path, target: &Path) -> Result<(PathBuf, Owner)> {
    let session = mount::canonical_mountpoint(session)?; directory_identity(&session)?;
    let directory = session.join(DIRECTORY); directory_identity(&directory)?;
    // Read the atomically replaced marker first so the single live writer's
    // owner.<nonce>.new transient is recognised by its recorded nonce.
    let owner = read_owner(&directory)?;
    check_names(&directory, Some(&owner.nonce))?;
    if owner.target != target.as_os_str().as_bytes() { anyhow::bail!("unmount target does not match runtime"); }
    let lease = open_private(&directory.join(LEASE))?;
    if FileIdentity::of(&lease.metadata()?) != owner.lease { anyhow::bail!("runtime lease replaced"); }
    if unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { anyhow::bail!("runtime lease has no live owner"); }
    let errno = std::io::Error::last_os_error().raw_os_error();
    if errno != Some(libc::EWOULDBLOCK) && errno != Some(libc::EAGAIN) { anyhow::bail!("runtime lease state unknown"); }
    if FileIdentity::of(&private_metadata(&socket_directory(&owner)?.join(SOCKET), true)?) != owner.socket { anyhow::bail!("runtime socket replaced"); }
    Ok((directory, owner))
}

pub fn ready(session: &Path, target: &Path, identity: &MountIdentity) -> Result<bool> {
    let (_, owner) = live_owner(session, target)?;
    Ok(owner.binding.as_ref() == Some(&Binding::from_mount(identity)))
}

#[derive(Debug)]
pub struct PendingUnmount(pub String);
impl std::fmt::Display for PendingUnmount {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str(&self.0) }
}
impl std::error::Error for PendingUnmount {}

fn completed_owner_observed(session: &Path, target: &Path, observe: impl Fn() -> MountState, recover: bool) -> Result<bool> {
    completed_owner_for_operation(session, target, observe, recover, None, None, || {})
}

fn completed_owner_for_operation(session: &Path, target: &Path, observe: impl Fn() -> MountState, recover: bool,
    expected: Option<&Owner>, last: Option<&PendingSnapshot>, before_lock: impl FnOnce()) -> Result<bool> {
    let session = mount::canonical_mountpoint(session)?;
    directory_identity(&session)?;
    let directory = session.join(DIRECTORY);
    directory_identity(&directory)?;
    // Do not inspect the atomically replaced marker or transient writer names
    // until the actual kernel lease excludes that writer.
    let lease = open_private(&directory.join(LEASE))?;
    before_lock();
    if unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let errno = std::io::Error::last_os_error().raw_os_error();
        if errno == Some(libc::EWOULDBLOCK) || errno == Some(libc::EAGAIN) { return Ok(false); }
        anyhow::bail!("closed lease state unknown");
    }
    check_names(&directory, None)?;
    let owner = read_owner(&directory)?;
    if owner.target != target.as_os_str().as_bytes() { anyhow::bail!("closed target binding mismatch"); }
    if owner.lease != FileIdentity::of(&lease.metadata()?) { anyhow::bail!("closed lease replaced"); }
    if let Some(expected) = expected {
        let mut unchanged = owner.clone();
        unchanged.record = expected.record;
        unchanged.closed = expected.closed.clone();
        if unchanged != *expected { anyhow::bail!("closed runtime binding changed; retained"); }
    }
    let closed = owner.closed.as_ref().context("no actual closed unmount proof")?;
    if last.map(|snapshot| snapshot.nonce != owner.nonce || snapshot.pid != closed.pid
        || (snapshot.actual_wait && (snapshot.actual_exit != Some(closed.actual_exit) || snapshot.actual_signal != closed.actual_signal))).unwrap_or(false) {
        anyhow::bail!("closed operation binding changed; retained");
    }
    if closed.pid == 0 || closed.binding.source != b"127.0.0.1:/" || closed.binding.filesystem != b"nfs" || closed.actual_exit != 0 || closed.actual_signal.is_some() || owner.binding.as_ref() != Some(&closed.binding)
        || !matches!(observe(), MountState::Absent) { anyhow::bail!("closed unmount proof unresolved"); }
    if !closed.cleanup_complete && !recover { anyhow::bail!("umount actual_exit=0 actual_signal=null; IPC cleanup secondary failure; proxy retained"); }
    reconcile_socket_resources(&owner)?;
    Ok(true)
}

fn reconcile_socket_resources(owner: &Owner) -> Result<()> {
    let directory = socket_path(owner)?;
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(_) => {
            let directory = socket_directory(owner)?;
            let socket = directory.join(SOCKET);
            match fs::symlink_metadata(&socket) {
                Ok(_) => remove_socket_resources(owner),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if fs::read_dir(&directory)?.next().is_some() { anyhow::bail!("unknown closed IPC resource retained"); }
                    fs::remove_dir(directory)?; Ok(())
                }
                Err(error) => Err(error.into()),
            }
        }
    }
}

pub async fn unmount(session: &Path, target: &Path) -> Result<()> {
    unmount_observed(session, target, mount::UNMOUNT_OBSERVATION).await
}

async fn unmount_observed(session: &Path, target: &Path, budget: Duration) -> Result<()> {
    unmount_with_observer(session, target, budget, || mount::mount_state(target)).await
}

async fn unmount_with_observer(session: &Path, target: &Path, budget: Duration, observe: impl Fn() -> MountState) -> Result<()> {
    unmount_with_transport_hook(session, target, budget, observe, || {}).await
}

async fn unmount_with_transport_hook(session: &Path, target: &Path, budget: Duration, observe: impl Fn() -> MountState, mut lost_transport: impl FnMut()) -> Result<()> {
    let started = std::time::Instant::now();
    let mut first = true;
    let mut last: Option<PendingSnapshot> = None;
    let mut expected_owner: Option<Owner> = None;
    let mut transport_lost = false;
    loop {
        if completed_owner_for_operation(session, target, &observe, first, expected_owner.as_ref(), last.as_ref(), || {}).map_err(|error| match last.as_ref() {
            Some(snapshot) => error.context(pending_message(Some(snapshot), "secondary closed-proof observation unresolved")),
            None => error,
        })? { return Ok(()); }
        if started.elapsed() >= budget {
            return Err(PendingUnmount(pending_message(last.as_ref(), "pending")).into());
        }
        if transport_lost {
            tokio::time::sleep(Duration::from_millis(20).min(budget.saturating_sub(started.elapsed()))).await;
            continue; // Observe retirement only; never issue another Unmount.
        }
        let attempt: Result<Reply> = tokio::time::timeout(budget.saturating_sub(started.elapsed()), async {
            let (_, owner) = live_owner(session, target)?;
            if let Some(expected) = &expected_owner {
                let mut unchanged = owner.clone(); unchanged.record = expected.record; unchanged.closed = expected.closed.clone();
                if unchanged != *expected { anyhow::bail!("control runtime binding changed"); }
            } else { expected_owner = Some(owner.clone()); }
            let remaining = budget.saturating_sub(started.elapsed()).min(IO_BUDGET);
            let mut stream = tokio::time::timeout(remaining, UnixStream::connect(socket_directory(&owner)?.join(SOCKET))).await.context("control connect observation timed out")??;
            peer_uid(&stream)?;
            let request = if first { Request::Unmount { nonce: owner.nonce.clone(), target: owner.target.clone() } }
                else { Request::Status { nonce: owner.nonce.clone(), target: owner.target.clone() } };
            // Once a request may have reached the server, never automatically retry it.
            first = false;
            write_frame(&mut stream, &request, remaining).await?;
            let reply = read_frame(&mut stream, remaining.min(budget.saturating_sub(started.elapsed()))).await?;
            match &reply {
                Reply::Pending { nonce, .. } | Reply::Failed { nonce, .. } if nonce == &owner.nonce => {},
                _ => anyhow::bail!("control response binding unresolved"),
            }
            Ok::<Reply, anyhow::Error>(reply)
        }).await.unwrap_or_else(|_| Err(anyhow::anyhow!("total unmount observation deadline reached")));
        match attempt {
            Ok(Reply::Pending { nonce, pid, actual_wait, actual_exit, actual_signal, kernel }) => {
                // A subsequent response must describe the same owned operation.
                if pid == 0 || last.as_ref().map(|previous| previous.nonce != nonce || previous.pid != pid
                    || (previous.actual_wait && (!actual_wait || previous.actual_exit != actual_exit || previous.actual_signal != actual_signal))).unwrap_or(false)
                    || (!actual_wait && (actual_exit.is_some() || actual_signal.is_some())) {
                    return Err(PendingUnmount(pending_message(last.as_ref(), "control observation unresolved")).into());
                }
                last = Some(PendingSnapshot { nonce, pid, actual_wait, actual_exit, actual_signal, kernel });
            },
            Ok(Reply::Failed { pid, actual_exit, actual_signal, .. }) => anyhow::bail!("umount pid={pid} actual_exit={actual_exit:?} actual_signal={actual_signal:?}; runtime retained"),
            Ok(Reply::Rejected { .. }) => anyhow::bail!("unmount control unresolved; runtime retained"),
            Err(_) => {
                // Socket retirement can precede lease release. Continue only
                // closed-proof observation inside the original total budget.
                transport_lost = true;
                lost_transport();
            }
        }
        tokio::time::sleep(Duration::from_millis(20).min(budget.saturating_sub(started.elapsed()))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, Stdio};
    use std::sync::Barrier;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    struct Fixture { session: PathBuf, target: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
                .join(".test-data/agent-directory-workers/gpt-6.1-sol-native-mount-lifecycle-design/rust-fixtures");
            fs::create_dir_all(&root).unwrap();
            let session = root.join(format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            DirBuilder::new().mode(0o700).create(&session).unwrap();
            Self { target: session.join("target"), session }
        }
        fn identity(&self) -> MountIdentity {
            MountIdentity { target: self.target.clone(), source: b"127.0.0.1:/".to_vec(), filesystem: b"nfs".to_vec(), id: vec![1, 2, 3, 4] }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Preserve the sole owner locator if a regression fails; do not
            // orphan diagnostic /tmp ownership by deleting its session marker.
            if !std::thread::panicking() { let _ = fs::remove_dir_all(&self.session); }
        }
    }
    fn clean_fixture_runtime(control: &RuntimeControl) {
        let owner = control.verify_owned().unwrap();
        let temporary = socket_directory(&owner).unwrap();
        remove_socket_resources(&owner).unwrap();
        remove_known(&control.directory.join(RECORD), owner.record, false).unwrap();
        assert!(!temporary.exists(), "owned IPC temporary directory must be gone");
    }
    fn actual_exit(code: u8) -> CommandObservation {
        mount::observe_command(Command::new("/bin/sh").args(["-c", &format!("exit {code}")]), "control-test", Duration::from_secs(5)).unwrap()
    }

    // Direct atomic marker write used only to model a genuine foreign writer in
    // tests; it deliberately bypasses the owner mutex.
    fn write_owner_atomic(directory: &Path, owner: &Owner) {
        let temporary = directory.join(format!("owner.{}.foreign", owner.nonce));
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&temporary).unwrap();
        let mut owner = owner.clone();
        owner.record = FileIdentity::of(&file.metadata().unwrap());
        file.write_all(&serde_json::to_vec(&owner).unwrap()).unwrap();
        file.sync_all().unwrap();
        fs::rename(&temporary, directory.join(RECORD)).unwrap();
    }

    #[test]
    fn long_session_and_non_utf8_target_keep_short_private_socket() {
        let fixture = Fixture::new();
        let long_session = fixture.session.join("long-session-component-".repeat(5));
        DirBuilder::new().mode(0o700).create(&long_session).unwrap();
        let target = fixture.session.join(std::ffi::OsString::from_vec(vec![b't', 0xff]));
        let control = RuntimeControl::acquire(&long_session, &target).unwrap();
        let owner = control.verify_owned().unwrap();
        assert_eq!(owner.target, target.as_os_str().as_bytes());
        let temporary = socket_directory(&owner).unwrap();
        assert!(temporary.join(SOCKET).as_os_str().as_bytes().len() < 100);
        assert_eq!(fs::symlink_metadata(temporary.join(SOCKET)).unwrap().mode() & 0o7777, 0o600);
        clean_fixture_runtime(&control);
    }

    #[test]
    fn live_lease_and_unknown_runtime_entries_are_retained() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        assert!(RuntimeControl::acquire(&fixture.session, &fixture.target).is_err());
        let foreign = control.directory.join("foreign");
        fs::write(&foreign, b"foreign fixture sentinel").unwrap();
        assert!(control.verify_owned().is_err());
        assert_eq!(fs::read(&foreign).unwrap(), b"foreign fixture sentinel");
        fs::remove_file(foreign).unwrap();
        clean_fixture_runtime(&control);
    }

    #[test]
    fn owned_atomic_record_replacement_transient_is_not_a_foreign_entry() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        let identity = fixture.identity();
        control.bind_identity(&identity).unwrap();
        let owner = control.verify_owned().unwrap();
        // store_owner/acquire expose exactly one program-owned transient
        // owner.<nonce>.new during the atomic owner.json replacement. Actual
        // readers (mount readiness and unmount) must tolerate that writer only.
        let owned = control.directory.join(format!("owner.{}.new", owner.nonce));
        let held = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&owned).unwrap();
        assert!(ready(&fixture.session, &fixture.target, &identity).unwrap(), "recorded atomic replacement broke readiness");
        assert!(live_owner(&fixture.session, &fixture.target).is_ok(), "recorded atomic replacement broke live owner lookup");
        drop(held);
        fs::remove_file(&owned).unwrap();
        // A transient naming any non-recorded nonce is foreign and fails closed.
        let foreign = control.directory.join(format!("owner.{}.new", nonce().unwrap()));
        let foreign_held = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&foreign).unwrap();
        assert!(ready(&fixture.session, &fixture.target, &identity).is_err(), "unrecorded transient must fail closed");
        assert!(live_owner(&fixture.session, &fixture.target).is_err(), "unrecorded transient must fail closed");
        drop(foreign_held);
        fs::remove_file(&foreign).unwrap();
        // The recorded name must still be a private regular file.
        fs::create_dir(&owned).unwrap();
        assert!(ready(&fixture.session, &fixture.target, &identity).is_err(), "non-file recorded transient must fail closed");
        fs::remove_dir(&owned).unwrap();
        clean_fixture_runtime(&control);
    }

    #[test]
    fn actual_store_owner_temp_before_rename_is_tolerated_by_live_readers() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        let identity = fixture.identity();
        control.bind_identity(&identity).unwrap();
        let owner = control.verify_owned().unwrap();
        // A real atomic replacement in progress: at the fsynced-but-not-renamed
        // barrier the sole program-owned transient exists, and the actual live
        // readers (readiness and owner lookup) must tolerate exactly that one.
        control.store_owner_before_rename(owner, || {
            assert!(ready(&fixture.session, &fixture.target, &identity).unwrap());
            assert!(live_owner(&fixture.session, &fixture.target).is_ok());
        }).unwrap();
        clean_fixture_runtime(&control);
    }

    #[test]
    fn controlled_foreign_binding_update_between_clone_and_disk_read_fails_closed() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        let identity = fixture.identity();
        control.bind_identity(&identity).unwrap();
        let mut next = identity.clone(); next.id.push(7);
        // A genuine foreign writer changes the immutable binding on disk after
        // the expected snapshot is cloned and before it is read. The read must
        // observe the changed binding and fail closed rather than trust the
        // stale expected value. This deliberately bypasses the owner mutex the
        // way an out-of-process same-UID writer would.
        let result = control.verify_owned_after(|| {
            let mut owner = read_owner(&control.directory).unwrap();
            owner.binding = Some(Binding::from_mount(&next));
            write_owner_atomic(&control.directory, &owner);
        });
        assert!(result.unwrap_err().to_string().contains("runtime ownership changed"));
        assert_eq!(read_owner(&control.directory).unwrap().binding, Some(Binding::from_mount(&next)));
        clean_fixture_runtime(&control);
    }

    #[test]
    fn foreign_record_inode_substitution_between_clone_and_disk_read_fails_closed() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        let identity = fixture.identity();
        control.bind_identity(&identity).unwrap();
        // A same-binding external replacement advances only the marker inode
        // (`record`). With the owner mutex spanning clone/read that is foreign,
        // and strict full-identity comparison must reject it - the field-slack
        // comparison accepted it.
        let result = control.verify_owned_after(|| {
            let owner = read_owner(&control.directory).unwrap();
            write_owner_atomic(&control.directory, &owner);
        });
        assert!(result.unwrap_err().to_string().contains("runtime ownership changed"));
        clean_fixture_runtime(&control);
    }

    #[test]
    fn foreign_closed_proof_injection_between_clone_and_disk_read_fails_closed() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        let identity = fixture.identity();
        control.bind_identity(&identity).unwrap();
        // A same-binding external replacement injects a terminal `closed`
        // proof. Strict full-identity comparison must reject it rather than
        // accept the foreign record.
        let result = control.verify_owned_after(|| {
            let mut owner = read_owner(&control.directory).unwrap();
            owner.closed = Some(Closed { pid: 4242, actual_exit: 0, actual_signal: None,
                binding: owner.binding.clone().unwrap(), cleanup_complete: true });
            write_owner_atomic(&control.directory, &owner);
        });
        assert!(result.unwrap_err().to_string().contains("runtime ownership changed"));
        clean_fixture_runtime(&control);
    }

    #[test]
    fn legitimate_same_owner_atomic_update_does_not_false_fail_ownership() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        let identity = fixture.identity();
        control.bind_identity(&identity).unwrap();
        let before = control.verify_owned().unwrap();
        // Real same-owner update outside the read: every immutable field is
        // preserved and the record inode advances. Ownership checks must still
        // pass afterwards; this is the positive the old clone-then-read code
        // could not express.
        control.store_owner(before.clone()).unwrap();
        let after = control.verify_owned().unwrap();
        assert_eq!(after.binding, before.binding);
        assert_eq!(after.nonce, before.nonce);
        assert_ne!(after.record, before.record, "atomic replacement must change the record inode");
        clean_fixture_runtime(&control);
    }

    #[test]
    fn concurrent_authorized_writer_is_serialized_by_owner_mutex_against_reader() {
        // A genuine authorized same-owner writer must be *excluded* while a
        // reader holds the owner mutex across clone/read, and the reader must
        // observe the unchanged disk record - all without the reader ever
        // waiting on writer completion while the guard is held (the previous
        // fixture waited on a writer that could only finish after that same
        // guard, a deterministic deadlock).
        use std::sync::mpsc;
        let fixture = Fixture::new();
        let control = Arc::new(RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap());
        let identity = fixture.identity();
        control.bind_identity(&identity).unwrap();
        let before = control.verify_owned().unwrap();
        let record_path = control.directory.join(RECORD);
        // Keep the pre-writer inode referenced so the final inode-advance
        // assertion can never be satisfied by inode-number reuse.
        let original_record = open_private(&record_path).unwrap();
        let entered = Arc::new(Barrier::new(2));
        let (attempt_tx, attempt_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let writer_control = control.clone();
        let writer_before = before.clone();
        let writer = std::thread::spawn(move || {
            entered.wait();
            // The reader already holds the owner mutex. A real authorized writer
            // takes that same mutex inside store_owner_before_rename, so it must
            // observe WouldBlock here; only after the reader releases the guard
            // may it proceed. The WouldBlock proof is sent *before* the blocking
            // store_owner, so the reader can safely consume it without waiting
            // on writer completion.
            match writer_control.owner.try_lock() {
                Err(std::sync::TryLockError::WouldBlock) => {},
                Ok(_) => panic!("reader owner guard must exclude the authorized writer"),
                Err(std::sync::TryLockError::Poisoned(_)) => panic!("owner mutex poisoned"),
            }
            attempt_tx.send(()).unwrap();
            writer_control.store_owner(writer_before).unwrap();
            done_tx.send(()).unwrap();
        });
        let result = control.verify_owned_after(|| {
            entered.wait();
            // Bounded wait for the WouldBlock attempt only; never the writer's
            // completion or join while the guard is held.
            attempt_rx.recv_timeout(Duration::from_secs(5))
                .expect("writer must prove the owner guard blocks it");
        });
        assert!(result.is_ok(), "the guarded read must succeed while the writer is excluded");
        // Guard released. Only now may the writer finish.
        done_rx.recv_timeout(Duration::from_secs(5)).expect("writer must complete after the guard release");
        writer.join().unwrap();
        let actual = control.verify_owned().unwrap();
        assert_eq!(actual.binding, before.binding);
        assert_eq!(actual.nonce, before.nonce);
        assert_ne!(actual.record, before.record, "the authorized writer then advances the record inode");
        drop(original_record);
        clean_fixture_runtime(&control);
    }

    #[test]
    fn concurrent_authorized_writer_first_is_observed_by_later_reader() {
        // Inverse ordering: an authorized writer takes the owner mutex and
        // completes first; the next reader must observe the actual disk record,
        // never a stale expected clone.
        let fixture = Fixture::new();
        let control = Arc::new(RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap());
        let identity = fixture.identity();
        control.bind_identity(&identity).unwrap();
        let before = control.verify_owned().unwrap();
        let record_path = control.directory.join(RECORD);
        let original_record = open_private(&record_path).unwrap();
        let writer_control = control.clone();
        let writer_before = before.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let writer = std::thread::spawn(move || {
            writer_control.store_owner(writer_before).unwrap();
            done_tx.send(()).unwrap();
        });
        done_rx.recv_timeout(Duration::from_secs(5)).expect("writer must complete");
        writer.join().unwrap();
        let after = control.verify_owned().unwrap();
        assert_eq!(after.binding, before.binding);
        assert_eq!(after.nonce, before.nonce);
        assert_ne!(after.record, before.record, "writer-first must advance the record inode before the later read");
        drop(original_record);
        clean_fixture_runtime(&control);
    }

    #[test]
    fn replaced_socket_inode_is_not_deleted() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        let owner = control.verify_owned().unwrap();
        let temporary = socket_directory(&owner).unwrap();
        fs::remove_file(temporary.join(SOCKET)).unwrap();
        let replacement = StdListener::bind(temporary.join(SOCKET)).unwrap();
        fs::set_permissions(temporary.join(SOCKET), fs::Permissions::from_mode(0o600)).unwrap();
        let replaced = FileIdentity::of(&private_metadata(&temporary.join(SOCKET), true).unwrap());
        assert!(remove_socket_resources(&owner).is_err());
        assert_eq!(FileIdentity::of(&private_metadata(&temporary.join(SOCKET), true).unwrap()), replaced);
        // Test owns this deliberately foreign replacement; product retained it.
        drop(replacement); fs::remove_file(temporary.join(SOCKET)).unwrap();
        fs::remove_dir(&temporary).unwrap();
        remove_known(&control.directory.join(RECORD), owner.record, false).unwrap();
        assert!(!temporary.exists());
    }

    #[test]
    #[ignore = "owned subprocess fixture, invoked only by stale-lease test"]
    fn lease_child() {
        let session = PathBuf::from(std::env::var_os("XPOD_TEST_NFS_CONTROL_SESSION").unwrap());
        if std::env::var_os("XPOD_TEST_NFS_LEASE_INHERIT").is_some() {
            // Isolated subprocess-owned fork: the sole helper process holds the
            // exact original lease open file description, never a direct fork
            // inside the multithreaded main test process.
            lease_inherit_fixture(&session);
            return;
        }
        let _control = RuntimeControl::acquire(&session, &session.join("target")).unwrap();
        let mut ready = OpenOptions::new().write(true).create_new(true).mode(0o600).open(session.join("ready")).unwrap();
        ready.write_all(b"ready").unwrap(); ready.sync_all().unwrap();
        // Controlled release barrier: the parent may write one byte on this
        // child's stdin to request a clean exit, so the observed lease release
        // is caused by the holder itself rather than by a signal. The
        // kill-based fixtures configure stdin to null, so the read returns EOF
        // and the child parks until they actually kill it.
        let mut byte = [0u8; 1];
        match std::io::stdin().read_exact(&mut byte) {
            Ok(()) => {},
            Err(_) => loop { std::thread::park(); },
        }
    }

    /// Truthful outcome of one bounded, checked `WNOHANG` reap of an exact
    /// child. `Reaped` carries the raw status; `ChildGone` is a kernel-confirmed
    /// `ECHILD` (already reaped / not our child); `Unresolved` means the child
    /// was still running at the deadline; `Error` is any other errno. Only
    /// `Reaped` yields a status and only `Reaped`/`ChildGone` prove that no
    /// unreaped owned child remains.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ReapOutcome {
        Reaped(libc::c_int),
        ChildGone,
        Unresolved,
        Error(libc::c_int),
    }

    /// The one checked, finite exact-child reap. Retries only `EINTR`; any other
    /// negative `waitpid` result is reported truthfully instead of being treated
    /// as success or as an absent process. It never issues a blocking
    /// `waitpid(pid, 0)`, so no caller can block past `deadline`.
    fn waitpid_outcome(pid: libc::pid_t, deadline: Instant) -> ReapOutcome {
        loop {
            let mut status: libc::c_int = 0;
            let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            if waited == pid { return ReapOutcome::Reaped(status); }
            if waited == 0 {
                if Instant::now() >= deadline { return ReapOutcome::Unresolved; }
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            if errno == libc::EINTR {
                // The finite deadline bounds every continuing path, including an
                // EINTR retry, so a signal storm cannot loop past the deadline.
                // Any exact-child status already returned above is preserved.
                if Instant::now() >= deadline { return ReapOutcome::Unresolved; }
                continue;
            }
            if errno == libc::ECHILD { return ReapOutcome::ChildGone; }
            return ReapOutcome::Error(errno);
        }
    }

    /// Kernel proof of process absence: only `ESRCH` proves the process is gone.
    /// A successful probe or `EPERM` proves it is still present; any other errno
    /// is inconclusive and reported as `None`, never as absent.
    fn process_absent(pid: libc::pid_t) -> Option<bool> {
        if unsafe { libc::kill(pid, 0) } == 0 { return Some(false); }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => Some(true),
            Some(libc::EPERM) => Some(false),
            _ => None,
        }
    }

    struct CleanupReport {
        outcome: ReapOutcome,
        kill_result: libc::c_int,
        kill_errno: Option<libc::c_int>,
        absent: Option<bool>,
    }

    /// Owns the forked helper child PID and the two parent pipe ends created
    /// immediately after a successful `fork`. Every early assert/poll/read/probe
    /// failure and the deliberate pre-release failure unwind through this
    /// guard's `Drop`: it closes the owned descriptors and performs one bounded
    /// `SIGKILL` + checked exact-child reap. `reaped` is set only after the exact
    /// pid is reaped or kernel-confirmed absent, so an unresolved child is never
    /// silently certified as cleaned up.
    struct LeaseChildGuard {
        pid: libc::pid_t,
        ack_read: Option<libc::c_int>,
        release_write: Option<libc::c_int>,
        reaped: bool,
        proof: Option<(PathBuf, &'static str)>,
    }

    impl LeaseChildGuard {
        fn new(pid: libc::pid_t, ack_read: libc::c_int, release_write: libc::c_int) -> Self {
            Self { pid, ack_read: Some(ack_read), release_write: Some(release_write), reaped: false, proof: None }
        }

        fn ack_fd(&self) -> libc::c_int { self.ack_read.unwrap_or(-1) }

        fn close_ack(&mut self) {
            if let Some(fd) = self.ack_read.take() { unsafe { libc::close(fd); } }
        }

        fn close_release(&mut self) {
            if let Some(fd) = self.release_write.take() { unsafe { libc::close(fd); } }
        }

        fn send_release(&mut self) -> bool {
            match self.release_write {
                Some(fd) => { let go: [u8; 1] = [b'R']; unsafe { libc::write(fd, go.as_ptr().cast(), 1) == 1 } }
                None => false,
            }
        }

        /// Record that this guard's own `Drop` must publish the checked cleanup
        /// proof to `path` under `reason`.
        fn arm_proof(&mut self, path: PathBuf, reason: &'static str) { self.proof = Some((path, reason)); }

        /// The shared cleanup used by every early-error branch (via `Drop`) and
        /// by the bounded released-child escalation: close owned descriptors,
        /// bounded `SIGKILL`, then the one checked exact-child reap. `reaped` is
        /// only set on `Reaped`/`ChildGone`.
        fn cleanup_pre_release(&mut self, _reason: &str) -> CleanupReport {
            self.close_ack();
            self.close_release();
            self.bounded_kill_reap(Instant::now() + Duration::from_secs(5))
        }

        fn bounded_kill_reap(&mut self, deadline: Instant) -> CleanupReport {
            let kill_result = unsafe { libc::kill(self.pid, libc::SIGKILL) };
            let kill_errno = if kill_result == 0 { None } else { std::io::Error::last_os_error().raw_os_error() };
            let outcome = waitpid_outcome(self.pid, deadline);
            if matches!(outcome, ReapOutcome::Reaped(_) | ReapOutcome::ChildGone) { self.reaped = true; }
            let absent = process_absent(self.pid);
            CleanupReport { outcome, kill_result, kill_errno, absent }
        }

        /// Bounded `WNOHANG` reap of the released child. If it does not close
        /// within the deadline this escalates once to the shared bounded
        /// kill/reap and panics - there is no unbounded blocking fallback.
        fn reap_released(&mut self) -> libc::c_int {
            let deadline = Instant::now() + Duration::from_secs(10);
            match waitpid_outcome(self.pid, deadline) {
                ReapOutcome::Reaped(status) => { self.reaped = true; status }
                ReapOutcome::Unresolved => {
                    let report = self.bounded_kill_reap(Instant::now() + Duration::from_secs(5));
                    match report.outcome {
                        ReapOutcome::Unresolved =>
                            panic!("inherited-lease child still unresolved after bounded kill/reap"),
                        ReapOutcome::Error(errno) =>
                            panic!("inherited-lease child reap failed with errno {errno}"),
                        _ => panic!("inherited-lease child did not close on explicit release"),
                    }
                }
                ReapOutcome::ChildGone =>
                    panic!("released inherited-lease child vanished without a waitable status (ECHILD)"),
                ReapOutcome::Error(errno) =>
                    panic!("released inherited-lease child reap failed with errno {errno}"),
            }
        }

        /// Publish the actual checked cleanup evidence. Never fabricates a
        /// status: `reapedActualPid` is true only for a real `Reaped` outcome and
        /// `absentAfterReap` is the ESRCH-only kernel proof. Errors are swallowed
        /// because this runs during unwind.
        fn write_proof(&self, path: &Path, reason: &str, report: &CleanupReport) {
            let (reap, waited, status) = match report.outcome {
                ReapOutcome::Reaped(raw) => ("reaped", serde_json::Value::from(self.pid as i64), serde_json::Value::from(raw)),
                ReapOutcome::ChildGone => ("child-gone", serde_json::Value::from(0), serde_json::Value::Null),
                ReapOutcome::Unresolved => ("unresolved", serde_json::Value::from(0), serde_json::Value::Null),
                ReapOutcome::Error(errno) => ("error", serde_json::Value::from(0), serde_json::Value::from(errno)),
            };
            let proof = serde_json::json!({
                "reason": reason,
                "cleanupVia": "guard-drop",
                "childPid": self.pid,
                "ackClosed": self.ack_read.is_none(),
                "releaseClosed": self.release_write.is_none(),
                "killResult": report.kill_result,
                "killErrno": report.kill_errno,
                "reap": reap,
                "waitedPid": waited,
                "rawStatus": status,
                "reapedActualPid": matches!(report.outcome, ReapOutcome::Reaped(_)),
                "absentAfterReap": report.absent,
            });
            if let Ok(bytes) = serde_json::to_vec_pretty(&proof) {
                let _ = OpenOptions::new().write(true).create_new(true).mode(0o600)
                    .open(path)
                    .and_then(|mut file| file.write_all(&bytes).and_then(|()| file.sync_all()));
            }
        }
    }

    impl Drop for LeaseChildGuard {
        fn drop(&mut self) {
            self.close_ack();
            self.close_release();
            if self.reaped { return; }
            // Best-effort bounded cleanup through the shared path. Drop must
            // never panic (a panic while already unwinding aborts the process)
            // and must never silently certify a cleanup it could not prove; the
            // proof records the truthful outcome for the caller's assertions.
            let report = self.cleanup_pre_release("guard drop before release");
            if let Some((path, reason)) = self.proof.take() {
                self.write_proof(&path, reason, &report);
            }
        }
    }

    /// Owns an outer spawned helper process so an early polling/assertion
    /// failure can never orphan it: `Drop` bounded-kills and reaps the exact
    /// child when the test has not already performed the checked wait.
    struct OwnedHelper {
        child: Option<std::process::Child>,
        reaped: bool,
    }
    impl OwnedHelper {
        fn new(child: std::process::Child) -> Self { Self { child: Some(child), reaped: false } }

        fn kill_and_reap(&mut self) {
            if let Some(mut child) = self.child.take() {
                let pid = child.id() as libc::pid_t;
                let _ = child.kill();
                // Reuse the shared finite checked exact-child reap instead of an
                // unbounded ignored `wait`. `reaped` is set only on an actual
                // observed exit of this exact child; ECHILD/unresolved/error
                // never certify a wait, and Drop stays finite and non-panicking.
                let deadline = Instant::now() + Duration::from_secs(5);
                if matches!(waitpid_outcome(pid, deadline), ReapOutcome::Reaped(_)) {
                    self.reaped = true;
                }
            }
        }

        fn wait_bounded(&mut self, deadline: Instant) -> std::process::ExitStatus {
            loop {
                match self.child.as_mut().expect("owned helper present").try_wait() {
                    Ok(Some(status)) => { self.reaped = true; return status; }
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            self.kill_and_reap();
                            panic!("owned helper exceeded its bounded deadline");
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => {
                        self.kill_and_reap();
                        panic!("owned helper try_wait failed: {error}");
                    }
                }
            }
        }
    }
    impl Drop for OwnedHelper {
        fn drop(&mut self) {
            if !self.reaped { self.kill_and_reap(); }
        }
    }

    /// Force a genuine pre-release panic so the cleanup runs through
    /// `LeaseChildGuard::drop` - the same path every early assert/poll/read
    /// failure takes - instead of an explicit cleanup that would disarm Drop.
    /// `guard` is moved into the panicking closure, so its `Drop` performs the
    /// checked bounded kill/reap and writes `lease-cleanup-proof.json`. This
    /// helper then removes the known-owned private socket resources by recorded
    /// identity and folds that evidence into the same proof before diverging.
    fn fail_pre_release_through_drop(mut guard: LeaseChildGuard, session: &Path, owner: &Owner) -> ! {
        let proof_path = session.join("lease-cleanup-proof.json");
        guard.arm_proof(proof_path.clone(), "deliberate pre-release failure");
        let unwound = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _held = guard; // moved in so the real panic unwinds through its Drop
            panic!("deliberate pre-release failure: unwinding through LeaseChildGuard Drop");
        }));
        assert!(unwound.is_err(), "the deliberate pre-release failure must unwind through Drop");
        let socket_dir = socket_directory(owner).unwrap();
        remove_socket_resources(owner).unwrap();
        let mut proof: serde_json::Value = serde_json::from_slice(&fs::read(&proof_path).unwrap()).unwrap();
        proof["knownOwnedSocketCleanup"] = serde_json::json!({
            "socketDirectory": socket_dir.to_string_lossy(),
            "socketDirectoryRemoved": !socket_dir.exists(),
        });
        let bytes = serde_json::to_vec_pretty(&proof).unwrap();
        let mut receipt = OpenOptions::new().write(true).truncate(true).open(&proof_path).unwrap();
        receipt.write_all(&bytes).unwrap();
        receipt.sync_all().unwrap();
        panic!("deliberate pre-release failure helper exit after known-owned socket cleanup");
    }

    /// Sole-owner inheritance fixture, run only inside the ignored helper
    /// subprocess. The helper acquires the one original RuntimeControl (the
    /// exact lease open file description) and then forks. The child inherits
    /// that description (CLOEXEC only processes exec, never fork) and performs
    /// only async-signal-safe libc calls; it never independently acquires or
    /// opens a second lease description. After the child ACKs, the helper
    /// *drops* the original control - closing the original descriptor, no
    /// `LOCK_UN` - while the child's shared description keeps the exclusive
    /// lock. A fresh independent `EX|NB` probe must then fail. The helper sends
    /// an explicit release; the child closes the inherited descriptor and
    /// exits; the helper uses a bounded `WNOHANG` reap with an explicit
    /// failure kill and actual wait, after which a fresh probe succeeds. Every
    /// pre-release error path is owned by `LeaseChildGuard`.
    fn lease_inherit_fixture(session: &Path) {
        let control = RuntimeControl::acquire(session, &session.join("target")).unwrap();
        let owner = control.verify_owned().unwrap();
        let record_path = control.directory.join(RECORD);
        let lease_path = control.directory.join(LEASE);
        let lease_fd = control.lease.as_raw_fd();
        let failure_mode = std::env::var_os("XPOD_TEST_NFS_LEASE_FAIL_BEFORE_RELEASE").is_some();
        let mut ack = [0i32; 2];
        let mut release = [0i32; 2];
        assert_eq!(unsafe { libc::pipe(ack.as_mut_ptr()) }, 0, "ack pipe");
        assert_eq!(unsafe { libc::pipe(release.as_mut_ptr()) }, 0, "release pipe");
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0, "fork failed");
        if pid == 0 {
            // Child: only async-signal-safe libc read/write/close/_exit after
            // fork. The inherited descriptor carries the exclusive flock; the
            // child holds it until the explicit release.
            unsafe {
                libc::close(ack[0]);
                libc::close(release[1]);
                let ready: [u8; 1] = [b'A'];
                libc::write(ack[1], ready.as_ptr().cast(), 1);
                let mut byte = [0u8; 1];
                libc::read(release[0], byte.as_mut_ptr().cast(), 1);
                // Closing the inherited shared description is the only release;
                // no LOCK_UN is ever issued.
                libc::close(lease_fd);
                libc::_exit(0);
            }
        }
        unsafe { libc::close(ack[1]); libc::close(release[0]); }
        // The guard is created immediately after a successful fork: it owns the
        // exact child pid and both parent pipe ends for the rest of the fixture.
        let mut guard = LeaseChildGuard::new(pid, ack[0], release[1]);
        // Bounded wait for the child ACK through the guard-owned descriptor.
        let mut descriptor = libc::pollfd { fd: guard.ack_fd(), events: libc::POLLIN, revents: 0 };
        let polled = unsafe { libc::poll(&mut descriptor, 1, 5000) };
        assert!(polled > 0, "child must ACK the inherited lease description");
        let mut byte = [0u8; 1];
        assert_eq!(unsafe { libc::read(guard.ack_fd(), byte.as_mut_ptr().cast(), 1) }, 1);
        guard.close_ack();
        if failure_mode {
            fail_pre_release_through_drop(guard, session, &owner);
        }
        // Drop the ORIGINAL control: close the original descriptor (not
        // LOCK_UN). The forked child still references the same description.
        drop(control);
        let probe = open_private(&lease_path).unwrap();
        let held = unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        assert_ne!(held, 0, "the child's inherited shared description must still hold the lease");
        let errno = std::io::Error::last_os_error().raw_os_error();
        assert!(errno == Some(libc::EWOULDBLOCK) || errno == Some(libc::EAGAIN),
                "fresh independent probe must be EAGAIN/EWOULDBLOCK, got {errno:?}");
        // Explicit release: the child closes the inherited description, which
        // drops the last reference and frees the kernel lock.
        assert!(guard.send_release(), "release byte must be written to the child");
        guard.close_release();
        let status = guard.reap_released();
        assert_eq!(std::process::ExitStatus::from_raw(status).code(), Some(0),
                   "released inherited-lease child must exit 0, status={status}");
        // Last reference gone: the fresh probe now succeeds.
        assert_eq!(unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0,
                   "lease must be free after the child closes the inherited description");
        unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_UN); }
        drop(probe);
        remove_socket_resources(&owner).unwrap();
        remove_known(&record_path, owner.record, false).unwrap();
    }

    #[test]
    fn actual_dead_owner_releases_flock_and_only_proven_stale_socket_is_collected() {
        let fixture = Fixture::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "mount_control::tests::lease_child", "--nocapture"])
            .env("XPOD_TEST_NFS_CONTROL_SESSION", &fixture.session)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let started = Instant::now();
        while !fixture.session.join("ready").exists() && started.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(10)); }
        let ready = fixture.session.join("ready").exists();
        let live_refused = RuntimeControl::acquire(&fixture.session, &fixture.target).is_err();
        let old = if ready { Some(read_owner(&fixture.session.join(DIRECTORY))) } else { None };
        let killed = child.kill();
        let status = child.wait().unwrap();
        killed.unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        assert!(ready && live_refused, "owned child must actually acquire its live lease");
        let old = old.unwrap().unwrap(); let old_temporary = socket_directory(&old).unwrap();
        let old_record_bytes = fs::read(fixture.session.join(DIRECTORY).join(RECORD)).unwrap();
        let fresh_target = fixture.session.join("fresh-target-B");
        let mut foreign_identity = fixture.identity();
        foreign_identity.source = b"foreign-source".to_vec();
        for observation in [MountState::Mounted(fixture.identity()), MountState::Mounted(foreign_identity), MountState::Unknown("controlled unavailable table".into())] {
            let result = RuntimeControl::acquire_observed(&fixture.session, &fresh_target, |observed_target| {
                assert_eq!(observed_target, fixture.target, "must observe old A rather than fresh B");
                observation.clone()
            });
            assert!(result.is_err());
            assert_eq!(fs::read(fixture.session.join(DIRECTORY).join(RECORD)).unwrap(), old_record_bytes);
            assert_eq!(FileIdentity::of(&private_metadata(&old_temporary.join(SOCKET), true).unwrap()), old.socket);
            assert_eq!(directory_identity(&old_temporary).unwrap(), old.socket_directory);
            assert_eq!(FileIdentity::of(&private_metadata(&fixture.session.join(DIRECTORY).join(LEASE), false).unwrap()), old.lease);
        }
        let control = RuntimeControl::acquire_observed(&fixture.session, &fresh_target, |observed_target| {
            assert_eq!(observed_target, fixture.target);
            MountState::Absent
        }).unwrap();
        assert_eq!(control.verify_owned().unwrap().target, fresh_target.as_os_str().as_bytes());
        assert!(!old_temporary.exists());
        clean_fixture_runtime(&control);
    }

    #[test]
    fn inherited_original_lease_description_survives_helper_close_until_child_release() {
        // The CONFIRMED deadlock, corrected as a genuinely isolated
        // subprocess-owned fixture. The ignored helper runs the sole
        // RuntimeControl acquisition and the fork internally; this outer test
        // never forks a live lease descriptor itself (the removed fixture did,
        // in a multithreaded process, and its LOCK_UN-on-a-second-description
        // never released the original lock). The helper proves the exact
        // causality: child inherits the original open description, helper
        // *closes* its own original descriptor (no LOCK_UN), a fresh EAGAIN
        // window exists, the explicit release through the child closes the
        // last reference, and only then does a fresh probe succeed.
        let fixture = Fixture::new();
        let mut helper = OwnedHelper::new(Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "mount_control::tests::lease_child", "--nocapture"])
            .env("XPOD_TEST_NFS_CONTROL_SESSION", &fixture.session)
            .env("XPOD_TEST_NFS_LEASE_INHERIT", "1")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap());
        // Bounded observation of the owned helper; the guard kills/reaps it on
        // any early polling/assertion failure so it can never be orphaned.
        let status = helper.wait_bounded(Instant::now() + Duration::from_secs(30));
        assert!(status.success(), "isolated lease-inheritance helper failed: {status:?}");
        // Genuine pre-release panic regression: the helper is forced to panic
        // before the controlled release, so the cleanup runs through the guard's
        // own `Drop` (never an explicit pre-panic call). The proof is read back
        // here and the helper itself must exit nonzero. The actual negative ->
        // positive Rust child-absence run stays bound to the official remote
        // unfiltered inventory.
        let failing = Fixture::new();
        let mut failed = OwnedHelper::new(Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "mount_control::tests::lease_child", "--nocapture"])
            .env("XPOD_TEST_NFS_CONTROL_SESSION", &failing.session)
            .env("XPOD_TEST_NFS_LEASE_INHERIT", "1")
            .env("XPOD_TEST_NFS_LEASE_FAIL_BEFORE_RELEASE", "1")
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap());
        let fail_status = failed.wait_bounded(Instant::now() + Duration::from_secs(30));
        assert!(!fail_status.success(), "pre-release failure must fail the helper: {fail_status:?}");
        let proof: serde_json::Value = serde_json::from_slice(
            &fs::read(failing.session.join("lease-cleanup-proof.json")).unwrap()).unwrap();
        let child_pid = proof["childPid"].as_i64().unwrap();
        assert_eq!(proof["cleanupVia"].as_str(), Some("guard-drop"),
                   "cleanup must run through the guard Drop, not an explicit pre-panic call");
        assert_eq!(proof["waitedPid"].as_i64(), Some(child_pid), "Drop must reap the exact child pid");
        assert_eq!(proof["reapedActualPid"].as_bool(), Some(true));
        assert_eq!(proof["ackClosed"].as_bool(), Some(true), "owned ack fd must be closed");
        assert_eq!(proof["releaseClosed"].as_bool(), Some(true), "owned release fd must be closed");
        assert_eq!(proof["absentAfterReap"].as_bool(), Some(true),
                   "only ESRCH-confirmed absence proves no owned child remains");
        assert_eq!(proof["knownOwnedSocketCleanup"]["socketDirectoryRemoved"].as_bool(), Some(true),
                   "known-owned private socket directory must be removed");
        let socket_directory = PathBuf::from(proof["knownOwnedSocketCleanup"]["socketDirectory"].as_str().unwrap());
        assert!(!socket_directory.exists(), "recorded private socket directory must actually be gone");
    }

    #[test]
    fn live_lease_holder_makes_closed_proof_observation_return_false_until_release() {
        // Controlled ACK lease-holder causality: a real child holds the lease
        // (a separate process, an actual acquired RuntimeControl), so the
        // closed-proof observation must return Ok(false) - lease held, nothing
        // inspected or published - and only flip once the holder is actually
        // waited. This uses the original lease, spawn and wait paths.
        let fixture = Fixture::new();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "mount_control::tests::lease_child", "--nocapture"])
            .env("XPOD_TEST_NFS_CONTROL_SESSION", &fixture.session)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let started = Instant::now();
        while !fixture.session.join("ready").exists() && started.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(10)); }
        assert!(fixture.session.join("ready").exists(), "live holder must actually acquire the lease");
        // Held: Ok(false), never an error and never true.
        assert!(!completed_owner_observed(&fixture.session, &fixture.target, || MountState::Absent, true).unwrap(),
                "a live lease holder must not be mistaken for a retired runtime");
        let killed = child.kill();
        let status = child.wait().unwrap();
        killed.unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        // The lease was released by actual death; no stale marker exists yet, so
        // the closed proof is still unavailable but the lease is now free.
        let lease = open_private(&fixture.session.join(DIRECTORY).join(LEASE)).unwrap();
        assert_eq!(unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0,
                   "actual holder death must release the kernel lease");
        unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_UN); }
        let owner = read_owner(&fixture.session.join(DIRECTORY)).unwrap();
        remove_socket_resources(&owner).unwrap();
        fs::remove_file(fixture.session.join(DIRECTORY).join(RECORD)).unwrap();
    }

    async fn send_request(owner: &Owner, start: bool) -> Reply {
        let mut stream = UnixStream::connect(socket_directory(owner).unwrap().join(SOCKET)).await.unwrap();
        let request = if start { Request::Unmount { nonce: owner.nonce.clone(), target: owner.target.clone() } }
            else { Request::Status { nonce: owner.nonce.clone(), target: owner.target.clone() } };
        write_frame(&mut stream, &request, IO_BUDGET).await.unwrap();
        read_frame(&mut stream, IO_BUDGET).await.unwrap()
    }

    #[test]
    fn disconnected_client_pending_identity_and_failed_child_retry() {
        let fixture = Fixture::new(); let identity = fixture.identity();
        let control = Arc::new(RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap());
        control.bind_identity(&identity).unwrap();
        let owner = control.verify_owned().unwrap();
        let state = Arc::new(Mutex::new(State { binding: Some(Binding::from_mount(&identity)), child: None }));
        let table = Arc::new(Mutex::new(MountState::Mounted(identity)));
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writers = Arc::new(Mutex::new(Vec::new()));
        let _owned_children = BarrierChildren { writers: writers.clone(), state: state.clone() };
        let spawn_count = count.clone();
        let spawn_writers = writers.clone();
        let spawn: Arc<dyn Fn() -> Result<CommandObservation> + Send + Sync> = Arc::new(move || {
            let index = spawn_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (child, writer) = spawn_barrier_child(if index == 0 { 42 } else { 0 })?;
            spawn_writers.lock().unwrap().push(writer);
            Ok(child)
        });
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let observed = table.clone();
            let server = tokio::spawn(control.clone().serve_with_observer(state.clone(), Arc::new(move || observed.lock().unwrap().clone()), spawn, IO_BUDGET));
            // The real stream closes immediately after the request, before ACK.
            let mut stream = UnixStream::connect(socket_directory(&owner).unwrap().join(SOCKET)).await.unwrap();
            write_frame(&mut stream, &Request::Unmount { nonce: owner.nonce.clone(), target: owner.target.clone() }, IO_BUDGET).await.unwrap();
            drop(stream);
            tokio::time::timeout(IO_BUDGET, async {
                while state.lock().unwrap().child.is_none() { tokio::task::yield_now().await; }
            }).await.expect("disconnected request must start its owned child");
            let first = match send_request(&owner, false).await { Reply::Pending { pid, .. } => pid, _ => panic!("owned child should be pending") };
            assert!(matches!(send_request(&owner, true).await, Reply::Pending { pid, .. } if pid == first));
            assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
            // Table absence while a child is pending must not retire the server.
            *table.lock().unwrap() = MountState::Absent;
            assert!(matches!(send_request(&owner, false).await, Reply::Pending { pid, actual_wait: false, kernel: KernelObservation::Absent, .. } if pid == first));
            assert!(!server.is_finished());
            *table.lock().unwrap() = MountState::Unknown("fixture".into());
            assert!(matches!(send_request(&owner, false).await, Reply::Pending { pid, actual_wait: false, kernel: KernelObservation::Unknown, .. } if pid == first));
            assert!(!server.is_finished());
            drop(writers.lock().unwrap().remove(0));
            tokio::time::timeout(IO_BUDGET, async {
                loop {
                    match send_request(&owner, false).await {
                        Reply::Pending { pid, actual_wait: false, actual_exit: None, actual_signal: None, kernel: KernelObservation::Unknown, .. } if pid == first => tokio::task::yield_now().await,
                        Reply::Failed { pid, actual_exit: Some(42), actual_signal: None, .. } if pid == first => break,
                        reply => panic!("unexpected first-child outcome: {}", reply_diagnostic(&reply)),
                    }
                }
            }).await.expect("same owned child must actually close with exit42");
            assert!(matches!(send_request(&owner, true).await, Reply::Rejected { .. }));
            assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
            *table.lock().unwrap() = MountState::Mounted(fixture.identity());
            let second = match send_request(&owner, true).await { Reply::Pending { pid, actual_wait: false, .. } => pid, reply => panic!("unexpected retry outcome: {}", reply_diagnostic(&reply)) };
            assert_ne!(second, first);
            assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 2);
            *table.lock().unwrap() = MountState::Absent;
            assert!(matches!(send_request(&owner, false).await, Reply::Pending { pid, actual_wait: false, kernel: KernelObservation::Absent, .. } if pid == second));
            assert!(!server.is_finished());
            drop(writers.lock().unwrap().remove(0));
            tokio::time::timeout(IO_BUDGET, server).await.unwrap().unwrap().unwrap();
            let child = state.lock().unwrap().child.as_ref().unwrap().status.unwrap();
            assert_eq!(child.code(), Some(0)); assert_eq!(child.signal(), None);
        });
        drop(control); // Actual runtime lease release is required for recovery.
        assert!(completed_owner_observed(&fixture.session, &fixture.target, || MountState::Absent, true).unwrap());
    }

    #[test]
    fn cli_total_deadline_preserves_same_owned_child_and_runtime() {
        let fixture = Fixture::new(); let identity = fixture.identity();
        let control = Arc::new(RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap());
        control.bind_identity(&identity).unwrap();
        let state = Arc::new(Mutex::new(State { binding: Some(Binding::from_mount(&identity)), child: None }));
        let table = Arc::new(Mutex::new(MountState::Mounted(identity)));
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0)); let spawned = count.clone();
        let observed = table.clone();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let server = tokio::spawn(control.clone().serve_with_observer(state.clone(),
                Arc::new(move || observed.lock().unwrap().clone()),
                Arc::new(move || { spawned.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    mount::spawn_command(Command::new("/bin/sh").args(["-c", "sleep 0.3; exit 0"]), "owned-test") }), IO_BUDGET));
            let error = unmount_with_observer(&fixture.session, &fixture.target, Duration::from_millis(60), || table.lock().unwrap().clone()).await.unwrap_err();
            assert!(error.downcast_ref::<PendingUnmount>().is_some());
            assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert!(state.lock().unwrap().child.as_ref().unwrap().status.is_none());
            assert!(!server.is_finished());
            let owner = control.verify_owned().unwrap();
            let pid = state.lock().unwrap().child.as_ref().unwrap().child.id();
            assert!(matches!(send_request(&owner, false).await, Reply::Pending { pid: seen, .. } if seen == pid));
            *table.lock().unwrap() = MountState::Absent;
            tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
            assert_eq!(state.lock().unwrap().child.as_ref().unwrap().status.unwrap().code(), Some(0));
        });
        drop(control);
        assert!(completed_owner_observed(&fixture.session, &fixture.target, || MountState::Absent, true).unwrap());
    }

    #[test]
    fn client_observes_closed_proof_after_socket_loss_without_second_unmount() {
        let fixture = Fixture::new(); let identity = fixture.identity();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        control.bind_identity(&identity).unwrap();
        let owner = control.verify_owned().unwrap();
        let child = actual_exit(0);
        let snapshot = PendingSnapshot::from_child(owner.nonce.clone(), &child, KernelObservation::Absent);
        let mut closed_owner = owner.clone();
        closed_owner.closed = Some(Closed { pid: child.child.id(), actual_exit: 0, actual_signal: None,
            binding: owner.binding.clone().unwrap(), cleanup_complete: true });
        let listener = control.listener.try_clone().unwrap();
        let mut held_control = Some(control);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let listener = UnixListener::from_std(listener).unwrap();
            let server_owner = owner.clone();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request: Request = read_frame(&mut stream, IO_BUDGET).await.unwrap();
                assert!(matches!(request, Request::Unmount { nonce, target } if nonce == server_owner.nonce && target == server_owner.target));
                write_frame(&mut stream, &snapshot.reply(), IO_BUDGET).await.unwrap();
                remove_socket_resources(&server_owner).unwrap();
                // The written frame remains intact on this connected stream.
            });
            let mut lost = 0;
            unmount_with_transport_hook(&fixture.session, &fixture.target, Duration::from_millis(200), || MountState::Absent, || {
                lost += 1;
                let control = held_control.take().unwrap();
                control.store_owner(closed_owner.clone()).unwrap();
                drop(control); // Deterministic actual lease release only after IPC loss.
            }).await.unwrap();
            server.await.unwrap();
            assert_eq!(lost, 1);
            assert!(held_control.is_none());
        });
        assert!(completed_owner_observed(&fixture.session, &fixture.target, || MountState::Absent, false).unwrap());
    }

    #[test]
    fn closed_marker_is_read_only_after_actual_lease_release() {
        for (replace_nonce, replace_pid) in [(false, false), (true, false), (false, true)] {
            let fixture = Fixture::new(); let identity = fixture.identity();
            let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
            control.bind_identity(&identity).unwrap();
            let child = actual_exit(0);
            assert_eq!(child.status.unwrap().code(), Some(0));
            assert_eq!(child.status.unwrap().signal(), None);
            let expected = control.verify_owned().unwrap();
            let other_child = actual_exit(0);
            let last = PendingSnapshot::from_child(expected.nonce.clone(), if replace_pid { &other_child } else { &child }, KernelObservation::Absent);
            let temporary = control.directory.join(format!("owner.{}.new", expected.nonce));
            let temporary_file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).unwrap();
            assert!(!completed_owner_observed(&fixture.session, &fixture.target, || MountState::Absent, true).unwrap(), "live lease prevents inspecting transient writer entries");
            let result = completed_owner_for_operation(&fixture.session, &fixture.target, || MountState::Absent, true, Some(&expected), Some(&last), move || {
                drop(temporary_file); fs::remove_file(temporary).unwrap();
                let mut owner = control.verify_owned().unwrap();
                owner.closed = Some(Closed { pid: child.child.id(), actual_exit: 0, actual_signal: None,
                    binding: owner.binding.clone().unwrap(), cleanup_complete: true });
                if replace_nonce { owner.nonce = nonce().unwrap(); }
                control.store_owner(owner).unwrap();
                drop(control); // Release the real kernel flock only after atomic marker update.
            });
            if replace_nonce || replace_pid {
                assert!(result.unwrap_err().to_string().contains(if replace_nonce { "closed runtime binding changed" } else { "closed operation binding changed" }));
                let owner = read_owner(&fixture.session.join(DIRECTORY)).unwrap();
                remove_socket_resources(&owner).unwrap();
            } else { assert!(result.unwrap()); }
        }
    }

    #[test]
    fn closed_proof_survives_ack_loss_and_partial_socket_cleanup() {
        let fixture = Fixture::new(); let identity = fixture.identity();
        let control = Arc::new(RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap());
        control.bind_identity(&identity).unwrap();
        let owner = control.verify_owned().unwrap(); let temporary = socket_directory(&owner).unwrap();
        let state = Arc::new(Mutex::new(State { binding: Some(Binding::from_mount(&identity)), child: None }));
        let table = Arc::new(Mutex::new(MountState::Mounted(identity)));
        let observed = table.clone();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let server = tokio::spawn(control.clone().serve_with_hooks(state,
                Arc::new(move || observed.lock().unwrap().clone()),
                Arc::new(|| mount::spawn_command(Command::new("/bin/sh").args(["-c", "sleep 0.1; exit 0"]), "owned-test")),
                Arc::new(|owner| {
                    let directory = socket_directory(owner)?;
                    remove_known(&directory.join(SOCKET), owner.socket, true)?;
                    anyhow::bail!("injected failure after actual socket unlink");
                }), IO_BUDGET));
            let mut stream = UnixStream::connect(temporary.join(SOCKET)).await.unwrap();
            write_frame(&mut stream, &Request::Unmount { nonce: owner.nonce.clone(), target: owner.target.clone() }, IO_BUDGET).await.unwrap();
            drop(stream);
            tokio::time::sleep(Duration::from_millis(30)).await;
            *table.lock().unwrap() = MountState::Absent;
            tokio::time::timeout(Duration::from_secs(5), server).await.unwrap().unwrap().unwrap();
        });
        assert!(temporary.is_dir()); assert!(!temporary.join(SOCKET).exists());
        let closed = read_owner(&control.directory).unwrap();
        assert_eq!(closed.closed.as_ref().unwrap().actual_exit, 0);
        assert!(!completed_owner_observed(&fixture.session, &fixture.target, || MountState::Absent, true).unwrap(), "live lease cannot be mistaken for retired runtime");
        drop(control);
        assert!(completed_owner_observed(&fixture.session, &fixture.target, || MountState::Absent, false).is_err(), "original CLI must report secondary cleanup failure");
        assert!(completed_owner_observed(&fixture.session, &fixture.target, || MountState::Unknown("fixture".into()), true).is_err());
        assert!(completed_owner_observed(&fixture.session, &fixture.target, || MountState::Absent, true).unwrap());
        assert!(!temporary.exists());
    }

    #[test]
    fn malformed_oversized_and_incomplete_frames_do_not_retire_server() {
        let fixture = Fixture::new();
        let control = Arc::new(RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap());
        let socket = socket_directory(&control.verify_owned().unwrap()).unwrap().join(SOCKET);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let server = tokio::spawn(control.clone().serve_with_observer(Arc::new(Mutex::new(State::default())), Arc::new(|| MountState::Unknown("fixture".into())), Arc::new(|| anyhow::bail!("must not spawn")), Duration::from_millis(50)));
            for payload in [Some(b"bad-json".as_slice()), None] {
                let mut stream = UnixStream::connect(&socket).await.unwrap();
                if let Some(bytes) = payload { stream.write_all(&(bytes.len() as u32).to_be_bytes()).await.unwrap(); stream.write_all(bytes).await.unwrap(); }
                let reply: Reply = read_frame(&mut stream, Duration::from_secs(5)).await.unwrap();
                assert!(matches!(reply, Reply::Rejected { .. }));
                assert!(!server.is_finished());
            }
            let mut stream = UnixStream::connect(&socket).await.unwrap();
            stream.write_all(&((LIMIT + 1) as u32).to_be_bytes()).await.unwrap();
            assert!(matches!(read_frame::<Reply>(&mut stream, IO_BUDGET).await.unwrap(), Reply::Rejected { .. }));
            server.abort(); let _ = server.await;
        });
        clean_fixture_runtime(&control);
    }
    fn spawn_barrier_child(exit: u8) -> Result<(CommandObservation, std::os::unix::net::UnixStream)> {
        // The barrier reader is redirected through stdin. This shared
        // initializer installs no application `pre_exec` hook, so it adds no
        // fork-before-exec window of its own. `CLOEXEC` on the pair only
        // guarantees the writer is closed across `exec`; it does not, on its
        // own, describe a fork that has not yet reached exec. The exact spawn
        // backend (posix_spawn vs fork+exec) is `std`'s conditional choice and
        // is neither selected nor claimed here.
        let (reader, writer) = std::os::unix::net::UnixStream::pair().unwrap();
        let owned: std::os::fd::OwnedFd = reader.into();
        let mut command = Command::new("/bin/sh"); command.args(["-c", &format!("read barrier; exit {exit}")]);
        command.stdin(Stdio::from(owned));
        let child = mount::spawn_stdin_command(&mut command, "control-test")?;
        Ok((child, writer))
    }

    fn reply_diagnostic(reply: &Reply) -> String {
        let mut value = serde_json::to_value(reply).unwrap();
        if let Some(fields) = value.as_object_mut() { fields.remove("nonce"); }
        value.to_string()
    }

    struct BarrierChildren {
        writers: Arc<Mutex<Vec<std::os::unix::net::UnixStream>>>,
        state: Arc<Mutex<State>>,
    }
    impl Drop for BarrierChildren {
        fn drop(&mut self) {
            let mut writers = self.writers.lock().unwrap_or_else(|error| error.into_inner());
            // Dropping each writer closes the child's stdin and simplifies its
            // EOF; the owned fixture child is reaped below by its real status.
            for writer in writers.drain(..) { let _ = writer.shutdown(std::net::Shutdown::Both); }
            drop(writers);
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(child) = state.child.as_mut() {
                // A child that already exited is reaped directly. A cooperative
                // fixture child is killed before waiting so a stray reference
                // can never turn teardown into an unbounded wait and orphan a
                // descendant after the test process returns.
                if child.status.is_none() { let _ = child.child.kill(); }
                child.status = Some(child.child.wait().expect("released owned fixture child must be reaped"));
            }
        }
    }

    #[test]
    fn pending_snapshot_uses_real_owned_wait_status() {
        let fixture = Fixture::new();
        let control = RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap();
        let identity = fixture.identity(); control.bind_identity(&identity).unwrap();
        let owner = control.verify_owned().unwrap(); let binding = Binding::from_mount(&identity);
        let (mut child, writer) = spawn_barrier_child(0).unwrap();
        child.refresh();
        let running = PendingSnapshot::from_child(owner.nonce.clone(), &child, KernelObservation::Mounted);
        // Release and reap before any observation assertion can panic.
        drop(writer);
        child.status = Some(child.child.wait().unwrap());
        assert!(!running.actual_wait); assert_eq!(running.actual_exit, None);
        for table in [MountState::Mounted(identity.clone()), MountState::Unknown("fixture".into())] {
            let closed = PendingSnapshot::from_child(owner.nonce.clone(), &child, KernelObservation::classify(&table, &owner, &binding));
            assert_eq!(closed.pid, child.child.id()); assert!(closed.actual_wait);
            assert_eq!(closed.actual_exit, Some(0)); assert_eq!(closed.actual_signal, None);
            assert_ne!(closed.kernel, KernelObservation::Absent);
        }
        let mut foreign = identity.clone(); foreign.id.push(9);
        assert_eq!(KernelObservation::classify(&MountState::Mounted(foreign), &owner, &binding), KernelObservation::Unknown);
        assert_eq!(KernelObservation::classify(&MountState::Absent, &owner, &binding), KernelObservation::Absent);
        clean_fixture_runtime(&control);
    }

    #[tokio::test]
    async fn closed_pending_snapshot_survives_deadline_and_later_ipc_loss() {
        for unknown in [false, true] {
            for lose_ipc in [false, true] {
                let fixture = Fixture::new();
                let control = Arc::new(RuntimeControl::acquire(&fixture.session, &fixture.target).unwrap());
                let identity = fixture.identity(); control.bind_identity(&identity).unwrap();
                let state = Arc::new(Mutex::new(State { binding: Some(Binding::from_mount(&identity)), child: None }));
                let table = if unknown { MountState::Unknown("fixture".into()) } else { MountState::Mounted(identity.clone()) };
                // Establish a genuine completed owned child, never a fabricated PID/status.
                let child = actual_exit(0); let pid = child.child.id(); state.lock().unwrap().child = Some(child);
                let owner = control.verify_owned().unwrap();
                let server = if lose_ipc {
                    let listener = UnixListener::from_std(control.listener.try_clone().unwrap()).unwrap();
                    let owned = owner.clone(); let observed = state.clone();
                    let kernel = if unknown { KernelObservation::Unknown } else { KernelObservation::Mounted };
                    tokio::spawn(async move {
                        let (mut stream, _) = tokio::time::timeout(IO_BUDGET, listener.accept()).await??;
                        peer_uid(&stream)?;
                        let request: Request = read_frame(&mut stream, IO_BUDGET).await?;
                        match request {
                            Request::Unmount { nonce, target } if nonce == owned.nonce && target == owned.target => {},
                            _ => anyhow::bail!("test request binding mismatch"),
                        }
                        let reply = {
                            let guard = observed.lock().unwrap();
                            PendingSnapshot::from_child(owned.nonce.clone(), guard.child.as_ref().unwrap(), kernel).reply()
                        };
                        // The complete frame is flushed on this connected stream before
                        // removing the listener pathname. Existing buffered bytes survive.
                        write_frame(&mut stream, &reply, IO_BUDGET).await?;
                        remove_socket_resources(&owned)?;
                        Ok::<(), anyhow::Error>(())
                    })
                } else {
                    tokio::spawn(control.clone().serve_with_observer(state.clone(), Arc::new(move || table.clone()),
                        Arc::new(|| anyhow::bail!("must not respawn completed owned child")), IO_BUDGET))
                };
                let error = unmount_with_observer(&fixture.session, &fixture.target, Duration::from_millis(200),
                    || MountState::Unknown("fixture".into())).await.unwrap_err();
                assert!(error.downcast_ref::<PendingUnmount>().is_some());
                let text = error.to_string();
                assert!(text.contains(&format!("pid={pid}"))); assert!(text.contains("last_known_actual_wait=true"));
                assert!(text.contains("last_known_actual_exit=Some(0)")); assert!(text.contains("last_known_actual_signal=None"));
                assert!(text.contains(if unknown { "last_known_kernel=Unknown" } else { "last_known_kernel=Mounted" }));
                if !lose_ipc { assert!(!server.is_finished()); }
                let recorded = read_owner(&control.directory).unwrap();
                assert_eq!(recorded.record, owner.record); assert_eq!(recorded.nonce, owner.nonce);
                assert_eq!(recorded.binding, owner.binding); assert!(recorded.closed.is_none());
                assert_eq!(state.lock().unwrap().child.as_ref().unwrap().child.id(), pid);
                if lose_ipc { server.await.unwrap().unwrap(); }
                else { server.abort(); assert!(server.await.unwrap_err().is_cancelled()); }
                if !lose_ipc { remove_socket_resources(&owner).unwrap(); }
                fs::remove_file(control.directory.join(RECORD)).unwrap();
            }
        }
    }

}
