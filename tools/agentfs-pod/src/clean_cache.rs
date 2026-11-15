//! Persistent bounded REMOTE clean-body cache (original MVP contract).
//!
//! One cache instance is bound to a CANONICAL Pod root + identity, exactly like
//! the session overlay. It stores ONLY clean, read-only remote body windows
//! keyed by `(path, strong-ETag, offset, length)`; dirty/baseline overlay state
//! is never stored or evicted here. Loopback-canonical (Local) mounts create no
//! cache directory and cache nothing.
//!
//! Contract (authoritative):
//! - REMOTE default enabled, internal MVP budget 64 MiB, no user configuration.
//! - Persistent across restarts; a restart may serve a hit only AFTER a live
//!   HEAD permission/version revalidation.
//! - Strong ETag only; a weak/missing ETag bypasses the cache (fresh GET).
//! - Reuse the canonical Pod + identity binding; different Pod/identity never
//!   share entries.
//! - Eviction is clean-only, bounded by total bytes and entry count, LRU.
//! - Loopback-canonical (Local) mounts: no clean directory, no copies.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::ops::{Deref, DerefMut};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// Internal MVP budget: 64 MiB total clean-body bytes. Not user-configurable.
pub const CLEAN_CACHE_BUDGET_BYTES: u64 = 64 * 1024 * 1024;
/// Upper bound on the number of cached windows, so tiny windows cannot exhaust
/// the inode budget.
pub const CLEAN_CACHE_MAX_ENTRIES: usize = 4096;

/// A strong HTTP entity tag: a quoted value that is NOT a weak validator.
pub fn is_strong_etag(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') && !trimmed.starts_with("W/")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    path: String,
    etag: String,
    offset: u64,
    length: u64,
    /// Monotone LRU tick of the last access.
    last_used: u64,
    /// Relative blob file name inside the cache directory.
    blob: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheIndex {
    #[serde(default)]
    pod_root: String,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    used_bytes: u64,
    #[serde(default)]
    next_tick: u64,
    #[serde(default)]
    entries: BTreeMap<String, CacheEntry>,
}

/// Stable key string for `(path, etag, offset, length)`.
fn key_for(path: &str, etag: &str, offset: u64, length: u64) -> String {
    format!("{path}\u{1f}{etag}\u{1f}{offset}\u{1f}{length}")
}

/// Parses the tick out of a `blob-<tick>` / `blob-<tick>.tmp` file name.
fn tick_from_blob(name: &str) -> Option<u64> {
    let rest = name.strip_prefix("blob-")?;
    let digits = rest.strip_suffix(".tmp").unwrap_or(rest);
    if digits.len() != 16 { return None; }
    digits.parse::<u64>().ok()
}

/// True when the canonical Pod authority is loopback (Local): no cache at all.
pub fn is_loopback_authority(pod_root: &str) -> bool {
    let Ok(url) = url::Url::parse(pod_root) else { return false; };
    matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1"))
}

pub struct CleanBodyCache {
    dir: PathBuf,
    pod_root: String,
    identity: String,
    /// In-process cache of the authoritative index. Snapshots are discarded and
    /// reloaded from `index.json` under the cross-process flock on every
    /// transaction, exactly like `SessionOverlay`, so a mount and a commit in
    /// separate processes can interleave without mixing bodies or budgets.
    state: Mutex<CacheIndex>,
}

/// A held clean-index transaction: the in-process mutex, the reloaded
/// authoritative index, and the cross-process `flock`. Dropping it releases
/// both locks after the caller has saved.
struct LockedClean<'a> {
    state: MutexGuard<'a, CacheIndex>,
    _file: File,
}
impl Deref for LockedClean<'_> {
    type Target = CacheIndex;
    fn deref(&self) -> &CacheIndex { &self.state }
}
impl DerefMut for LockedClean<'_> {
    fn deref_mut(&mut self) -> &mut CacheIndex { &mut self.state }
}

