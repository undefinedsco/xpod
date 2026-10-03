//! Single-authority native session overlay.
//!
//! One overlay is bound to a Pod root + identity and persists, per path:
//! - the immutable first baseline (the version first observed when the path was
//!   first touched, never rebound to a later HEAD);
//! - the latest local revision and its content (as a blob file, so bodies are
//!   never duplicated as whole-file base64);
//! - a delete tombstone and a rename source.
//!
//! All mounted reads/lookups/listings/renames/deletes consult this view first;
//! the Pod is unchanged until an explicit `commit`. `fsync` only guarantees
//! local durability. There is no persistent clean-body read cache: a blob is
//! removed once its revision is committed, and untouched remote content is read
//! from the Pod on demand.

use crate::pod_fs::{CommitFailure, PodClient};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::ops::{Deref, DerefMut};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct OverlayEntry {
    #[serde(default)]
    first_baseline: Option<String>,
    revision: u64,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    blob: Option<String>,
    #[serde(default)]
    rename_from: Option<String>,
    #[serde(default)]
    applied: bool,
    #[serde(default)]
    in_flight: bool,
    #[serde(default)]
    is_dir: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::FixturePod;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = PathBuf::from("../../.test-data/agentfs-session")
                .join(format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    #[test]
    fn first_session_killed_before_edit_reclaims_new_seed() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::ExitStatusExt;
        use std::process::{Command, Stdio};
        let dir = TestDir::new();
        assert!(!dir.0.join("session.json").exists());
        let mut child = OwnedChild(Command::new(std::env::current_exe().unwrap())
            .args(["session::tests::seed_child_entry", "--exact", "--nocapture"])
            .env("AGENTFS_TEST_SEED_CHILD_DIR", fs::canonicalize(&dir.0).unwrap())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap());
        let mut output = BufReader::new(child.0.stdout.take().unwrap());
        let seed = loop {
            let mut line = String::new();
            assert!(output.read_line(&mut line).unwrap() > 0);
            if let Some(index) = line.find("SEED_READY ") {
                break dir.0.join(line[index + "SEED_READY ".len()..].trim());
            }
        };
        let before = fs::read(dir.0.join("session.json")).unwrap();
        let state: State = serde_json::from_slice(&before).unwrap();
        assert_eq!(state.identity, "alice");
        assert!(state.entries.is_empty());
        SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        assert!(seed.exists());
        let pid = child.0.id();
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        println!("owned first-session seed child PID={pid} signal={:?}", status.signal());
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        assert!(!seed.exists());
        assert_eq!(before, fs::read(dir.0.join("session.json")).unwrap());
    }

    #[test]
    fn held_seed_never_overrides_dirty_blob_and_primary_edit_failure() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        let mut lease = overlay.create_seed().unwrap();
        lease.file_mut().write_all(b"unused seed").unwrap();
        overlay.put("remote.txt", b"dirty_source".to_vec(), "text/plain", Some("\"first\"".into())).unwrap();
        overlay.edit("remote.txt", Some(lease.file()), Some("\"later\"".into()), "text/plain", Some(0), b"patch", None).unwrap();
        assert_eq!(overlay.get("remote.txt").unwrap().unwrap().0, b"patch_source");
        assert_eq!(overlay.first_baseline("remote.txt").unwrap(), Some(Some("\"first\"".into())));
        {
            let mut state = overlay.lock_state().unwrap();
            state.entries.get_mut("remote.txt").unwrap().in_flight = true;
            overlay.save(&state).unwrap();
        }
        let path = lease.path().to_owned();
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"FOREIGN").unwrap();
        let primary = overlay.edit("remote.txt", Some(lease.file()), None, "text/plain", None, &[], None).unwrap_err();
        assert!(lease.finish().is_err());
        assert!(primary.to_string().contains("current session state"));
        assert_eq!(fs::read(path).unwrap(), b"FOREIGN");
    }

    #[test]
    fn admission_regression_edit_reads_held_seed_after_path_replacement() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        let mut lease = overlay.create_seed().unwrap();
        lease.file_mut().write_all(b"owned_original").unwrap();
        let path = lease.path().to_owned();
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"FOREIGN_CONTENT").unwrap();
        overlay.edit("remote.txt", Some(lease.file()), Some("\"baseline\"".into()), "text/plain", Some(0), b"patch", None).unwrap();
        assert_eq!(overlay.get("remote.txt").unwrap().unwrap().0, b"patch_original");
        assert!(lease.finish().is_err());
        assert_eq!(fs::read(path).unwrap(), b"FOREIGN_CONTENT");
    }

    #[test]
    fn admission_regression_missing_manifest_never_collects_under_transaction() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        let path = dir.0.join("seed-lease-v1-123-1");
        fs::write(&path, b"unknown owner").unwrap();
        fs::remove_file(dir.0.join("session.json")).unwrap();
        let state = overlay.lock_state().unwrap();
        overlay.collect_seed_leases(&state).unwrap();
        assert!(path.exists(), "actual missing manifest must retain seeds");
    }

    #[test]
    fn lease_gc_preserves_unowned_and_invalid_candidates() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        let lease = overlay.create_seed().unwrap();
        let active = lease.path().to_owned();
        let legacy = dir.0.join("seed-99999999-1");
        fs::write(&legacy, b"legacy").unwrap();
        let foreign = dir.0.join("seed-lease-v1-0-1");
        fs::write(&foreign, b"foreign").unwrap();
        let directory = dir.0.join("seed-lease-v1-123-2");
        fs::create_dir(&directory).unwrap();
        let symlink = dir.0.join("seed-lease-v1-123-3");
        std::os::unix::fs::symlink(fs::canonicalize(&legacy).unwrap(), &symlink).unwrap();
        let hardlink = dir.0.join("seed-lease-v1-123-4");
        fs::hard_link(&legacy, &hardlink).unwrap();
        let orphan = dir.0.join("seed-lease-v1-123-5");
        fs::write(&orphan, b"orphan").unwrap();
        let before = fs::read(dir.0.join("session.json")).unwrap();
        SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        assert!(active.exists());
        assert!(!orphan.exists());
        for path in [&legacy, &foreign, &directory, &symlink, &hardlink] {
            assert!(fs::symlink_metadata(path).is_ok());
        }
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy");
        assert_eq!(before, fs::read(dir.0.join("session.json")).unwrap());
        lease.finish().unwrap();
        assert!(!active.exists());
    }

    #[test]
    fn lease_drop_and_replaced_inode_cleanup_are_safe() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        let lease = overlay.create_seed().unwrap();
        let path = lease.path().to_owned();
        drop(lease);
        assert!(!path.exists());
        let lease = overlay.create_seed().unwrap();
        let path = lease.path().to_owned();
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"replacement").unwrap();
        assert!(lease.finish().is_err());
        assert_eq!(fs::read(path).unwrap(), b"replacement");
    }

    #[test]
    fn seed_gc_requires_existing_valid_manifest_and_readable_owner_proof() {
        let dir = TestDir::new();
        let path = dir.0.join("seed-lease-v1-123-1");
        fs::write(&path, b"unknown owner").unwrap();
        SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        assert!(path.exists(), "new session must not collect preexisting files");
        if unsafe { libc::geteuid() } != 0 {
            fs::set_permissions(&path, fs::Permissions::from_mode(0)).unwrap();
            SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
            assert!(path.exists(), "permission-denied lock proof must retain seed");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    #[test]
    fn wrong_manifest_never_collects_seeds() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        let path = dir.0.join("seed-lease-v1-123-1");
        fs::write(&path, b"orphan").unwrap();
        assert!(SessionOverlay::open(&dir.0, "https://pod.test/other/", "alice").is_err());
        assert!(path.exists());
        fs::write(dir.0.join("session.json"), b"malformed").unwrap();
        assert!(SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").is_err());
        assert!(path.exists());
        drop(overlay);
    }

    #[test]
    fn seed_child_entry() {
        let Some(dir) = std::env::var_os("AGENTFS_TEST_SEED_CHILD_DIR") else { return; };
        let overlay = SessionOverlay::open(Path::new(&dir), "https://pod.test/alice/", "alice").unwrap();
        let mut lease = overlay.create_seed().unwrap();
        lease.file_mut().write_all(b"streamed body").unwrap();
        lease.file_mut().sync_all().unwrap();
        println!("SEED_READY {}", lease.path().file_name().unwrap().to_str().unwrap());
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
        overlay.edit("remote.txt", Some(lease.file()), Some("\"baseline\"".into()), "text/plain", Some(0), b"edited", None).unwrap();
        println!("EDIT_READY");
        std::io::stdout().flush().unwrap();
        line.clear();
        std::io::stdin().read_line(&mut line).unwrap();
        lease.finish().unwrap();
    }

    #[test]
    fn killed_owned_process_releases_only_new_seed_lease() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::ExitStatusExt;
        use std::process::{Command, Stdio};
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        overlay.put("existing.txt", b"dirty".to_vec(), "text/plain", Some("\"first\"".into())).unwrap();
        {
            let mut state = overlay.lock_state().unwrap();
            state.entries.get_mut("existing.txt").unwrap().in_flight = true;
            overlay.save(&state).unwrap();
        }
        let mut child = OwnedChild(Command::new(std::env::current_exe().unwrap())
            .args(["session::tests::seed_child_entry", "--exact", "--nocapture"])
            .env("AGENTFS_TEST_SEED_CHILD_DIR", fs::canonicalize(&dir.0).unwrap())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap());
        let mut output = BufReader::new(child.0.stdout.take().unwrap());
        let read_marker = |output: &mut BufReader<std::process::ChildStdout>, marker: &str| -> String {
            loop {
                let mut line = String::new();
                assert!(output.read_line(&mut line).unwrap() > 0, "child closed before handshake");
                if let Some(index) = line.find(marker) { return line[index + marker.len()..].trim().to_owned(); }
            }
        };
        let name = read_marker(&mut output, "SEED_READY ");
        let seed = dir.0.join(name);
        SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        assert!(seed.exists(), "body-stage live lease must survive");
        child.0.stdin.as_mut().unwrap().write_all(b"edit\n").unwrap();
        read_marker(&mut output, "EDIT_READY");
        SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        assert!(seed.exists(), "post-edit live lease must survive");
        let manifest = fs::read(dir.0.join("session.json")).unwrap();
        let blobs: Vec<_> = overlay.lock_state().unwrap().entries.values()
            .filter_map(|entry| entry.blob.as_ref()).map(|name| (name.clone(), fs::read(dir.0.join(name)).unwrap())).collect();
        let pid = child.0.id();
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        println!("owned post-edit seed child PID={pid} signal={:?}", status.signal());
        assert_eq!(status.signal(), Some(libc::SIGKILL));
        SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        assert!(!seed.exists());
        assert_eq!(manifest, fs::read(dir.0.join("session.json")).unwrap());
        for (name, bytes) in blobs { assert_eq!(bytes, fs::read(dir.0.join(name)).unwrap()); }
    }

    #[test]
    fn independent_session_handles_see_the_same_durable_state() {
        let dir = TestDir::new();
        let mount = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        let commit = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        mount.put("new.txt", b"dirty".to_vec(), "text/plain", None).unwrap();
        assert_eq!(commit.pending_paths().unwrap(), vec!["new.txt"]);
    }

    #[test]
    fn absent_first_baseline_remains_create_only() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        overlay.put("new.txt", b"one".to_vec(), "text/plain", None).unwrap();
        overlay.put("new.txt", b"two".to_vec(), "text/plain", Some("\"other-writer\"".into())).unwrap();
        assert_eq!(overlay.first_baseline("new.txt").unwrap(), Some(None));
    }

    #[test]
    fn missing_blob_never_becomes_an_empty_remote_write() {
        let pod = FixturePod::start(vec![]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("new.txt", b"must survive".to_vec(), "text/plain", None).unwrap();
        fs::remove_file(dir.0.join("blob-0000000000000001")).unwrap();
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        let report = overlay.commit(&client);
        assert!(report.is_err() || !report.unwrap().errors.is_empty());
        assert_eq!(pod.body("new.txt"), None);
        assert!(dir.0.join("session.json").exists());
    }

    #[test]
    fn session_cannot_be_reused_by_another_identity() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        overlay.put("new.txt", vec![], "text/plain", None).unwrap();
        assert!(SessionOverlay::open(&dir.0, "https://pod.test/alice/", "bob").is_err());
    }

    #[test]
    fn failed_rename_destination_never_deletes_the_remote_source() {
        let pod = FixturePod::start(vec![("a.txt".into(), "original".into()), ("z.txt".into(), "target".into())]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("a.txt", b"local".to_vec(), "text/plain", Some("\"v1\"".into())).unwrap();
        overlay.rename("a.txt", "z.txt", Some("\"v1\"".into()), Some("\"v1\"".into())).unwrap();
        pod.mutate("z.txt", "external");
        let report = overlay.commit(&PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap()).unwrap();
        assert!(!report.conflicts.is_empty(), "conflicts={:?} errors={:?}", report.conflicts, report.errors);
        assert_eq!(pod.body("a.txt").as_deref(), Some("original"));
        assert_eq!(pod.body("z.txt").as_deref(), Some("external"));
    }

    #[test]
    fn lost_write_receipt_is_not_blindly_replayed() {
        use std::io::{BufRead, BufReader, Read};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}/pod/", listener.local_addr().unwrap());
        let applied = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let applied_server = applied.clone();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.starts_with("PUT /pod/conflict%2D409%2D412 "), "{line}");
            let mut size = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" { break; }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") { size = value.trim().parse().unwrap(); }
            }
            let mut body = vec![0; size];
            reader.read_exact(&mut body).unwrap();
            assert_eq!(body, b"persisted remotely");
            applied_server.store(true, Ordering::SeqCst);
            // Applying the write then closing without a receipt simulates a
            // real ambiguous outcome, rather than a pre-request network error.
        });
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &root, "alice").unwrap();
        // Error text contains the resource URL. These words/digits are not
        // HTTP response codes and must never classify a transport loss.
        let path = "conflict-409-412";
        overlay.put(path, b"persisted remotely".to_vec(), "text/plain", None).unwrap();
        let client = PodClient::new(&root, None).unwrap();
        let report = overlay.commit(&client).unwrap();
        assert!(!report.errors.is_empty());
        assert!(report.conflicts.is_empty());
        server.join().unwrap();
        assert!(applied.load(Ordering::SeqCst));
        let retry = overlay.commit(&client).unwrap();
        assert!(retry.errors[0].contains("prior request outcome is unknown"));
        assert_eq!(overlay.get(path).unwrap().unwrap().0, b"persisted remotely");
    }

    #[test]
    fn directory_rename_fails_without_retyping_or_orphaning_children() {
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, "https://pod.test/alice/", "alice").unwrap();
        overlay.mkdir("d").unwrap();
        overlay.put("d/a", b"child".to_vec(), "text/plain", None).unwrap();
        assert!(overlay.rename("d", "e", None, None).is_err());
        assert!(overlay.stat("d").unwrap().unwrap().2);
        assert_eq!(overlay.get("d/a").unwrap().unwrap().0, b"child");
        assert!(overlay.stat("e").unwrap().is_none());
    }

    #[test]
    fn creating_an_existing_remote_file_never_upgrades_to_overwrite() {
        use agentfs_sdk::FileSystem;
        let pod = FixturePod::start(vec![("race.txt".into(), "external".into())]).unwrap();
        let dir = TestDir::new();
        let overlay = std::sync::Arc::new(SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap());
        let fs = crate::pod_fs::PodHttpFileSystem::new(&pod.pod_root, Some("selftest-token".into()), 0, 0, Some(overlay.clone())).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(runtime.block_on(fs.create_file(crate::pod_fs::ROOT_INO, "race.txt", 0o644, 0, 0)).is_err());
        assert!(overlay.pending_paths().unwrap().is_empty());
        assert_eq!(pod.body("race.txt").as_deref(), Some("external"));
    }

    fn mark_in_flight(overlay: &SessionOverlay, path: &str) {
        let mut state = overlay.lock_state().unwrap();
        state.entries.get_mut(path).unwrap().in_flight = true;
        overlay.save(&state).unwrap();
    }

    #[test]
    fn recovery_confirms_lost_put_receipt_without_replaying_the_write() {
        let pod = FixturePod::start(vec![]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("new.txt", b"local".to_vec(), "text/plain", None).unwrap();
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        pod.drop_next_mutation_receipt();
        assert!(!overlay.commit(&client).unwrap().errors.is_empty());
        assert_eq!(pod.body("new.txt").as_deref(), Some("local"));
        pod.reset_log();
        let reopened = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        let report = reopened.recover(&client).unwrap();
        assert_eq!(report.confirmed, vec!["new.txt"]);
        assert!(reopened.pending_paths().unwrap().is_empty());
        assert!(pod.log().iter().all(|request| matches!(request.method.as_str(), "HEAD" | "GET")));
        assert!(!dir.0.join("blob-0000000000000001").exists());
    }

    #[test]
    fn recovery_makes_unsent_write_retryable_without_rebinding_its_baseline() {
        let pod = FixturePod::start(vec![("a.txt".into(), "original".into())]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("a.txt", b"local".to_vec(), "text/plain", Some("\"v1\"".into())).unwrap();
        mark_in_flight(&overlay, "a.txt");
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        let report = overlay.recover(&client).unwrap();
        assert_eq!(report.retryable, vec!["a.txt"]);
        assert_eq!(overlay.first_baseline("a.txt").unwrap(), Some(Some("\"v1\"".into())));
        assert_eq!(pod.body("a.txt").as_deref(), Some("original"));
        pod.mutate("a.txt", "external");
        assert_eq!(overlay.commit(&client).unwrap().conflicts, vec!["a.txt"]);
        assert_eq!(overlay.get("a.txt").unwrap().unwrap().0, b"local");
    }

    #[test]
    fn recovery_keeps_changed_remote_content_and_the_local_blob() {
        let pod = FixturePod::start(vec![]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("new.txt", b"local".to_vec(), "text/plain", None).unwrap();
        mark_in_flight(&overlay, "new.txt");
        pod.mutate("new.txt", "other");
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        let report = overlay.recover(&client).unwrap();
        assert_eq!(report.conflicts, vec!["new.txt"]);
        assert_eq!(overlay.get("new.txt").unwrap().unwrap().0, b"local");
        assert!(overlay.lock_state().unwrap().entries["new.txt"].in_flight);
        assert_eq!(pod.body("new.txt").as_deref(), Some("other"));
    }

    #[test]
    fn recovery_confirms_lost_delete_receipt() {
        let pod = FixturePod::start(vec![("a.txt".into(), "original".into())]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.delete("a.txt", Some("\"v1\"".into())).unwrap();
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        pod.drop_next_mutation_receipt();
        assert!(!overlay.commit(&client).unwrap().errors.is_empty());
        let report = overlay.recover(&client).unwrap();
        assert_eq!(report.confirmed, vec!["a.txt"], "report={report:?}; requests={:?}", pod.log());
        assert!(overlay.pending_paths().unwrap().is_empty());
        assert!(pod.body("a.txt").is_none());
    }

    #[test]
    fn recovery_preserves_rename_stages_until_the_source_is_deleted() {
        let pod = FixturePod::start(vec![("a.txt".into(), "original".into())]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("a.txt", b"local".to_vec(), "text/plain", Some("\"v1\"".into())).unwrap();
        overlay.rename("a.txt", "b.txt", Some("\"v1\"".into()), None).unwrap();
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        pod.drop_next_mutation_receipt();
        let report = overlay.commit(&client).unwrap();
        assert!(!report.errors.is_empty(), "applied={} conflicts={:?} errors={:?}; requests={:?}", report.applied, report.conflicts, report.errors, pod.log());
        assert_eq!(pod.body("a.txt").as_deref(), Some("original"));
        assert_eq!(overlay.recover(&client).unwrap().confirmed, vec!["b.txt"]);
        assert!(dir.0.join("blob-0000000000000001").exists());
        pod.reset_log();
        assert!(overlay.commit(&client).unwrap().errors.is_empty());
        assert!(!pod.log().iter().any(|request| request.method == "PUT"));
        assert!(pod.body("a.txt").is_none());
        assert_eq!(pod.body("b.txt").as_deref(), Some("local"));
        assert!(overlay.pending_paths().unwrap().is_empty());
    }

    #[test]
    fn recovery_verifies_all_bytes_and_preserves_missing_local_content() {
        let prefix = "x".repeat(200_000);
        let pod = FixturePod::start(vec![("a.txt".into(), format!("{prefix}remote"))]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("a.txt", format!("{prefix}local").into_bytes(), "text/plain", None).unwrap();
        mark_in_flight(&overlay, "a.txt");
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        assert_eq!(overlay.recover(&client).unwrap().conflicts, vec!["a.txt"]);
        fs::remove_file(dir.0.join("blob-0000000000000001")).unwrap();
        assert!(!overlay.recover(&client).unwrap().errors.is_empty());
        assert_eq!(overlay.pending_paths().unwrap(), vec!["a.txt"]);
    }

    #[test]
    fn recovery_of_an_unsent_create_retains_create_only_conditions() {
        let pod = FixturePod::start(vec![]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("new.txt", b"local".to_vec(), "text/plain", None).unwrap();
        mark_in_flight(&overlay, "new.txt");
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        assert_eq!(overlay.recover(&client).unwrap().retryable, vec!["new.txt"]);
        assert_eq!(overlay.first_baseline("new.txt").unwrap(), Some(None));
        pod.mutate("new.txt", "external");
        assert_eq!(overlay.commit(&client).unwrap().conflicts, vec!["new.txt"]);
        assert_eq!(pod.body("new.txt").as_deref(), Some("external"));
    }

    #[test]
    fn recovery_checks_media_type_and_container_type() {
        let pod = FixturePod::start(vec![("a.txt".into(), "same".into())]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("a.txt", b"same".to_vec(), "application/octet-stream", None).unwrap();
        mark_in_flight(&overlay, "a.txt");
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        assert_eq!(overlay.recover(&client).unwrap().conflicts, vec!["a.txt"]);
        overlay.mkdir("d").unwrap();
        pod.drop_next_mutation_receipt();
        assert!(!overlay.commit(&client).unwrap().errors.is_empty());
        let report = overlay.recover(&client).unwrap();
        assert_eq!(report.confirmed, vec!["d"]);
        assert_eq!(report.conflicts, vec!["a.txt"]);
    }

    #[test]
    fn recovery_never_confirms_a_different_ldp_resource_kind() {
        let pod = FixturePod::start(vec![("a.txt".into(), "same".into()), ("d/".into(), "".into())]).unwrap();
        pod.set_resource_link("a.txt", "<http://www.w3.org/ns/ldp#Container>; rel=\"type\"");
        pod.set_resource_link("d/", "<http://www.w3.org/ns/ldp#BasicContainer>; rel=\"describedby\"");
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("a.txt", b"same".to_vec(), "text/plain", None).unwrap();
        overlay.mkdir("d").unwrap();
        mark_in_flight(&overlay, "a.txt");
        mark_in_flight(&overlay, "d");
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        let report = overlay.recover(&client).unwrap();
        assert_eq!(report.conflicts, vec!["a.txt", "d"], "report={report:?}; requests={:?}", pod.log());
        assert!(report.confirmed.is_empty());
        assert_eq!(overlay.pending_paths().unwrap(), vec!["a.txt", "d"]);
    }

    #[test]
    fn recovery_preserves_state_on_weak_etag_version_race_and_interrupted_read() {
        for fault in ["weak", "malformed", "race", "disconnect"] {
            let pod = FixturePod::start(vec![("a.txt".into(), "local".into())]).unwrap();
            let dir = TestDir::new();
            let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
            overlay.put("a.txt", b"local".to_vec(), "text/plain", None).unwrap();
            mark_in_flight(&overlay, "a.txt");
            match fault {
                "weak" => pod.set_etag("a.txt", "W/\"v1\""),
                "malformed" => pod.set_etag("a.txt", "\"v1\", \"v2\""),
                "race" => pod.change_next_get("a.txt", "external"),
                _ => pod.drop_next_read_body(),
            }
            let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
            let report = overlay.recover(&client).unwrap();
            assert!(!report.errors.is_empty(), "{fault}");
            assert!(report.confirmed.is_empty());
            assert!(overlay.lock_state().unwrap().entries["a.txt"].in_flight);
            assert_eq!(overlay.first_baseline("a.txt").unwrap(), Some(None));
            assert_eq!(overlay.get("a.txt").unwrap().unwrap().0, b"local");
        }
    }

    #[test]
    fn recovery_finishes_rename_after_source_delete_receipt_is_lost() {
        let pod = FixturePod::start(vec![("a.txt".into(), "original".into())]).unwrap();
        let dir = TestDir::new();
        let overlay = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        overlay.put("a.txt", b"local".to_vec(), "text/plain", Some("\"v1\"".into())).unwrap();
        overlay.rename("a.txt", "b.txt", Some("\"v1\"".into()), None).unwrap();
        let client = PodClient::new(&pod.pod_root, Some("selftest-token".into())).unwrap();
        pod.drop_next_delete_receipt();
        assert!(!overlay.commit(&client).unwrap().errors.is_empty());
        assert!(pod.body("a.txt").is_none());
        assert_eq!(pod.body("b.txt").as_deref(), Some("local"));
        drop(overlay);
        let restored = SessionOverlay::open(&dir.0, &pod.pod_root, "alice").unwrap();
        pod.reset_log();
        assert_eq!(restored.recover(&client).unwrap().confirmed, vec!["a.txt"]);
        assert!(restored.pending_paths().unwrap().is_empty());
        assert!(restored.commit(&client).unwrap().errors.is_empty());
        assert!(pod.log().iter().all(|request| request.method == "HEAD"));
        assert!(!dir.0.join("blob-0000000000000001").exists());
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    pod_root: String,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    entries: BTreeMap<String, OverlayEntry>,
    #[serde(default)]
    next_revision: u64,
}

const SEED_PREFIX: &str = "seed-lease-v1-";

/// The open file description owns the seed throughout HTTP and local editing.
/// GC only tries its lock, so acquiring a session transaction cannot deadlock.
pub struct SeedLease<'a> {
    overlay: &'a SessionOverlay,
    path: PathBuf,
    file: File,
    finished: bool,
}
impl SeedLease<'_> {
    pub fn file_mut(&mut self) -> &mut File { &mut self.file }
    pub fn file(&self) -> &File { &self.file }
    pub fn path(&self) -> &Path { &self.path }
    pub fn finish(mut self) -> Result<()> {
        let result = self.cleanup();
        self.finished = true;
        result
    }
    fn cleanup(&self) -> Result<()> {
        let _state = self.overlay.lock_state()?;
        remove_matching_seed(&self.path, &self.file)
    }
}
impl Drop for SeedLease<'_> {
    fn drop(&mut self) {
        if !self.finished {
            if let Err(error) = self.cleanup() {
                eprintln!("seed lease cleanup retained {}: {error}", self.path.display());
            }
        }
    }
}

fn seed_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(SEED_PREFIX) else { return false; };
    let Some((pid, nonce)) = rest.split_once('-') else { return false; };
    !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit())
        && pid.parse::<u32>().map(|pid| pid > 0).unwrap_or(false)
        && !nonce.is_empty() && nonce.bytes().all(|b| b.is_ascii_digit())
        && nonce.parse::<u128>().is_ok()
}

fn matching_seed(path: &Path, file: &File) -> Result<bool> {
    let path_meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let file_meta = file.metadata()?;
    Ok(path_meta.is_file() && file_meta.is_file() && path_meta.nlink() == 1
        && file_meta.nlink() == 1 && path_meta.dev() == file_meta.dev()
        && path_meta.ino() == file_meta.ino())
}

fn remove_matching_seed(path: &Path, file: &File) -> Result<()> {
    if !matching_seed(path, file)? {
        anyhow::bail!("seed identity changed; retaining {}", path.display());
    }
    fs::remove_file(path).context("removing leased seed")
}

pub struct SessionOverlay {
    dir: PathBuf,
    state: Mutex<State>,
}

// flock coordinates separate helper processes; the Mutex also serializes
// threads in this process. Every transaction reloads the authoritative file.
struct LockedState<'a> {
    state: MutexGuard<'a, State>,
    _file: File,
    manifest_loaded: bool,
}
impl Deref for LockedState<'_> {
    type Target = State;
    fn deref(&self) -> &State { &self.state }
}
impl DerefMut for LockedState<'_> {
    fn deref_mut(&mut self) -> &mut State { &mut self.state }
}

pub struct CommitReport {
    pub applied: usize,
    pub conflicts: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct RecoveryReport {
    pub confirmed: Vec<String>,
    pub retryable: Vec<String>,
    pub conflicts: Vec<String>,
    pub errors: Vec<String>,
}

enum RecoveryDisposition { Confirmed, Retryable, Conflict }

impl SessionOverlay {
    /// Opens (and loads) the overlay for a Pod root + identity. Parsing failure
    /// is an error, never an empty state.
    pub fn open(dir: &Path, pod_root: &str, identity: &str) -> Result<Self> {
        fs::create_dir_all(dir).with_context(|| format!("creating session dir {}", dir.display()))?;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        let state_path = dir.join("session.json");
        let state = if state_path.exists() {
            let raw = fs::read_to_string(&state_path)
                .with_context(|| format!("reading {}", state_path.display()))?;
            let parsed: State = serde_json::from_str(&raw)
                .with_context(|| format!("parsing {}", state_path.display()))?;
            if parsed.pod_root != pod_root || parsed.identity != identity {
                anyhow::bail!(
                    "session overlay belongs to a different Pod or identity ({} != {})",
                    parsed.pod_root,
                    pod_root
                );
            }
            parsed
        } else {
            State { pod_root: pod_root.to_string(), identity: identity.to_string(), ..State::default() }
        };
        let overlay = Self { dir: dir.to_path_buf(), state: Mutex::new(state) };
        let locked = overlay.lock_state()?;
        overlay.collect_seed_leases(&locked)?;
        overlay.save(&locked)?;
        drop(locked);
        Ok(overlay)
    }