impl CleanBodyCache {
    /// Opens (and loads) the persistent cache for a canonical Pod + identity.
    /// Returns `None` for a loopback-canonical (Local) authority: no directory,
    /// no copies. A wrong Pod/identity manifest is a hard error, never empty.
    pub fn open(dir: &Path, pod_root: &str, identity: &str) -> Result<Option<Self>> {
        if is_loopback_authority(pod_root) {
            return Ok(None);
        }
        let dir = dir.join("clean-v1");
        fs::create_dir_all(&dir).with_context(|| format!("creating clean cache dir {}", dir.display()))?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        let seed = CacheIndex {
            pod_root: pod_root.to_string(),
            identity: identity.to_string(),
            ..CacheIndex::default()
        };
        let cache = Self { dir, pod_root: pod_root.to_string(), identity: identity.to_string(), state: Mutex::new(seed) };
        {
            // Reloads (and validates) the authoritative index, then GCs orphans
            // left by a killed write inside the same transaction.
            let mut locked = cache.lock_index()?;
            cache.reconcile(&mut locked)?;
        }
        Ok(Some(cache))
    }

    /// Begins a clean-index transaction: takes the in-process mutex, then the
    /// cross-process flock, then reloads the authoritative `index.json`. A
    /// missing index with an empty in-memory state is a fresh, valid cache; a
    /// missing index with existing state is an error rather than a silent reset.
    fn lock_index(&self) -> Result<LockedClean<'_>> {
        let mut state = self.state.lock().map_err(|_| anyhow::anyhow!("clean cache lock poisoned"))?;
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(self.dir.join("clean.lock"))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let index_path = self.dir.join("index.json");
        match fs::read(&index_path) {
            Ok(raw) => {
                let loaded: CacheIndex = serde_json::from_slice(&raw)
                    .with_context(|| format!("parsing {}", index_path.display()))?;
                if loaded.pod_root != self.pod_root || loaded.identity != self.identity {
                    anyhow::bail!("clean cache Pod or identity changed");
                }
                *state = loaded;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && state.entries.is_empty() => {}
            Err(error) => return Err(error.into()),
        }
        Ok(LockedClean { state, _file: file })
    }

    fn save(&self, state: &CacheIndex) -> Result<()> {
        let tmp = self.dir.join("index.json.tmp");
        let mut file = OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        file.write_all(&serde_json::to_vec(state)?)?;
        file.sync_all()?;
        fs::rename(&tmp, self.dir.join("index.json"))?;
        Ok(())
    }

    fn blob_path(&self, blob: &str) -> PathBuf { self.dir.join(blob) }

    /// Removes one index row and its blob, keeping `used_bytes` exact. Every
    /// row retirement goes through here so no path can leak phantom budget.
    fn retire(&self, state: &mut CacheIndex, key: &str) -> Option<CacheEntry> {
        let entry = state.entries.remove(key)?;
        state.used_bytes = state.used_bytes.saturating_sub(entry.length);
        let _ = fs::remove_file(self.blob_path(&entry.blob));
        Some(entry)
    }