    fn lock_state(&self) -> Result<LockedState<'_>> {
        let mut state = self.state.lock().map_err(|_| anyhow::anyhow!("session lock poisoned"))?;
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(self.dir.join("session.lock"))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let manifest = self.dir.join("session.json");
        let manifest_loaded = match fs::read(&manifest) {
            Ok(raw) => {
                let loaded: State = serde_json::from_slice(&raw).context("parsing session manifest")?;
                if loaded.pod_root != state.pod_root || loaded.identity != state.identity {
                    anyhow::bail!("session Pod or identity changed");
                }
                for (path, entry) in &loaded.entries {
                    if path.is_empty() || path.starts_with('/') || path.split('/').any(|part| part == ".." || part == ".") {
                        anyhow::bail!("invalid session path");
                    }
                    if entry.revision == 0 || entry.revision > loaded.next_revision {
                        anyhow::bail!("invalid session revision");
                    }
                    if let Some(blob) = &entry.blob {
                        if !blob.starts_with("blob-") || blob.len() != 21 || !blob[5..].bytes().all(|b| b.is_ascii_hexdigit()) {
                            anyhow::bail!("invalid session blob reference");
                        }
                    }
                    if !entry.deleted && entry.blob.is_none() {
                        anyhow::bail!("session entry has no content blob");
                    }
                }
                *state = loaded;
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && state.entries.is_empty() => false,
            Err(error) => return Err(error.into()),
        };
        Ok(LockedState { state, _file: file, manifest_loaded })
    }