    /// Restart reconciliation. A crash between the blob rename and the index
    /// save can leave an orphan blob and a stale `next_tick`; because the blob
    /// write uses `create_new`, a stale tick would fail forever. Drop index rows
    /// whose blob is gone, recompute the byte counter from the survivors, retire
    /// clean-owned orphan `blob-*`/`*.tmp` files, and advance `next_tick` past
    /// every existing name. Only this cache's own `clean-v1` directory is
    /// touched; dirty/baseline blobs and seeds live in the parent directory.
    fn reconcile(&self, state: &mut CacheIndex) -> Result<()> {
        let missing: Vec<String> = state.entries.iter()
            .filter(|(_, entry)| !self.blob_path(&entry.blob).is_file())
            .map(|(key, _)| key.clone())
            .collect();
        for key in missing { self.retire(state, &key); }
        let referenced: BTreeSet<String> = state.entries.values().map(|entry| entry.blob.clone()).collect();
        let mut max_tick = state.next_tick;
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else { continue; };
            if let Some(tick) = tick_from_blob(&name) {
                if tick > max_tick { max_tick = tick; }
            }
            if name.ends_with(".tmp") || (name.starts_with("blob-") && !referenced.contains(&name)) {
                let _ = fs::remove_file(entry.path());
            }
        }
        state.used_bytes = state.entries.values().map(|entry| entry.length).sum();
        if max_tick >= state.next_tick { state.next_tick = max_tick + 1; }
        self.save(state)?;
        Ok(())
    }

    /// Introspection accessor: `(used_bytes, entry_count)`. Used by tests to
    /// assert that weak/missing/truncated responses are never inserted.
    pub fn stats(&self) -> Result<(u64, usize)> {
        let state = self.lock_index()?;
        Ok((state.used_bytes, state.entries.len()))
    }

    /// Serves a cached window when the (strong) ETag matches. The CALLER must
    /// have already revalidated permissions/version with a live HEAD; this only
    /// returns bytes for the exact key.
    pub fn get(&self, path: &str, etag: &str, offset: u64, length: u64) -> Result<Option<Vec<u8>>> {
        if !is_strong_etag(etag) { return Ok(None); }
        let key = key_for(path, etag, offset, length);
        let mut state = self.lock_index()?;
        let Some(entry) = state.entries.get(&key).cloned() else { return Ok(None); };
        let blob = self.blob_path(&entry.blob);
        let bytes = match fs::read(&blob) {
            Ok(bytes) => bytes,
            Err(_) => {
                // Missing blob: retire the stale row and reclaim its budget.
                self.retire(&mut state, &key);
                self.save(&state)?;
                return Ok(None);
            }
        };
        if bytes.len() as u64 != length {
            // Corrupt/partial window: retire the row and reclaim its budget.
            self.retire(&mut state, &key);
            self.save(&state)?;
            return Ok(None);
        }
        // Touch LRU. Advance the tick before borrowing the entry so the mutable
        // borrows of the index and the entry never overlap.
        state.next_tick += 1;
        let tick = state.next_tick;
        if let Some(entry) = state.entries.get_mut(&key) {
            entry.last_used = tick;
        }
        self.save(&state)?;
        Ok(Some(bytes))
    }

    /// Stores a validated clean window. Only called with a STRONG ETag and bytes
    /// whose length matches the requested range. Evicts clean LRU entries only.
    pub fn insert(&self, path: &str, etag: &str, offset: u64, length: u64, bytes: &[u8]) -> Result<()> {
        if !is_strong_etag(etag) { return Ok(()); }
        if bytes.len() as u64 != length { return Ok(()); }
        if length > CLEAN_CACHE_BUDGET_BYTES { return Ok(()); }
        let key = key_for(path, etag, offset, length);
        let mut state = self.lock_index()?;
        if state.entries.contains_key(&key) {
            state.next_tick += 1;
            let tick = state.next_tick;
            if let Some(entry) = state.entries.get_mut(&key) { entry.last_used = tick; }
            self.save(&state)?;
            return Ok(());
        }
        // Atomic blob write, then index.
        state.next_tick += 1;
        let tick = state.next_tick;
        let blob = format!("blob-{tick:016}");
        let tmp = self.dir.join(format!("{blob}.tmp"));
        let write = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&tmp, self.blob_path(&blob))
        })();
        if let Err(error) = write {
            let _ = fs::remove_file(&tmp);
            return Err(error.into());
        }
        state.entries.insert(key, CacheEntry {
            path: path.to_string(), etag: etag.to_string(), offset, length, last_used: tick, blob,
        });
        state.used_bytes += length;
        self.evict_lru(&mut state)?;
        self.save(&state)?;
        Ok(())
    }

    /// Drops every entry for a path (write/delete/version change/permission loss).
    pub fn invalidate_path(&self, path: &str) -> Result<()> {
        let mut state = self.lock_index()?;
        let doomed: Vec<String> = state.entries.iter()
            .filter(|(_, entry)| entry.path == path)
            .map(|(key, _)| key.clone())
            .collect();
        for key in doomed { self.retire(&mut state, &key); }
        self.save(&state)?;
        Ok(())
    }

    /// Drops every entry for `path` whose ETag is not `keep`. Called when a live
    /// HEAD reports the current strong version: stale-version windows for the
    /// same path are discarded without disturbing windows of the live version.
    pub fn retain_path_etag(&self, path: &str, keep: &str) -> Result<()> {
        let mut state = self.lock_index()?;
        let doomed: Vec<String> = state.entries.iter()
            .filter(|(_, entry)| entry.path == path && entry.etag != keep)
            .map(|(key, _)| key.clone())
            .collect();
        for key in doomed { self.retire(&mut state, &key); }
        self.save(&state)?;
        Ok(())
    }

    /// Drops every entry for paths under a Pod-relative directory (rename/delete).
    pub fn invalidate_prefix(&self, prefix: &str) -> Result<()> {
        let mut state = self.lock_index()?;
        let doomed: Vec<String> = state.entries.iter()
            .filter(|(_, entry)| entry.path.starts_with(prefix))
            .map(|(key, _)| key.clone())
            .collect();
        for key in doomed { self.retire(&mut state, &key); }
        self.save(&state)?;
        Ok(())
    }

    fn evict_lru(&self, state: &mut CacheIndex) -> Result<()> {
        while state.used_bytes > CLEAN_CACHE_BUDGET_BYTES || state.entries.len() > CLEAN_CACHE_MAX_ENTRIES {
            let Some(key) = state.entries.iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone()) else { break; };
            self.retire(state, &key);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = PathBuf::from("../../.test-data/agentfs-clean-cache")
                .join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn strong_etag_classification() {
        assert!(is_strong_etag("\"v1\""));
        assert!(!is_strong_etag("W/\"v1\""));
        assert!(!is_strong_etag("v1"));
        assert!(!is_strong_etag(""));
    }

    #[test]
    fn loopback_authority_is_not_cached() {
        assert!(is_loopback_authority("http://127.0.0.1:3000/alice/"));
        assert!(is_loopback_authority("http://localhost:3000/alice/"));
        assert!(!is_loopback_authority("https://node.example/alice/"));
        let dir = TestDir::new();
        assert!(CleanBodyCache::open(&dir.0, "http://127.0.0.1:3000/alice/", "alice").unwrap().is_none());
        assert!(!dir.0.join("clean-v1").exists());
    }

    #[test]
    fn remote_hit_after_reopen_and_weak_etag_bypass() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        {
            let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
            assert!(cache.get("file", "W/\"v1\"", 0, 4).unwrap().is_none());
            cache.insert("file", "W/\"v1\"", 0, 4, b"abcd").unwrap(); // weak: no-op
            assert!(cache.get("file", "W/\"v1\"", 0, 4).unwrap().is_none());
            cache.insert("file", "\"v1\"", 0, 4, b"abcd").unwrap();
        }
        let reopened = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        assert_eq!(reopened.get("file", "\"v1\"", 0, 4).unwrap().unwrap(), b"abcd");
        assert!(reopened.get("file", "\"v2\"", 0, 4).unwrap().is_none());
    }

    #[test]
    fn wrong_identity_is_rejected() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        CleanBodyCache::open(&dir.0, pod, "alice").unwrap();
        assert!(CleanBodyCache::open(&dir.0, pod, "bob").is_err());
        assert!(CleanBodyCache::open(&dir.0, "https://node.example/other/", "alice").is_err());
    }

    #[test]
    fn invalidate_path_drops_windows() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        cache.insert("a.txt", "\"v1\"", 0, 4, b"aaaa").unwrap();
        cache.insert("b.txt", "\"v1\"", 0, 4, b"bbbb").unwrap();
        cache.invalidate_path("a.txt").unwrap();
        assert!(cache.get("a.txt", "\"v1\"", 0, 4).unwrap().is_none());
        assert!(cache.get("b.txt", "\"v1\"", 0, 4).unwrap().is_some());
    }

    #[test]
    fn eviction_is_clean_only_and_bounded() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        // Force many large windows to exceed the budget.
        let chunk = vec![0u8; 4 * 1024 * 1024];
        for i in 0..20u64 {
            cache.insert(&format!("f{i}.bin"), "\"v1\"", 0, chunk.len() as u64, &chunk).unwrap();
        }
        // The index must be within the budget.
        let state = cache.state.lock().unwrap();
        assert!(state.used_bytes <= CLEAN_CACHE_BUDGET_BYTES);
        assert!(state.entries.len() <= CLEAN_CACHE_MAX_ENTRIES);
    }

    #[test]
    fn eviction_bounds_entry_count() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        // Tiny one-byte windows cannot exhaust the byte budget, so the entry cap
        // must bound them.
        for i in 0..(CLEAN_CACHE_MAX_ENTRIES + 64) {
            cache.insert(&format!("f{i}"), "\"v1\"", 0, 1, b"x").unwrap();
        }
        let (used, entries) = cache.stats().unwrap();
        assert!(entries <= CLEAN_CACHE_MAX_ENTRIES, "entries={entries}");
        assert!(used <= CLEAN_CACHE_BUDGET_BYTES);
    }

    #[test]
    fn insert_rejects_wrong_length_and_oversized_windows() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        // Declared length 8 but only 4 bytes transferred: never cached.
        cache.insert("t.bin", "\"v1\"", 0, 8, b"abcd").unwrap();
        assert!(cache.get("t.bin", "\"v1\"", 0, 8).unwrap().is_none());
        assert_eq!(cache.stats().unwrap(), (0, 0));
        // A window larger than the whole budget is never cached.
        cache.insert("big.bin", "\"v1\"", 0, CLEAN_CACHE_BUDGET_BYTES + 1, b"x").unwrap();
        assert_eq!(cache.stats().unwrap(), (0, 0));
    }

    #[test]
    fn retain_path_etag_drops_stale_versions_only() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        cache.insert("f.bin", "\"v1\"", 0, 4, b"old0").unwrap();
        cache.insert("f.bin", "\"v1\"", 4, 4, b"old4").unwrap();
        cache.insert("g.bin", "\"v1\"", 0, 4, b"keep").unwrap();
        cache.retain_path_etag("f.bin", "\"v2\"").unwrap();
        assert!(cache.get("f.bin", "\"v1\"", 0, 4).unwrap().is_none());
        assert!(cache.get("f.bin", "\"v2\"", 0, 4).unwrap().is_none());
        assert!(cache.get("g.bin", "\"v1\"", 0, 4).unwrap().is_some());
        assert_eq!(cache.stats().unwrap(), (4, 1));
    }

    #[test]
    fn invalidate_prefix_drops_a_directory_tree() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        cache.insert("dir/a.txt", "\"v1\"", 0, 4, b"aaaa").unwrap();
        cache.insert("dir/sub/b.txt", "\"v1\"", 0, 4, b"bbbb").unwrap();
        cache.insert("other.txt", "\"v1\"", 0, 4, b"cccc").unwrap();
        cache.invalidate_prefix("dir/").unwrap();
        assert!(cache.get("dir/a.txt", "\"v1\"", 0, 4).unwrap().is_none());
        assert!(cache.get("dir/sub/b.txt", "\"v1\"", 0, 4).unwrap().is_none());
        assert!(cache.get("other.txt", "\"v1\"", 0, 4).unwrap().is_some());
    }

    fn blob_of(cache: &CleanBodyCache, path: &str) -> String {
        let state = cache.state.lock().unwrap();
        state.entries.values().find(|entry| entry.path == path).unwrap().blob.clone()
    }

    #[test]
    fn retired_missing_and_bad_length_rows_reclaim_budget() {
        let dir = TestDir::new();
        let clean = dir.0.join("clean-v1");
        let pod = "https://node.example/alice/";
        let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        cache.insert("f.bin", "\"v1\"", 0, 4, b"aaaa").unwrap();
        cache.insert("g.bin", "\"v1\"", 0, 4, b"bbbb").unwrap();
        assert_eq!(cache.stats().unwrap(), (8, 2));

        // Missing blob: the stale row must be retired and its budget reclaimed.
        let f_blob = blob_of(&cache, "f.bin");
        fs::remove_file(clean.join(&f_blob)).unwrap();
        assert!(cache.get("f.bin", "\"v1\"", 0, 4).unwrap().is_none());
        assert_eq!(cache.stats().unwrap(), (4, 1), "missing blob must reclaim budget");

        // Corrupt/partial blob length: same retirement + budget reclaim.
        cache.insert("k.bin", "\"v1\"", 0, 4, b"dddd").unwrap();
        assert_eq!(cache.stats().unwrap(), (8, 2));
        let k_blob = blob_of(&cache, "k.bin");
        fs::write(clean.join(&k_blob), b"d").unwrap();
        assert!(cache.get("k.bin", "\"v1\"", 0, 4).unwrap().is_none());
        assert_eq!(cache.stats().unwrap(), (4, 1), "bad length must reclaim budget");

        // The freed budget is immediately usable by a later insert.
        cache.insert("h.bin", "\"v1\"", 0, 4, b"cccc").unwrap();
        assert_eq!(cache.stats().unwrap(), (8, 2));
    }

    #[test]
    fn reopen_gc_retires_orphans_and_advances_tick() {
        let dir = TestDir::new();
        let clean = dir.0.join("clean-v1");
        let pod = "https://node.example/alice/";
        {
            let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
            cache.insert("f.bin", "\"v1\"", 0, 4, b"aaaa").unwrap();
        }
        // A kill between the blob rename and the index save leaves an orphan
        // blob, and a killed temp leaves a stale partial file.
        let orphan = clean.join("blob-0000000000009999");
        let tmp = clean.join("blob-0000000000009998.tmp");
        fs::write(&orphan, b"orphan").unwrap();
        fs::write(&tmp, b"partial").unwrap();

        let cache = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        assert!(!orphan.exists(), "orphan blob must be retired");
        assert!(!tmp.exists(), "stale temp must be retired");
        assert_eq!(cache.stats().unwrap(), (4, 1), "surviving row is intact");
        // A later write must not collide with the orphan's tick.
        cache.insert("g.bin", "\"v1\"", 0, 4, b"bbbb").unwrap();
        assert!(clean.join("blob-0000000000010001").exists(), "tick advanced past orphans");
        assert_eq!(cache.stats().unwrap(), (8, 2));
    }

    #[test]
    fn two_instances_same_dir_interleave_without_mixing_or_leaking_budget() {
        let dir = TestDir::new();
        let pod = "https://node.example/alice/";
        let a = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        let b = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        a.insert("a.bin", "\"v1\"", 0, 4, b"aaaa").unwrap();
        b.insert("b.bin", "\"v1\"", 0, 4, b"bbbb").unwrap();
        a.insert("a.bin", "\"v1\"", 4, 4, b"AAAA").unwrap();
        b.insert("b.bin", "\"v1\"", 4, 4, b"BBBB").unwrap();
        // A third instance must see the authoritative union, with no collisions.
        let c = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        assert_eq!(c.get("a.bin", "\"v1\"", 0, 4).unwrap().unwrap(), b"aaaa");
        assert_eq!(c.get("a.bin", "\"v1\"", 4, 4).unwrap().unwrap(), b"AAAA");
        assert_eq!(c.get("b.bin", "\"v1\"", 0, 4).unwrap().unwrap(), b"bbbb");
        assert_eq!(c.get("b.bin", "\"v1\"", 4, 4).unwrap().unwrap(), b"BBBB");
        assert_eq!(c.stats().unwrap(), (16, 4));
        // Reopening again is a no-op: no phantom budget, no lost rows.
        let d = CleanBodyCache::open(&dir.0, pod, "alice").unwrap().unwrap();
        assert_eq!(d.stats().unwrap(), (16, 4));
    }
}