    pub fn create_seed(&self) -> Result<SeedLease<'_>> {
        let state = self.lock_state()?;
        // Persist the validated identity before creating any owned seed, even
        // if an external actor removed an otherwise empty manifest.
        if !state.manifest_loaded { self.save(&state)?; }
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
        let path = self.dir.join(format!("{SEED_PREFIX}{}-{nonce}", std::process::id()));
        let file = OpenOptions::new().read(true).write(true).create_new(true)
            .mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&path)?;
        if !matching_seed(&path, &file)? {
            anyhow::bail!("created seed identity changed; retaining {}", path.display());
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(SeedLease { overlay: self, path, file, finished: false })
    }

    // Called under a validated session transaction. Legacy PID names provide
    // no owner proof across hosts/PID namespaces and are always retained.
    fn collect_seed_leases(&self, state: &LockedState<'_>) -> Result<()> {
        if !state.manifest_loaded { return Ok(()); }
        for entry in fs::read_dir(&self.dir)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => { eprintln!("seed scan retained unknown entry: {error}"); continue; },
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue; };
            if !seed_name(name) {
                if name.starts_with("seed-") { eprintln!("retaining unowned legacy/foreign seed {name}"); }
                continue;
            }
            let result = (|| -> Result<()> {
                let meta = fs::symlink_metadata(entry.path())?;
                if !meta.is_file() || meta.nlink() != 1 { anyhow::bail!("not a single-link regular seed"); }
                let file = OpenOptions::new().read(true).write(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(entry.path())?;
                if !matching_seed(&entry.path(), &file)? { anyhow::bail!("seed identity changed"); }
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                remove_matching_seed(&entry.path(), &file)
            })();
            if let Err(error) = result { eprintln!("retaining seed {name}: {error}"); }
        }
        Ok(())
    }

    fn blob_path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn save(&self, state: &State) -> Result<()> {
        let tmp = self.dir.join("session.json.tmp");
        let mut file = File::create(&tmp).context("creating session temp")?;
        file.write_all(serde_json::to_string(state)?.as_bytes())?;
        file.sync_all().context("fsync session temp")?;
        fs::rename(&tmp, self.dir.join("session.json")).context("renaming session temp")?;
        File::open(&self.dir)?.sync_all().context("fsync session directory")?;
        Ok(())
    }

    fn write_blob(&self, revision: u64, data: &[u8]) -> Result<String> {
        let name = format!("blob-{revision:016x}");
        let tmp = self.blob_path(&format!("{name}.tmp"));
        let mut file = File::create(&tmp).context("creating blob")?;
        file.write_all(data)?;
        file.sync_all().context("fsync blob")?;
        fs::rename(&tmp, self.blob_path(&name)).context("renaming blob")?;
        Ok(name)
    }

    pub fn put(&self, path: &str, data: Vec<u8>, content_type: &str, fallback_baseline: Option<String>) -> Result<u64> {
        self.put_kind(path, data, content_type, fallback_baseline, false)
    }

    pub fn mkdir(&self, path: &str) -> Result<u64> {
        self.put_kind(path, vec![], "text/turtle", None, true)
    }

    fn put_kind(&self, path: &str, data: Vec<u8>, content_type: &str, fallback_baseline: Option<String>, is_dir: bool) -> Result<u64> {
        let mut state = self.lock_state()?;
        let revision = state.next_revision.checked_add(1).context("session revision overflow")?;
        let blob = self.write_blob(revision, &data)?;
        let previous = state.entries.get(path).cloned();
        if previous.as_ref().is_some_and(|entry| entry.applied || entry.in_flight) {
            anyhow::bail!("path needs commit recovery before further edits");
        }
        let first_baseline = previous.as_ref().map(|entry| entry.first_baseline.clone()).unwrap_or(fallback_baseline);
        state.entries.insert(
            path.to_string(),
            OverlayEntry {
                first_baseline,
                revision,
                deleted: false,
                content_type: content_type.to_string(),
                blob: Some(blob),
                rename_from: previous.and_then(|entry| entry.rename_from),
                applied: false,
                in_flight: false,
                is_dir,
            },
        );
        state.next_revision = revision;
        self.save(&state)?;
        Ok(revision)
    }

    pub fn delete(&self, path: &str, fallback_baseline: Option<String>) -> Result<()> {
        self.delete_kind(path, fallback_baseline, false)
    }

    pub fn delete_directory(&self, path: &str, fallback_baseline: Option<String>) -> Result<()> {
        self.delete_kind(path, fallback_baseline, true)
    }

    fn delete_kind(&self, path: &str, fallback_baseline: Option<String>, is_dir: bool) -> Result<()> {
        let mut state = self.lock_state()?;
        let revision = state.next_revision.checked_add(1).context("session revision overflow")?;
        let previous = state.entries.get(path).cloned();
        if previous.as_ref().is_some_and(|entry| entry.applied || entry.in_flight || entry.rename_from.is_some()) {
            anyhow::bail!("path needs rename/commit recovery before deletion");
        }
        let baseline = previous.as_ref().map(|entry| entry.first_baseline.clone()).unwrap_or(fallback_baseline);
        if baseline.is_none() {
            if previous.is_none() { anyhow::bail!("delete has no observed remote version"); }
            state.entries.remove(path);
            self.save(&state)?;
            return Ok(());
        }
        let previous = previous.unwrap_or_default();
        state.entries.insert(
            path.to_string(),
            OverlayEntry {
                first_baseline: baseline,
                revision,
                deleted: true,
                content_type: previous.content_type,
                blob: None,
                rename_from: previous.rename_from,
                applied: false,
                in_flight: false,
                is_dir: previous.is_dir || is_dir,
            },
        );
        state.next_revision = revision;
        self.save(&state)?;
        Ok(())
    }

    pub fn rename(&self, from: &str, to: &str, from_baseline: Option<String>, to_baseline: Option<String>) -> Result<()> {
        if from == to { return Ok(()); }
        let mut state = self.lock_state()?;
        let source = state.entries.get(from).cloned().context("rename source has no overlay content")?;
        let target = state.entries.get(to).cloned();
        if source.deleted || source.applied || source.in_flight || source.is_dir || source.rename_from.is_some()
            || target.as_ref().is_some_and(|entry| entry.applied || entry.in_flight || entry.is_dir || entry.rename_from.is_some()) {
            anyhow::bail!("rename conflicts with an unfinished operation");
        }
        let blob = source.blob.clone().context("rename source has no blob")?;
        fs::metadata(self.blob_path(&blob)).context("rename source blob unavailable")?;
        let baseline = source.first_baseline.clone();
        let _ = from_baseline; // The source's first observation is authoritative.
        state.next_revision = state.next_revision.checked_add(1).context("session revision overflow")?;
        let revision = state.next_revision;
        state.entries.insert(to.into(), OverlayEntry {
            first_baseline: target.map(|entry| entry.first_baseline).unwrap_or(to_baseline),
            revision, blob: Some(blob), content_type: source.content_type,
            rename_from: baseline.as_ref().map(|_| from.into()),
            ..OverlayEntry::default()
        });
        if baseline.is_some() {
            state.entries.insert(from.into(), OverlayEntry { first_baseline: baseline, revision, deleted: true, ..OverlayEntry::default() });
        } else {
            state.entries.remove(from);
        }
        self.save(&state)
    }

    pub fn get(&self, path: &str) -> Result<Option<(Vec<u8>, String)>> {
        let state = self.lock_state()?;
        let Some(entry) = state.entries.get(path) else { return Ok(None); };
        if entry.deleted {
            anyhow::bail!("path deleted in session");
        }
        let blob = entry.blob.as_ref().context("dirty entry has no blob")?;
        let data = fs::read(self.blob_path(blob)).context("reading dirty blob")?;
        Ok(Some((data, entry.content_type.clone())))
    }

    pub fn stat(&self, path: &str) -> Result<Option<(u64, String, bool)>> {
        let state = self.lock_state()?;
        let Some(entry) = state.entries.get(path) else { return Ok(None); };
        if entry.deleted {
            return Ok(None);
        }
        let blob = entry.blob.as_ref().context("dirty entry has no blob")?;
        let size = fs::metadata(self.blob_path(blob)).context("reading dirty metadata")?.len();
        Ok(Some((size, entry.content_type.clone(), entry.is_dir)))
    }

    pub fn read_range(&self, path: &str, offset: u64, size: u64) -> Result<Option<Vec<u8>>> {
        let state = self.lock_state()?;
        let Some(entry) = state.entries.get(path) else { return Ok(None); };
        if entry.deleted { anyhow::bail!("path deleted in session"); }
        let blob = entry.blob.as_ref().context("dirty entry has no blob")?;
        let mut file = File::open(self.blob_path(blob)).context("opening dirty blob")?;
        file.seek(SeekFrom::Start(offset))?;
        // Bound local reads to the same requested window as HTTP Range reads.
        let mut data = Vec::new();
        file.take(size).read_to_end(&mut data)?;
        Ok(Some(data))
    }

    /// Stage a new revision using bounded file copying, then publish it once
    /// content and metadata are durable. `seed` is a conditionally read lower
    /// snapshot and is ignored when another writer already copied the path up.
    pub fn edit(&self, path: &str, seed: Option<&File>, baseline: Option<String>, content_type: &str,
        offset: Option<u64>, data: &[u8], truncate: Option<u64>) -> Result<()> {
        let mut state = self.lock_state()?;
        let previous = state.entries.get(path).cloned();
        if previous.as_ref().is_some_and(|entry| entry.deleted || entry.applied || entry.in_flight || entry.is_dir) {
            anyhow::bail!("path cannot be edited in its current session state");
        }
        if previous.is_none() && seed.is_none() && truncate != Some(0) {
            anyhow::bail!("lower snapshot is required for a clean path; retry the edit");
        }
        let revision = state.next_revision.checked_add(1).context("session revision overflow")?;
        let name = format!("blob-{revision:016x}");
        let tmp = self.blob_path(&format!("{name}.tmp"));
        let mut output = File::create(&tmp)?;
        let source = previous.as_ref().and_then(|entry| entry.blob.as_ref()).map(|blob| self.blob_path(blob));
        if let Some(source) = source {
            std::io::copy(&mut File::open(source)?, &mut output)?;
        } else if let Some(seed) = seed {
            // HTTP is complete before edit. A cloned descriptor shares its
            // offset, so rewind it here; never reopen a replaceable pathname.
            let mut input = seed.try_clone()?;
            input.seek(SeekFrom::Start(0))?;
            std::io::copy(&mut input, &mut output)?;
        }
        if let Some(size) = truncate { output.set_len(size)?; }
        if let Some(offset) = offset {
            output.seek(SeekFrom::Start(offset))?;
            output.write_all(data)?;
        }
        output.sync_all()?;
        fs::rename(tmp, self.blob_path(&name))?;
        let first_baseline = previous.as_ref().map(|entry| entry.first_baseline.clone()).unwrap_or(baseline);
        state.entries.insert(path.into(), OverlayEntry {
            first_baseline, revision, blob: Some(name), content_type: content_type.into(),
            rename_from: previous.and_then(|entry| entry.rename_from), ..OverlayEntry::default()
        });
        state.next_revision = revision;
        self.save(&state)
    }

    pub fn is_deleted(&self, path: &str) -> Result<bool> {
        Ok(self.lock_state()?.entries.get(path).map(|entry| entry.deleted).unwrap_or(false))
    }

    pub fn first_baseline(&self, path: &str) -> Result<Option<Option<String>>> {
        Ok(self.lock_state()?.entries.get(path).map(|entry| entry.first_baseline.clone()))
    }

    pub fn entry_paths(&self) -> Result<Vec<(String, bool)>> {
        Ok(self.lock_state()?
            .entries
            .iter()
            .map(|(path, entry)| (path.clone(), entry.deleted))
            .collect())
    }

    pub fn pending_paths(&self) -> Result<Vec<String>> {
        Ok(self.lock_state()?.entries.keys().cloned().collect())
    }

    /// Flushes local durability; this never contacts the Pod.
    pub fn fsync(&self) -> Result<()> {
        let state = self.lock_state()?;
        self.save(&state)
    }

    /// Applies every pending entry to the Pod conditionally. An entry is only
    /// cleared when it was committed AND its revision was not replaced by a
    /// concurrent local edit while the request was in flight.
    pub fn commit(&self, client: &PodClient) -> Result<CommitReport> {
        // The MVP serializes local edits with commit, across processes. Readers
        // and writers reload when the lock is released; no stale snapshot can
        // resurrect committed entries or erase a later edit.
        let mut state = self.lock_state()?;
        let mut entries: Vec<_> = state.entries.iter().map(|(path, entry)| (path.clone(), entry.clone())).collect();
        entries.sort_by_key(|(path, entry)| (entry.deleted, if entry.deleted { usize::MAX - path.matches('/').count() } else { path.matches('/').count() }));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let mut report = CommitReport { applied: 0, conflicts: vec![], errors: vec![] };
        for (path, entry) in entries {
            if entry.in_flight {
                report.errors.push(format!("{path}: prior request outcome is unknown; recovery required"));
                continue;
            }
            if entry.applied { continue; }
            if entry.deleted {
                let blocked = state.entries.values().any(|target| target.rename_from.as_deref() == Some(&path) && !target.applied);
                if blocked { continue; }
            }
            let blob_path = if entry.deleted { None } else {
                let blob = entry.blob.as_ref().context("pending entry has no blob")?;
                let location = self.blob_path(blob);
                File::open(&location).with_context(|| format!("opening pending blob for {path}"))?;
                Some(location)
            };
            state.entries.get_mut(&path).unwrap().in_flight = true;
            self.save(&state)?; // crash before receipt must not blindly replay
            let outcome: Result<Option<String>> = runtime.block_on(async {
                if entry.deleted {
                    if entry.first_baseline.is_none() { anyhow::bail!("delete has no baseline"); }
                    let remote_path = if entry.is_dir { format!("{path}/") } else { path.clone() };
                    client.delete_for_commit(&remote_path, entry.first_baseline.as_deref().unwrap()).await
                        .map(|_| None).map_err(anyhow::Error::new)
                } else {
                    client.put_file(&path, &blob_path.unwrap(), entry.first_baseline.as_deref(), &entry.content_type, entry.is_dir)
                        .await.map_err(anyhow::Error::new)
                }
            });
            match outcome {
                Ok(receipt) => {
                    if !entry.deleted && receipt.is_none() {
                        report.errors.push(format!("{path}: successful PUT has no version receipt; recovery required"));
                        continue;
                    }
                    if entry.rename_from.is_some() {
                        let current = state.entries.get_mut(&path).unwrap();
                        current.applied = true;
                        current.in_flight = false;
                    } else {
                        state.entries.remove(&path);
                    }
                    self.save(&state)?;
                    report.applied += 1;
                }
                Err(error) => {
                    let message = error.to_string();
                    // HTTP rejection is a known non-commit. Transport failure
                    // may be a lost receipt and stays marked for recovery.
                    if matches!(error.downcast_ref::<CommitFailure>(), Some(CommitFailure::Rejected(_) | CommitFailure::Conflict(_))) {
                        state.entries.get_mut(&path).unwrap().in_flight = false;
                        self.save(&state)?;
                    }
                    if matches!(error.downcast_ref::<CommitFailure>(), Some(CommitFailure::Conflict(_))) {
                        report.conflicts.push(path.clone());
                    } else { report.errors.push(format!("{path}: {message}")); }
                }
            }
        }
        self.finish_committed(&mut state)?;
        Ok(report)
    }

    /// Reconcile only ambiguous requests. This never mutates the Pod, refreshes
    /// a first baseline, or clears content based on HEAD of a newer version.
    pub fn recover(&self, client: &PodClient) -> Result<RecoveryReport> {
        let mut state = self.lock_state()?;
        let entries: Vec<_> = state.entries.iter().filter(|(_, entry)| entry.in_flight)
            .map(|(path, entry)| (path.clone(), entry.clone())).collect();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let mut report = RecoveryReport::default();
        for (path, entry) in entries {
            let outcome: Result<RecoveryDisposition> = runtime.block_on(async {
                // Validate before any confirmation, including a retryable HEAD.
                let blob_path = if entry.deleted { None } else {
                    let blob = entry.blob.as_ref().context("pending entry has no blob")?;
                    let location = self.blob_path(blob);
                    File::open(&location).with_context(|| format!("opening pending blob for {path}"))?;
                    Some(location)
                };
                let remote_path = if entry.is_dir { format!("{path}/") } else { path.clone() };
                let Some(remote) = client.head(&remote_path).await? else {
                    return Ok(if entry.deleted { RecoveryDisposition::Confirmed }
                        else if entry.first_baseline.is_none() { RecoveryDisposition::Retryable }
                        else { RecoveryDisposition::Conflict });
                };
                let version = remote.version.as_deref().context("recovery requires a remote ETag")?;
                let tag = version.as_bytes();
                if tag.len() < 2 || tag[0] != b'"' || tag[tag.len() - 1] != b'"' ||
                    !tag[1..tag.len() - 1].iter().all(|byte| *byte == 0x21 || (0x23..=0x7e).contains(byte) || *byte >= 0x80) {
                    anyhow::bail!("recovery requires a strong remote ETag");
                }
                if entry.first_baseline.as_deref() == Some(version) {
                    return Ok(RecoveryDisposition::Retryable);
                }
                if entry.deleted { return Ok(RecoveryDisposition::Conflict); }
                let matches = if entry.is_dir {
                    client.matches_container(&remote_path, version).await?
                } else {
                    client.matches_file(&path, version, &blob_path.unwrap(), &entry.content_type).await?
                };
                Ok(if matches { RecoveryDisposition::Confirmed } else { RecoveryDisposition::Conflict })
            });
            match outcome {
                Ok(RecoveryDisposition::Confirmed) => {
                    if entry.rename_from.is_some() {
                        let current = state.entries.get_mut(&path).unwrap();
                        current.applied = true;
                        current.in_flight = false;
                    } else { state.entries.remove(&path); }
                    self.save(&state)?;
                    report.confirmed.push(path);
                }
                Ok(RecoveryDisposition::Retryable) => {
                    state.entries.get_mut(&path).unwrap().in_flight = false;
                    self.save(&state)?;
                    report.retryable.push(path);
                }
                Ok(RecoveryDisposition::Conflict) => report.conflicts.push(path),
                Err(error) => {
                    report.errors.push(format!("{path}: {error}"));
                },
            }
        }
        self.finish_committed(&mut state)?;
        Ok(report)
    }

    fn finish_committed(&self, state: &mut State) -> Result<()> {
        let finished: Vec<_> = state.entries.iter().filter_map(|(path, entry)| {
            (entry.applied && entry.rename_from.as_ref().is_some_and(|from| !state.entries.contains_key(from))).then(|| path.clone())
        }).collect();
        for path in finished { state.entries.remove(&path); }
        self.save(&state)?;
        // Only after the manifest no longer references a blob may it be freed.
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("blob-") && !state.entries.values().any(|value| value.blob.as_deref() == Some(&name)) {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}
