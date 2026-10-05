//! AgentFS `FileSystem`/`File` implementation backed by an Xpod Pod over HTTP.
//!
//! Contracts (aligned with `src/cli/agent-fs/pod-lower.ts`):
//! - `readdir`/`getattr`/`lookup` are metadata only; no file bodies are fetched.
//! - `pread` uses HTTP Range and only transfers the requested slice.
//! - Writes are conditional: create uses `If-None-Match: *`, overwrite/delete
//!   use `If-Match: <ETag>`. Without an ETag we refuse to overwrite instead of
//!   writing unconditionally.
//! - No persistent body cache: read-only handles are served fresh from the Pod,
//!   so external modifications are observed (the mount is also mounted with
//!   `noac,actimeo=0` to defeat the kernel NFS client cache).

use crate::clean_cache::{is_strong_etag, CleanBodyCache};
use crate::session::SessionOverlay;
use agentfs_sdk::error::{Error as SdkError, Result as SdkResult};
use agentfs_sdk::{
    BoxedFile, DirEntry, File, FileSystem, FilesystemStats, FsError, Stats, TimeChange,
    DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, S_IFDIR, S_IFREG,
};
use async_trait::async_trait;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    ETAG, IF_MATCH, IF_NONE_MATCH, LINK, RANGE,
};
use reqwest::{Client, Method, StatusCode};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use url::Url;

enum CopyUpError<'a> {
    Http(&'a reqwest::Error),
    Io(&'a std::io::Error),
}

// A failure-only scalar record. Never format the error, URL, path, headers or
// body here; the unchanged SDK error is still returned to the caller.
fn observe_copy_up_failure(stage: &str, started: &std::time::Instant, received: u64, fully_written: u64, error: CopyUpError<'_>) {
    let cause = match error {
        CopyUpError::Http(error) => serde_json::json!({ "kind": "http", "timeout": error.is_timeout(), "body": error.is_body(), "connect": error.is_connect() }),
        CopyUpError::Io(error) => serde_json::json!({ "kind": "io", "errno": error.raw_os_error(), "ioKind": format!("{:?}", error.kind()) }),
    };
    use std::io::Write;
    let _ = writeln!(std::io::stderr().lock(), "agentfs-pod-copy-up: {}", serde_json::json!({ "stage": stage, "elapsedMs": started.elapsed().as_millis(),
        "bodyBytesReceived": received, "fullyWrittenChunkBytes": fully_written, "cause": cause }));
}

pub const ROOT_INO: i64 = 1;

#[derive(Debug)]
pub enum CommitFailure {
    Conflict(String),
    Rejected(String),
    OutcomeUnknown(String),
}
impl std::fmt::Display for CommitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { Self::Conflict(message) | Self::Rejected(message) | Self::OutcomeUnknown(message) => f.write_str(message) }
    }
}
impl std::error::Error for CommitFailure {}

#[derive(Debug, Clone)]
pub struct HeadInfo {
    pub size: u64,
    pub version: Option<String>,
    pub is_dir: bool,
}

/// One bounded `GET Range` attempt. `ranged` is true only for a real
/// `206`/`Content-Range` response whose offset and length were verified; a
/// `200` (range ignored) attempt must never be cached. `range_ignored` is true
/// only when the server answered `200` and the slice was produced locally, so
/// callers that report `rangeIgnored` keep their exact semantics. A
/// `precondition_failed` marks an `If-Match` mismatch for a single reacquire.
#[derive(Debug)]
pub struct RangeFetch {
    pub bytes: Vec<u8>,
    pub etag: Option<String>,
    pub ranged: bool,
    pub range_ignored: bool,
    pub precondition_failed: bool,
}

// Only an unanchored Link with rel=type describes this resource's LDP kind.
// Split outside quoted strings/URI brackets, so titles and URI delimiters
// cannot manufacture a type relation. Malformed headers cannot be proof.
fn split_link_parts(value: &str, delimiter: char) -> SdkResult<Vec<&str>> {
    let mut parts = Vec::new();
    let (mut start, mut quoted, mut escaped, mut uri) = (0, false, false, false);
    for (index, character) in value.char_indices() {
        if escaped { escaped = false; continue; }
        if quoted && character == '\\' { escaped = true; continue; }
        if !uri && character == '"' { quoted = !quoted; continue; }
        if !quoted {
            if character == '<' {
                if uri { return Err(SdkError::Internal("invalid Link URI".into())); }
                uri = true;
            } else if character == '>' {
                if !uri { return Err(SdkError::Internal("invalid Link URI".into())); }
                uri = false;
            } else if !uri && character == delimiter {
                parts.push(value[start..index].trim());
                start = index + character.len_utf8();
            }
        }
    }
    if quoted || escaped || uri { return Err(SdkError::Internal("unterminated Link value".into())); }
    parts.push(value[start..].trim());
    Ok(parts)
}

/// Parses a concrete `Content-Range: bytes <start>-<end>/<total>` value. A `*`
/// length or any malformed field is not proof and yields `None`. `end >= start`
/// is required here; the caller separately checks offset, total legality, and
/// that the claimed span equals the fully received body.
fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let total: u64 = total.trim().parse().ok()?;
    let (start, end) = range.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end: u64 = end.trim().parse().ok()?;
    (end >= start).then_some((start, end, total))
}

fn ldp_container_type(headers: &HeaderMap) -> SdkResult<bool> {
    let mut container = false;
    for header in headers.get_all(LINK) {
        let header = header.to_str().map_err(|error| SdkError::Internal(error.to_string()))?;
        for link in split_link_parts(header, ',')? {
            if link.is_empty() { continue; }
            let parts = split_link_parts(link, ';')?;
            let target = parts[0].strip_prefix('<').and_then(|value| value.strip_suffix('>'))
                .ok_or_else(|| SdkError::Internal("invalid Link target".into()))?;
            let (mut relation, mut anchored) = (None, false);
            for parameter in &parts[1..] {
                let (name, value) = parameter.split_once('=').unwrap_or((parameter, ""));
                if name.trim().eq_ignore_ascii_case("anchor") { anchored = true; }
                if name.trim().eq_ignore_ascii_case("rel") && relation.is_none() {
                    let value = value.trim();
                    if !value.starts_with('"') && value.chars().any(|character| character.is_ascii_whitespace()) {
                        return Err(SdkError::Internal("unquoted Link relation list".into()));
                    }
                    let value = if value.starts_with('"') {
                        value.strip_prefix('"').and_then(|value| value.strip_suffix('"'))
                            .ok_or_else(|| SdkError::Internal("invalid Link relation".into()))?
                    } else { value };
                    if value.is_empty() || value.contains(['"', '\\']) { return Err(SdkError::Internal("invalid Link relation".into())); }
                    if value.split_ascii_whitespace().any(|token| {
                        let registered = token.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) &&
                            token.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
                        !registered && Url::parse(token).is_err()
                    }) { return Err(SdkError::Internal("invalid Link relation token".into())); }
                    relation = Some(value);
                }
            }
            if !anchored && matches!(target, "http://www.w3.org/ns/ldp#Container" | "http://www.w3.org/ns/ldp#BasicContainer") &&
                relation.is_some_and(|value| value.split_ascii_whitespace().any(|token| token.eq_ignore_ascii_case("type"))) {
                container = true;
            }
        }
    }
    Ok(container)
}

#[cfg(test)]
mod link_type_tests {
    use super::*;

    #[test]
    fn only_current_resource_type_links_are_container_proof() {
        for (link, expected) in [
            ("<http://www.w3.org/ns/ldp#Container>; rel=type", true),
            ("<http://www.w3.org/ns/ldp#BasicContainer>; rel=\"alternate TYPE\"", true),
            ("<http://www.w3.org/ns/ldp#Container>; rel=describedby", false),
            ("<http://www.w3.org/ns/ldp#Container>; rel=type; anchor=\"/other\"", false),
            ("<http://www.w3.org/ns/ldp#Container>; rel=alternate; rel=type", false),
            ("<http://www.w3.org/ns/ldp#Container>; title=\"; rel=type\"; rel=alternate", false),
            ("<http://other.test/a,b;c>; rel=alternate, <http://www.w3.org/ns/ldp#Container>; rel=type", true),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(LINK, HeaderValue::from_str(link).unwrap());
            assert_eq!(ldp_container_type(&headers).unwrap(), expected, "{link}");
        }
        let mut headers = HeaderMap::new();
        headers.insert(LINK, HeaderValue::from_static("<http://www.w3.org/ns/ldp#Container>; rel=\"type"));
        assert!(ldp_container_type(&headers).is_err());
        for malformed in [
            "<http://www.w3.org/ns/ldp#Container>; rel=type alternate",
            "<http://www.w3.org/ns/ldp#Container>; rel=\"type = bogus\"",
        ] {
            headers.insert(LINK, HeaderValue::from_static(malformed));
            assert!(ldp_container_type(&headers).is_err());
        }
    }
}

#[cfg(test)]
mod nfs_pagination_tests {
    use super::*;
    use agentfs::nfs::AgentNFS;
    use agentfs::nfsserve::vfs::NFSFileSystem;
    use crate::fixture::FixturePod;

    #[tokio::test]
    async fn deleted_page_cookie_does_not_hide_remaining_entries() {
        let pod = FixturePod::start(vec![
            ("a.txt".into(), "a".into()), ("b.txt".into(), "b".into()), ("c.txt".into(), "c".into()),
        ]).unwrap();
        let filesystem: Arc<tokio::sync::Mutex<dyn FileSystem>> = Arc::new(tokio::sync::Mutex::new(
            PodHttpFileSystem::new(&pod.pod_root, None, 0, 0, None, None).unwrap(),
        ));
        let nfs = AgentNFS::new(filesystem.clone());
        let mut cookie = 0;
        for index in 0..3 {
            let page = nfs.readdir(nfs.root_dir(), cookie, 1).await.unwrap();
            assert_eq!(page.entries.len(), 1, "remaining entries must not be hidden by a deleted cookie");
            assert_eq!(page.end, index == 2);
            cookie = page.entries[0].fileid;
            let name = std::str::from_utf8(&page.entries[0].name).unwrap();
            filesystem.lock().await.unlink(ROOT_INO, name).await.unwrap();
        }
        assert!(nfs.readdir(nfs.root_dir(), cookie, 1).await.unwrap().end);
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ListEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct ListResponse {
    entries: Vec<ListEntry>,
    #[serde(default)]
    complete: bool,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

/// Shared HTTP transport for the filesystem and its open handles.
pub struct PodClient {
    client: Client,
    base: Url,
    token: Option<String>,
    capability: Option<String>,
}

impl PodClient {
    pub fn new(base: &str, token: Option<String>) -> anyhow::Result<Self> {
        let normalized = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
        Ok(Self {
            client: Client::builder().connect_timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(60)).build()?,
            base: Url::parse(&normalized)?,
            token,
            capability: std::env::var("XPOD_AGENTFS_CAPABILITY").ok().filter(|value| !value.is_empty()),
        })
    }

    fn encode_relative(relative: &str) -> String {
        if relative.is_empty() {
            return String::new();
        }
        relative
            .split('/')
            .map(|segment| utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string())
            .collect::<Vec<_>>()
            .join("/")
    }

    fn resource_url(&self, relative: &str) -> SdkResult<Url> {
        let encoded = Self::encode_relative(relative);
        Url::parse(&format!("{}{}", self.base.as_str(), encoded))
            .map_err(|error| SdkError::Internal(error.to_string()))
    }

    fn list_url(&self, prefix: &str) -> SdkResult<Url> {
        // The sidecar lives at the origin root, not under the Pod container path.
        // Sidecar lives at the origin root. Through the loopback proxy the
        // capability is carried as a header (which the proxy also accepts), so
        // the path itself has no capability prefix.
        let mut url = self
            .base
            .join("/-/agent-directory/list")
            .map_err(|error| SdkError::Internal(error.to_string()))?;
        url.query_pairs_mut().append_pair("root", self.base.as_str());
        if !prefix.is_empty() {
            url.query_pairs_mut().append_pair("pathPrefix", prefix);
        }
        Ok(url)
    }

    async fn send(
        &self,
        method: Method,
        url: Url,
        extra: HeaderMap,
        body: Option<Vec<u8>>,
    ) -> SdkResult<reqwest::Response> {
        let mut request = self.request(method, url, extra);
        if let Some(bytes) = body { request = request.body(bytes); }
        request.send().await.map_err(|error| SdkError::Internal(format!("Pod HTTP request failed: {error}")))
    }

    fn request(&self, method: Method, url: Url, extra: HeaderMap) -> reqwest::RequestBuilder {
        let mut request = self.client.request(method, url).headers(extra);
        if let Some(token) = &self.token {
            request = request.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(capability) = &self.capability {
            request = request.header("x-xpod-agentfs-capability", capability);
        }
        request
    }

    pub async fn copy_to(&self, path: &str, baseline: &str, output: &mut std::fs::File) -> SdkResult<()> {
        use std::io::Write;
        let started = std::time::Instant::now();
        let mut received = 0u64; let mut fully_written = 0u64;
        let mut headers = HeaderMap::new();
        headers.insert(IF_MATCH, HeaderValue::from_str(baseline).map_err(|error| SdkError::Internal(error.to_string()))?);
        let mut response = self.request(Method::GET, self.resource_url(path)?, headers).send().await.map_err(|error| {
            observe_copy_up_failure("send", &started, received, fully_written, CopyUpError::Http(&error));
            SdkError::Internal(format!("Pod HTTP request failed: {error}"))
        })?;
        if response.status() != StatusCode::OK || response.headers().get(ETAG).and_then(|v| v.to_str().ok()) != Some(baseline) {
            return Err(SdkError::Internal("lower content changed during copy-up".into()));
        }
        while let Some(chunk) = response.chunk().await.map_err(|error| {
            observe_copy_up_failure("chunk", &started, received, fully_written, CopyUpError::Http(&error));
            SdkError::Internal(error.to_string())
        })? {
            received += chunk.len() as u64;
            output.write_all(&chunk).map_err(|error| {
                observe_copy_up_failure("write_all", &started, received, fully_written, CopyUpError::Io(&error));
                SdkError::Internal(error.to_string())
            })?;
            fully_written += chunk.len() as u64;
        }
        output.sync_all().map_err(|error| {
            observe_copy_up_failure("sync_all", &started, received, fully_written, CopyUpError::Io(&error));
            SdkError::Internal(error.to_string())
        })
    }

    pub async fn put_file(&self, path: &str, file_path: &std::path::Path, baseline: Option<&str>, content_type: &str, is_dir: bool) -> Result<Option<String>, CommitFailure> {
        use tokio::io::AsyncReadExt;
        let file = tokio::fs::File::open(file_path).await.map_err(|error| CommitFailure::Rejected(error.to_string()))?;
        let size = file.metadata().await.map_err(|error| CommitFailure::Rejected(error.to_string()))?.len();
        let stream = futures_util::stream::try_unfold(file, |mut file| async move {
            let mut chunk = vec![0; 64 * 1024];
            let size = file.read(&mut chunk).await?;
            if size == 0 { return Ok::<_, std::io::Error>(None); }
            chunk.truncate(size);
            Ok(Some((chunk, file)))
        });
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_str(content_type).map_err(|error| CommitFailure::Rejected(error.to_string()))?);
        headers.insert(CONTENT_LENGTH, HeaderValue::from_str(&size.to_string()).unwrap());
        match baseline {
            Some(version) => { headers.insert(IF_MATCH, HeaderValue::from_str(version).map_err(|error| CommitFailure::Rejected(error.to_string()))?); },
            None => { headers.insert(IF_NONE_MATCH, HeaderValue::from_static("*")); },
        }
        if is_dir { headers.insert(LINK, HeaderValue::from_static("<http://www.w3.org/ns/ldp#BasicContainer>; rel=\"type\"")); }
        let remote_path = if is_dir { format!("{path}/") } else { path.into() };
        let url = self.resource_url(&remote_path).map_err(|error| CommitFailure::Rejected(error.to_string()))?;
        let response = self.request(Method::PUT, url, headers)
            .body(reqwest::Body::wrap_stream(stream)).send().await
            .map_err(|error| CommitFailure::OutcomeUnknown(format!("Pod HTTP request failed: {error}")))?;
        Self::check_commit_response(&response, "PUT", path)?;
        Ok(response.headers().get(ETAG).and_then(|value| value.to_str().ok()).map(str::to_string))
    }

    fn check_commit_response(response: &reqwest::Response, method: &str, path: &str) -> Result<(), CommitFailure> {
        let status = response.status();
        if status.is_success() { return Ok(()); }
        let message = format!("{method} {path} failed: {status}");
        if matches!(status.as_u16(), 409 | 412) { return Err(CommitFailure::Conflict(message)); }
        if matches!(status.as_u16(), 400 | 401 | 403 | 404 | 409 | 412 | 415 | 422 | 428 | 429) {
            Err(CommitFailure::Rejected(message))
        } else { Err(CommitFailure::OutcomeUnknown(message)) }
    }

    pub async fn delete_for_commit(&self, path: &str, baseline: &str) -> Result<(), CommitFailure> {
        let mut headers = HeaderMap::new();
        headers.insert(IF_MATCH, HeaderValue::from_str(baseline).map_err(|error| CommitFailure::Rejected(error.to_string()))?);
        let url = self.resource_url(path).map_err(|error| CommitFailure::Rejected(error.to_string()))?;
        let response = self.send(Method::DELETE, url, headers, None).await
            .map_err(|error| CommitFailure::OutcomeUnknown(error.to_string()))?;
        Self::check_commit_response(&response, "DELETE", path)
    }

    /// Read-only recovery proof: compare bytes under the exact observed ETag.
    /// A newer HEAD alone never proves that our earlier mutation was applied.
    pub async fn matches_file(&self, path: &str, version: &str, local: &std::path::Path, content_type: &str) -> SdkResult<bool> {
        let mut headers = HeaderMap::new();
        headers.insert(IF_MATCH, HeaderValue::from_str(version).map_err(|error| SdkError::Internal(error.to_string()))?);
        headers.insert(ACCEPT, HeaderValue::from_str(content_type).map_err(|error| SdkError::Internal(error.to_string()))?);
        let mut response = self.send(Method::GET, self.resource_url(path)?, headers, None).await?;
        if response.status() != StatusCode::OK || response.headers().get(ETAG).and_then(|value| value.to_str().ok()) != Some(version) {
            return Err(SdkError::Internal("remote version changed during recovery read".into()));
        }
        let remote_type = response.headers().get(CONTENT_TYPE).and_then(|value| value.to_str().ok())
            .ok_or_else(|| SdkError::Internal("recovery read has no media type".into()))?;
        if remote_type != content_type { return Ok(false); }
        if ldp_container_type(response.headers())? { return Ok(false); }
        let mut local = std::fs::File::open(local).map_err(|error| SdkError::Internal(error.to_string()))?;
        let mut buffer = vec![0; 64 * 1024];
        while let Some(chunk) = response.chunk().await.map_err(|error| SdkError::Internal(error.to_string()))? {
            for bytes in chunk.chunks(buffer.len()) {
                match std::io::Read::read_exact(&mut local, &mut buffer[..bytes.len()]) {
                    Ok(()) => {},
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(false),
                    Err(error) => return Err(SdkError::Internal(error.to_string())),
                }
                if buffer[..bytes.len()] != *bytes { return Ok(false); }
            }
        }
        std::io::Read::read(&mut local, &mut buffer[..1]).map(|size| size == 0)
            .map_err(|error| SdkError::Internal(error.to_string()))
    }

    pub async fn matches_container(&self, path: &str, version: &str) -> SdkResult<bool> {
        let mut headers = HeaderMap::new();
        headers.insert(IF_MATCH, HeaderValue::from_str(version).map_err(|error| SdkError::Internal(error.to_string()))?);
        let response = self.send(Method::HEAD, self.resource_url(path)?, headers, None).await?;
        if response.status() != StatusCode::OK || response.headers().get(ETAG).and_then(|value| value.to_str().ok()) != Some(version) {
            return Err(SdkError::Internal("remote version changed during container recovery".into()));
        }
        ldp_container_type(response.headers())
    }

    pub async fn head(&self, relative: &str) -> SdkResult<Option<HeadInfo>> {
        let url = self.resource_url(relative)?;
        let response = self.send(Method::HEAD, url, HeaderMap::new(), None).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(SdkError::Internal(format!("HEAD {relative} failed: {}", response.status())));
        }
        let headers = response.headers().clone();
        let size = headers
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let version = headers.get(ETAG).and_then(|value| value.to_str().ok()).map(str::to_string);
        let is_dir = relative.ends_with('/') || ldp_container_type(&headers)?;
        Ok(Some(HeadInfo { size, version, is_dir }))
    }

    pub async fn list(&self, prefix: &str, cursor: Option<&str>) -> SdkResult<ListResponse> {
        let mut url = self.list_url(prefix)?;
        if let Some(cursor) = cursor {
            url.query_pairs_mut().append_pair("cursor", cursor);
        }
        let response = self.send(Method::GET, url, HeaderMap::new(), None).await?;
        if response.status() == StatusCode::UNAUTHORIZED || response.status() == StatusCode::FORBIDDEN {
            return Err(SdkError::Internal(format!("Pod directory listing denied: {}", response.status())));
        }
        if !response.status().is_success() {
            return Err(SdkError::Internal(format!("Pod directory listing failed: {}", response.status())));
        }
        response
            .json()
            .await
            .map_err(|error| SdkError::Internal(format!("Pod directory listing was not JSON: {error}")))
    }

    /// Follows `nextCursor` to completion. A response that claims truncation
    /// without a cursor, or that keeps truncating beyond the page cap, is an
    /// error rather than a silently partial listing.
    pub async fn list_all(&self, prefix: &str) -> SdkResult<Vec<ListEntry>> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0;
        loop {
            let page = self.list(prefix, cursor.as_deref()).await?;
            entries.extend(page.entries);
            match page.next_cursor {
                Some(next) if !next.is_empty() => {
                    cursor = Some(next);
                    pages += 1;
                    if pages > 100 {
                        return Err(SdkError::Internal("Pod directory listing exceeded the page cap".to_string()));
                    }
                }
                _ => {
                    if !page.complete {
                        return Err(SdkError::Internal(
                            "Pod directory listing was incomplete without a continuation cursor".to_string(),
                        ));
                    }
                    return Ok(entries);
                }
            }
        }
    }

    pub async fn get_full(&self, path: &str) -> SdkResult<Vec<u8>> {
        let url = self.resource_url(path)?;
        let response = self.send(Method::GET, url, HeaderMap::new(), None).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Err(SdkError::Fs(FsError::NotFound));
        }
        if !response.status().is_success() {
            return Err(SdkError::Internal(format!("GET {path} failed: {}", response.status())));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| SdkError::Internal(format!("reading {path} body failed: {error}")))?;
        Ok(bytes.to_vec())
    }

    /// Returns `(bytes, rangeIgnored)`. `rangeIgnored` is true when the server
    /// answered 200 and the slice was produced locally.
    pub async fn get_range(&self, path: &str, offset: u64, size: u64) -> SdkResult<(Vec<u8>, bool)> {
        let fetch = self.get_range_conditional(path, offset, size, None).await?;
        Ok((fetch.bytes, fetch.range_ignored))
    }

    /// One bounded `GET Range` attempt, optionally guarded by `If-Match`. The
    /// response is streamed and validated (offset, length, complete body); the
    /// caller caches only a `ranged` result whose ETag equals `if_match`.
    pub async fn get_range_conditional(
        &self,
        path: &str,
        offset: u64,
        size: u64,
        if_match: Option<&str>,
    ) -> SdkResult<RangeFetch> {
        let url = self.resource_url(path)?;
        let mut base = HeaderMap::new();
        base.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        if let Some(value) = if_match {
            base.insert(
                IF_MATCH,
                HeaderValue::from_str(value).map_err(|error| SdkError::Internal(error.to_string()))?,
            );
        }
        let request_range = |base: &HeaderMap, end: u64| {
            let mut headers = base.clone();
            headers.insert(RANGE, HeaderValue::from_str(&format!("bytes={offset}-{end}")).unwrap());
            headers
        };
        let response = self
            .send(Method::GET, url.clone(), request_range(&base, offset.saturating_add(size.saturating_sub(1))), None)
            .await?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(RangeFetch { bytes: Vec::new(), etag: None, ranged: false, range_ignored: false, precondition_failed: true });
        }
        // A strict server answers 416 when the requested end crosses EOF. Only
        // an offset at/after the resource total is a normal EOF; otherwise clamp
        // to the real size and retry under the same precondition.
        let response = if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
            let total_from_header = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("bytes */"))
                .and_then(|value| value.parse::<u64>().ok());
            let total = match total_from_header {
                Some(total) => Some(total),
                None => self.head(path).await?.map(|info| info.size),
            };
            let Some(total) = total else {
                return Err(SdkError::Internal(format!("416 for {path} without a usable total size")));
            };
            if offset >= total {
                return Ok(RangeFetch { bytes: Vec::new(), etag: None, ranged: false, range_ignored: false, precondition_failed: false });
            }
            self.send(Method::GET, url, request_range(&base, total.saturating_sub(1)), None).await?
        } else {
            response
        };
        // The clamped retry can itself lose the version race: surface it as a
        // precondition failure so the caller performs one bounded reacquire
        // instead of a generic error.
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(RangeFetch { bytes: Vec::new(), etag: None, ranged: false, range_ignored: false, precondition_failed: true });
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Err(SdkError::Fs(FsError::NotFound));
        }
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
            // A read entirely past EOF is a normal short read, not an error.
            return Ok(RangeFetch { bytes: Vec::new(), etag: None, ranged: false, range_ignored: false, precondition_failed: false });
        }
        if !response.status().is_success() {
            return Err(SdkError::Internal(format!("range GET {path} failed: {}", response.status())));
        }
        let partial = response.status() == StatusCode::PARTIAL_CONTENT;
        let etag = response.headers().get(ETAG).and_then(|value| value.to_str().ok()).map(str::to_string);
        let content_range = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        // Original `rangeIgnored` semantics: any 206 or any declared
        // Content-Range means the slice was NOT produced locally.
        let range_form = partial || content_range.is_some();
        let parsed_range = content_range.as_deref().and_then(parse_content_range);
        let mut response = response;
        let mut bytes = Vec::new();
        let mut prefix_remaining = offset;
        while let Some(chunk) = response.chunk().await
            .map_err(|error| SdkError::Internal(format!("reading range of {path} failed: {error}")))? {
            let remaining = size.saturating_sub(bytes.len() as u64);
            if range_form {
                if chunk.len() as u64 > remaining {
                    return Err(SdkError::Internal(format!("range response for {path} exceeded requested size {size}")));
                }
                bytes.extend_from_slice(&chunk);
            } else {
                // Discard the prefix and tail without storing the whole body.
                // Continue to EOF even after the requested window is full so
                // transport truncation remains an error.
                let skip = prefix_remaining.min(chunk.len() as u64);
                prefix_remaining -= skip;
                let available = &chunk[skip as usize..];
                let take = remaining.min(available.len() as u64) as usize;
                bytes.extend_from_slice(&available[..take]);
            }
        }
        if range_form {
            // A declared start that is not the requested offset is a wrong
            // proof, never a silent success.
            if let Some((start, _, _)) = parsed_range {
                if start != offset {
                    return Err(SdkError::Internal(format!(
                        "range response for {path} started at {start}, expected {offset}"
                    )));
                }
            }
            // Cacheable ONLY for a real 206 whose complete Content-Range proves
            // offset, legality (end<total, total>0), and that the claimed span
            // equals the fully received body. 200 (even with a fake
            // Content-Range) and a 206 without a valid Content-Range preserve
            // `rangeIgnored` semantics but are NEVER range-proven/cacheable.
            let cr_valid = partial
                && parsed_range.is_some_and(|(start, end, total)| {
                    start == offset
                        && end >= start
                        && total > 0
                        && end < total
                        && end - start + 1 == bytes.len() as u64
                });
            return Ok(RangeFetch { bytes, etag, ranged: cr_valid, range_ignored: false, precondition_failed: false });
        }
        Ok(RangeFetch { bytes, etag, ranged: false, range_ignored: true, precondition_failed: false })
    }

    pub async fn put(
        &self,
        path: &str,
        data: Vec<u8>,
        create: bool,
        base_version: Option<&str>,
        content_type: &str,
    ) -> SdkResult<Option<String>> {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_str(content_type).map_err(|error| SdkError::Internal(error.to_string()))?,
        );
        if create {
            headers.insert(IF_NONE_MATCH, HeaderValue::from_static("*"));
        } else {
            let version = base_version.ok_or_else(|| {
                SdkError::Internal(format!("refusing unconditional overwrite of {path}: no ETag available"))
            })?;
            headers.insert(
                IF_MATCH,
                HeaderValue::from_str(version).map_err(|error| SdkError::Internal(error.to_string()))?,
            );
        }
        headers.insert(CONTENT_LENGTH, HeaderValue::from_str(&data.len().to_string()).unwrap());
        let url = self.resource_url(path)?;
        let response = self.send(Method::PUT, url, headers, Some(data)).await?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err(SdkError::Internal(format!("version conflict writing {path}")));
        }
        if !response.status().is_success() {
            return Err(SdkError::Internal(format!("PUT {path} failed: {}", response.status())));
        }
        // Do NOT fall back to a HEAD here: another writer may have changed the
        // resource between the PUT and the HEAD, and binding that version to the
        // buffer we just wrote would be wrong. A missing ETag leaves the version
        // unknown, which forces a fresh handle before any further conditional
        // write instead of risking an unconditional overwrite.
        Ok(response.headers().get(ETAG).and_then(|value| value.to_str().ok()).map(str::to_string))
    }

    pub async fn delete(&self, path: &str, version: Option<&str>) -> SdkResult<()> {
        // A delete without a version baseline would be unconditional; refuse it.
        let version = version.ok_or_else(|| {
            SdkError::Internal(format!("refusing unconditional delete of {path}: no ETag baseline"))
        })?;
        let mut headers = HeaderMap::new();
        headers.insert(
            IF_MATCH,
            HeaderValue::from_str(version).map_err(|error| SdkError::Internal(error.to_string()))?,
        );
        let url = self.resource_url(path)?;
        let response = self.send(Method::DELETE, url, headers, None).await?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err(SdkError::Internal(format!("version conflict deleting {path}")));
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Err(SdkError::Fs(FsError::NotFound));
        }
        if !response.status().is_success() {
            return Err(SdkError::Internal(format!("DELETE {path} failed: {}", response.status())));
        }
        Ok(())
    }
}

#[derive(Debug, Default)]
struct Inner {
    by_ino: HashMap<i64, String>,
    by_path: HashMap<String, i64>,
    next: i64,
}

pub struct PodHttpFileSystem {
    shared: Arc<PodClient>,
    uid: u32,
    gid: u32,
    inner: Mutex<Inner>,
    overlay: Option<Arc<SessionOverlay>>,
    /// Persistent clean-body cache for the canonical remote Pod. `None` for a
    /// loopback-canonical (Local) authority or when no session directory is set.
    clean: Option<Arc<CleanBodyCache>>,
}

impl PodHttpFileSystem {
    pub fn new(
        base: &str,
        token: Option<String>,
        uid: u32,
        gid: u32,
        overlay: Option<Arc<SessionOverlay>>,
        clean: Option<Arc<CleanBodyCache>>,
    ) -> anyhow::Result<Self> {
        let mut inner = Inner { next: 2, ..Default::default() };
        inner.by_ino.insert(ROOT_INO, String::new());
        inner.by_path.insert(String::new(), ROOT_INO);
        Ok(Self {
            shared: Arc::new(PodClient::new(base, token)?),
            uid,
            gid,
            inner: Mutex::new(inner),
            overlay,
            clean,
        })
    }

    async fn ino_for(&self, relative: &str) -> i64 {
        let mut inner = self.inner.lock().await;
        if let Some(existing) = inner.by_path.get(relative) {
            return *existing;
        }
        let ino = inner.next;
        inner.next += 1;
        inner.by_ino.insert(ino, relative.to_string());
        inner.by_path.insert(relative.to_string(), ino);
        ino
    }

    async fn path_for(&self, ino: i64) -> SdkResult<String> {
        if ino == ROOT_INO {
            return Ok(String::new());
        }
        self.inner
            .lock()
            .await
            .by_ino
            .get(&ino)
            .cloned()
            .ok_or(SdkError::Fs(FsError::NotFound))
    }

    async fn forget_ino(&self, ino: i64) {
        let mut inner = self.inner.lock().await;
        if let Some(path) = inner.by_ino.remove(&ino) {
            inner.by_path.remove(&path);
        }
    }

    fn stats_for(&self, ino: i64, info: &HeadInfo) -> Stats {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_secs() as i64)
            .unwrap_or(0);
        Stats {
            ino,
            mode: if info.is_dir { DEFAULT_DIR_MODE } else { DEFAULT_FILE_MODE },
            nlink: if info.is_dir { 2 } else { 1 },
            uid: self.uid,
            gid: self.gid,
            size: if info.is_dir { 4096 } else { info.size as i64 },
            atime: now,
            mtime: now,
            ctime: now,
            atime_nsec: 0,
            mtime_nsec: 0,
            ctime_nsec: 0,
            rdev: 0,
        }
    }

    fn child_path(parent: &str, name: &str) -> SdkResult<String> {
        if name.is_empty() || name.contains('/') || name == "." || name == ".." {
            return Err(SdkError::Fs(FsError::InvalidPath));
        }
        if parent.is_empty() {
            Ok(name.to_string())
        } else if parent.ends_with('/') {
            Ok(format!("{parent}{name}"))
        } else {
            Ok(format!("{parent}/{name}"))
        }
    }

    fn immediate_children(prefix: &str, entries: &[ListEntry]) -> Vec<(String, ListEntry)> {
        let mut seen: HashMap<String, ListEntry> = HashMap::new();
        for entry in entries {
            let remainder = entry.path.strip_prefix(prefix).unwrap_or(&entry.path);
            let segments: Vec<&str> = remainder.split('/').filter(|segment| !segment.is_empty()).collect();
            if segments.len() != 1 {
                continue;
            }
            seen.insert(segments[0].to_string(), entry.clone());
        }
        let mut result: Vec<(String, ListEntry)> = seen.into_iter().collect();
        result.sort_by(|left, right| left.0.cmp(&right.0));
        result
    }

    async fn list_prefix(&self, path: &str) -> SdkResult<(String, Vec<ListEntry>)> {
        let prefix = if path.is_empty() { String::new() } else { format!("{path}/") };
        let entries = self.shared.list_all(&prefix).await?;
        Ok((prefix, entries))
    }

    /// Drops cached clean-body windows for one path after a mutation. Only the
    /// clean cache is touched; overlay dirty/baseline files are never involved.
    fn invalidate_clean_path(&self, path: &str) {
        if let Some(clean) = &self.clean {
            if let Err(error) = clean.invalidate_path(path) {
                eprintln!("clean cache invalidation retained for {path}: {error}");
            }
        }
    }

    /// Drops cached clean-body windows under a directory after a structural
    /// change (rmdir). Overlay dirty/baseline files are never involved.
    fn invalidate_clean_prefix(&self, prefix: &str) {
        if let Some(clean) = &self.clean {
            if let Err(error) = clean.invalidate_prefix(prefix) {
                eprintln!("clean cache prefix invalidation retained for {prefix}: {error}");
            }
        }
    }
}

#[async_trait]
impl FileSystem for PodHttpFileSystem {
    async fn lookup(&self, parent_ino: i64, name: &str) -> SdkResult<Option<Stats>> {
        if name == "." {
            return self.getattr(parent_ino).await;
        }
        if name == ".." {
            let parent = self.path_for(parent_ino).await?;
            let grand = match parent.trim_end_matches('/').rsplit_once('/') {
                Some((head, _)) => head.to_string(),
                None => String::new(),
            };
            let ino = self.ino_for(&grand).await;
            return self.getattr(ino).await;
        }
        let parent = self.path_for(parent_ino).await?;
        let child = Self::child_path(&parent, name)?;
        if let Some(overlay) = &self.overlay {
            if overlay.is_deleted(&child).map_err(|error| SdkError::Internal(error.to_string()))? { return Ok(None); }
            if let Some((size, _, is_dir)) = overlay.stat(&child).map_err(|error| SdkError::Internal(error.to_string()))? {
                let ino = self.ino_for(&child).await;
                return Ok(Some(self.stats_for(ino, &HeadInfo { size, version: None, is_dir })));
            }
        }
        let (prefix, entries) = self.list_prefix(&parent).await?;
        let found = Self::immediate_children(&prefix, &entries).into_iter().find(|(candidate, _)| candidate == name);
        if found.is_none() { return Ok(None); }
        let (_, entry) = found.unwrap();
        let info = HeadInfo {
            size: entry.size.unwrap_or(0),
            version: None,
            is_dir: entry.kind == "container",
        };
        let ino = self.ino_for(&child).await;
        Ok(Some(self.stats_for(ino, &info)))
    }

    async fn getattr(&self, ino: i64) -> SdkResult<Option<Stats>> {
        let path = self.path_for(ino).await?;
        if path.is_empty() {
            return Ok(Some(self.stats_for(ROOT_INO, &HeadInfo { size: 0, version: None, is_dir: true })));
        }
        if let Some(overlay) = &self.overlay {
            if let Some((size, _content_type, is_dir)) = overlay.stat(&path).map_err(|error| SdkError::Internal(error.to_string()))? {
                return Ok(Some(self.stats_for(ino, &HeadInfo { size, version: None, is_dir })));
            }
            if overlay.is_deleted(&path).map_err(|error| SdkError::Internal(error.to_string()))? {
                return Ok(None);
            }
        }
        match self.shared.head(&path).await? {
            Some(info) => Ok(Some(self.stats_for(ino, &info))),
            None => Ok(None),
        }
    }

    async fn readlink(&self, _ino: i64) -> SdkResult<Option<String>> {
        Ok(None)
    }

    async fn readdir(&self, ino: i64) -> SdkResult<Option<Vec<String>>> {
        let path = self.path_for(ino).await?;
        let (prefix, entries) = self.list_prefix(&path).await?;
        let mut names: Vec<String> = Self::immediate_children(&prefix, &entries).into_iter().map(|(name, _)| name).collect();
        if let Some(overlay) = &self.overlay {
            for (pending_path, deleted) in overlay.entry_paths().map_err(|error| SdkError::Internal(error.to_string()))? {
                let Some(remainder) = pending_path.strip_prefix(&prefix) else { continue; };
                let segments: Vec<&str> = remainder.split('/').filter(|segment| !segment.is_empty()).collect();
                if segments.len() != 1 {
                    continue;
                }
                let name = segments[0].to_string();
                names.retain(|candidate| candidate != &name);
                if !deleted {
                    names.push(name);
                }
            }
            names.sort();
        }
        Ok(Some(names))
    }

    async fn readdir_plus(&self, ino: i64) -> SdkResult<Option<Vec<DirEntry>>> {
        let path = self.path_for(ino).await?;
        let (prefix, entries) = self.list_prefix(&path).await?;
        let mut merged = Self::immediate_children(&prefix, &entries);
        if let Some(overlay) = &self.overlay {
            for (pending_path, deleted) in overlay.entry_paths().map_err(|error| SdkError::Internal(error.to_string()))? {
                let Some(remainder) = pending_path.strip_prefix(&prefix) else { continue; };
                let segments: Vec<&str> = remainder.split('/').filter(|segment| !segment.is_empty()).collect();
                if segments.len() != 1 {
                    continue;
                }
                let name = segments[0].to_string();
                merged.retain(|(candidate, _)| candidate != &name);
                if !deleted {
                    let (size, _, is_dir) = overlay.stat(&pending_path).map_err(|error| SdkError::Internal(error.to_string()))?.ok_or(SdkError::Fs(FsError::NotFound))?;
                    merged.push((name, ListEntry { path: pending_path.clone(), kind: if is_dir { "container" } else { "file" }.into(), size: Some(size) }));
                }
            }
            merged.sort_by(|left, right| left.0.cmp(&right.0));
        }
        let mut result = Vec::new();
        for (name, entry) in merged {
            let child = Self::child_path(&path, &name)?;
            let child_ino = self.ino_for(&child).await;
            let info = HeadInfo {
                size: entry.size.unwrap_or(0),
                version: None,
                is_dir: entry.kind == "container",
            };
            result.push(DirEntry { name, stats: self.stats_for(child_ino, &info) });
        }
        Ok(Some(result))
    }

    async fn chmod(&self, _ino: i64, _mode: u32) -> SdkResult<()> {
        Ok(())
    }

    async fn chown(&self, _ino: i64, _uid: Option<u32>, _gid: Option<u32>) -> SdkResult<()> {
        Ok(())
    }

    async fn utimens(&self, _ino: i64, _atime: TimeChange, _mtime: TimeChange) -> SdkResult<()> {
        Ok(())
    }

    async fn open(&self, ino: i64, flags: i32) -> SdkResult<BoxedFile> {
        let path = self.path_for(ino).await?;
        let writable = flags & (libc::O_WRONLY | libc::O_RDWR) != 0;
        let version = match &self.overlay {
            Some(overlay) => match overlay.first_baseline(&path).map_err(|error| SdkError::Internal(error.to_string()))? {
                Some(base) => base,
                None => self.shared.head(&path).await?.and_then(|info| info.version),
            },
            None => self.shared.head(&path).await?.and_then(|info| info.version),
        };
        Ok(Arc::new(PodFile::new(
            self.shared.clone(),
            self.overlay.clone(),
            self.clean.clone(),
            path,
            version,
            writable,
            "application/octet-stream".to_string(),
        )) as BoxedFile)
    }

    async fn mkdir(&self, parent_ino: i64, name: &str, _mode: u32, _uid: u32, _gid: u32) -> SdkResult<Stats> {
        let parent = self.path_for(parent_ino).await?;
        let child = Self::child_path(&parent, name)?;
        self.invalidate_clean_path(&child);
        if let Some(overlay) = &self.overlay {
            if self.lookup(parent_ino, name).await?.is_some() { return Err(SdkError::Fs(FsError::AlreadyExists)); }
            overlay.mkdir(&child).map_err(|error| SdkError::Internal(error.to_string()))?;
            let ino = self.ino_for(&child).await;
            return Ok(self.stats_for(ino, &HeadInfo { size: 0, version: None, is_dir: true }));
        }
        let container_path = format!("{child}/");
        let url = self.shared.resource_url(&container_path)?;
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/turtle"));
        headers.insert(IF_NONE_MATCH, HeaderValue::from_static("*"));
        headers.insert(LINK, HeaderValue::from_static("<http://www.w3.org/ns/ldp#BasicContainer>; rel=\"type\""));
        let response = self.shared.send(Method::PUT, url, headers, Some(Vec::new())).await?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err(SdkError::Fs(FsError::AlreadyExists));
        }
        if !response.status().is_success() {
            return Err(SdkError::Internal(format!("mkdir {child} failed: {}", response.status())));
        }
        let ino = self.ino_for(&child).await;
        Ok(self.stats_for(ino, &HeadInfo { size: 0, version: None, is_dir: true }))
    }

    async fn create_file(
        &self,
        parent_ino: i64,
        name: &str,
        _mode: u32,
        _uid: u32,
        _gid: u32,
    ) -> SdkResult<(Stats, BoxedFile)> {
        let parent = self.path_for(parent_ino).await?;
        let child = Self::child_path(&parent, name)?;
        self.invalidate_clean_path(&child);
        let observed = self.shared.head(&child).await?;
        let base = if let Some(overlay) = &self.overlay {
            let deleted = overlay.is_deleted(&child).map_err(|error| SdkError::Internal(error.to_string()))?;
            if !deleted && (observed.is_some() || overlay.stat(&child).map_err(|error| SdkError::Internal(error.to_string()))?.is_some()) {
                return Err(SdkError::Fs(FsError::AlreadyExists));
            }
            None
        } else { observed.and_then(|info| info.version) };
        let base = if let Some(overlay) = &self.overlay {
            overlay.put(&child, Vec::new(), "application/octet-stream", base.clone()).map_err(|error| SdkError::Internal(error.to_string()))?;
            base
        } else {
            self.shared.put(&child,Vec::new(), true, None, "application/octet-stream").await?
        };
        let ino = self.ino_for(&child).await;
        let stats = self.stats_for(ino, &HeadInfo { size: 0, version: base.clone(), is_dir: false });
        let file = Arc::new(PodFile::new(
            self.shared.clone(),
            self.overlay.clone(),
            self.clean.clone(),
            child,
            base.clone(),
            true,
            "application/octet-stream".to_string(),
        )) as BoxedFile;
        Ok((stats, file))
    }

    async fn mknod(&self, parent_ino: i64, name: &str, _mode: u32, _rdev: u64, uid: u32, gid: u32) -> SdkResult<Stats> {
        let (stats, _file) = self.create_file(parent_ino, name, DEFAULT_FILE_MODE, uid, gid).await?;
        Ok(stats)
    }

    async fn symlink(&self, _parent_ino: i64, _name: &str, _target: &str, _uid: u32, _gid: u32) -> SdkResult<Stats> {
        Err(SdkError::Fs(FsError::InvalidPath))
    }

    async fn unlink(&self, parent_ino: i64, name: &str) -> SdkResult<()> {
        let parent = self.path_for(parent_ino).await?;
        let child = Self::child_path(&parent, name)?;
        self.invalidate_clean_path(&child);
        let version = self.shared.head(&child).await?.and_then(|info| info.version);
        if let Some(overlay) = &self.overlay {
            overlay.delete(&child, version).map_err(|error| SdkError::Internal(error.to_string()))?;
            return Ok(());
        }
        self.shared.delete(&child, version.as_deref()).await
    }

    async fn rmdir(&self, parent_ino: i64, name: &str) -> SdkResult<()> {
        let parent = self.path_for(parent_ino).await?;
        let child = Self::child_path(&parent, name)?;
        let ino = self.ino_for(&child).await;
        if !self.readdir(ino).await?.unwrap_or_default().is_empty() {
            return Err(SdkError::Fs(FsError::NotEmpty));
        }
        self.invalidate_clean_path(&child);
        self.invalidate_clean_prefix(&format!("{child}/"));
        let container = format!("{child}/");
        let version = self.shared.head(&container).await?.and_then(|info| info.version);
        if let Some(overlay) = &self.overlay {
            overlay.delete_directory(&child, version).map_err(|error| SdkError::Internal(error.to_string()))?;
            return Ok(());
        }
        self.shared.delete(&container, version.as_deref()).await
    }

    async fn link(&self, _ino: i64, _newparent_ino: i64, _newname: &str) -> SdkResult<Stats> {
        Err(SdkError::Fs(FsError::InvalidPath))
    }

    async fn rename(
        &self,
        oldparent_ino: i64,
        oldname: &str,
        newparent_ino: i64,
        newname: &str,
    ) -> SdkResult<()> {
        let old_parent = self.path_for(oldparent_ino).await?;
        let new_parent = self.path_for(newparent_ino).await?;
        let source = Self::child_path(&old_parent, oldname)?;
        let target = Self::child_path(&new_parent, newname)?;
        self.invalidate_clean_path(&source);
        self.invalidate_clean_path(&target);
        let from_info = self.shared.head(&source).await?;
        let to_info = self.shared.head(&target).await?;
        if from_info.as_ref().is_some_and(|info| info.is_dir) || to_info.as_ref().is_some_and(|info| info.is_dir) {
            return Err(SdkError::Fs(FsError::InvalidPath));
        }
        let from_base = from_info.and_then(|info| info.version);
        let to_base = to_info.and_then(|info| info.version);
        if let Some(overlay) = &self.overlay {
            // Ensure the source exists in the overlay view before renaming.
            if overlay.stat(&source).map_err(|error| SdkError::Internal(error.to_string()))?.is_none() {
                let file = PodFile::new(self.shared.clone(), self.overlay.clone(), self.clean.clone(), source.clone(), from_base.clone(), true, "application/octet-stream".into());
                file.edit_overlay(None, &[], None).await?;
            }
            overlay.rename(&source, &target, from_base, to_base).map_err(|error| SdkError::Internal(error.to_string()))?;
            return Ok(());
        }
        let info = self.shared.head(&source).await?.ok_or(SdkError::Fs(FsError::NotFound))?;
        let content = self.shared.get_full(&source).await?;
        match self.shared.head(&target).await? {
            Some(existing) => {
                self.shared
                    .put(&target, content, false, existing.version.as_deref(), "application/octet-stream")
                    .await?;
            }
            None => {
                self.shared.put(&target, content, true, None, "application/octet-stream").await?;
            }
        }
        self.shared.delete(&source, info.version.as_deref()).await
    }

    async fn statfs(&self) -> SdkResult<FilesystemStats> {
        Ok(FilesystemStats { inodes: 1, bytes_used: 0 })
    }

    async fn forget(&self, ino: i64, _nlookup: u64) {
        self.forget_ino(ino).await;
    }
}

/// Open file handle backed by the session overlay. The overlay (not this
/// handle) is the authority, so an NFS layer that reopens per write still sees
/// the dirty content. `fsync` only guarantees local durability; the Pod is
/// written only by an explicit commit.
pub struct PodFile {
    shared: Arc<PodClient>,
    overlay: Option<Arc<SessionOverlay>>,
    clean: Option<Arc<CleanBodyCache>>,
    path: String,
    content_type: String,
    writable: bool,
    version: Mutex<Option<String>>,
}

impl PodFile {
    fn new(
        shared: Arc<PodClient>,
        overlay: Option<Arc<SessionOverlay>>,
        clean: Option<Arc<CleanBodyCache>>,
        path: String,
        version: Option<String>,
        writable: bool,
        content_type: String,
    ) -> Self {
        Self { shared, overlay, clean, path, content_type, writable, version: Mutex::new(version) }
    }

    /// Cache-aware clean read. The overlay (dirty/baseline local state) always
    /// wins and is never cached. Otherwise a LIVE `HEAD` revalidates permission
    /// and the strong ETag before any cached window may be served; a denied or
    /// failed HEAD invalidates the path and returns that live error. A changed
    /// ETag (or `412`) drops the stale windows and reacquires the current
    /// version exactly once. Weak/missing ETags bypass the cache entirely.
    async fn cached_pread(&self, clean: &CleanBodyCache, offset: u64, size: u64) -> SdkResult<Vec<u8>> {
        let info = match self.shared.head(&self.path).await {
            Ok(Some(info)) => info,
            Ok(None) => {
                let _ = clean.invalidate_path(&self.path);
                return Err(SdkError::Fs(FsError::NotFound));
            }
            Err(error) => {
                let _ = clean.invalidate_path(&self.path);
                return Err(error);
            }
        };
        let Some(etag) = info.version.clone().filter(|value| is_strong_etag(value)) else {
            let (data, _ignored) = self.shared.get_range(&self.path, offset, size).await?;
            return Ok(data);
        };
        if let Some(data) = clean
            .get(&self.path, &etag, offset, size)
            .map_err(|error| SdkError::Internal(error.to_string()))?
        {
            return Ok(data);
        }
        // The window is absent for the live version. A live HEAD is the
        // authority: drop any window still pinned to another version so a
        // changed ETag can never serve an old range.
        let _ = clean.retain_path_etag(&self.path, &etag);
        let mut current = etag;
        let mut fetch = self.shared.get_range_conditional(&self.path, offset, size, Some(current.as_str())).await?;
        if fetch.precondition_failed {
            clean
                .invalidate_path(&self.path)
                .map_err(|error| SdkError::Internal(error.to_string()))?;
            let Some(info) = self.shared.head(&self.path).await? else {
                return Err(SdkError::Fs(FsError::NotFound));
            };
            let Some(next) = info.version.clone().filter(|value| is_strong_etag(value)) else {
                let (data, _ignored) = self.shared.get_range(&self.path, offset, size).await?;
                return Ok(data);
            };
            current = next;
            fetch = self.shared.get_range_conditional(&self.path, offset, size, Some(current.as_str())).await?;
        }
        if fetch.precondition_failed {
            // A second concurrent change: serve the fresh bounded read and do
            // not cache it, rather than retrying indefinitely.
            let (data, _ignored) = self.shared.get_range(&self.path, offset, size).await?;
            return Ok(data);
        }
        // Cache only a genuine range response that matches the live version and
        // transferred exactly the requested window.
        let validated = fetch.ranged
            && fetch.bytes.len() as u64 == size
            && fetch.etag.as_deref() == Some(current.as_str());
        if validated {
            let _ = clean.insert(&self.path, &current, offset, size, &fetch.bytes);
        }
        Ok(fetch.bytes)
    }

    async fn load_full(&self) -> SdkResult<Vec<u8>> {
        if let Some(overlay) = &self.overlay {
            if let Some((data, _)) = overlay.get(&self.path).map_err(|error| SdkError::Internal(error.to_string()))? {
                return Ok(data);
            }
        }
        self.shared.get_full(&self.path).await
    }

    async fn edit_overlay(&self, offset: Option<u64>, data: &[u8], truncate: Option<u64>) -> SdkResult<()> {
        self.invalidate_clean();
        let overlay = self.overlay.as_ref().unwrap();
        let observed = overlay.first_baseline(&self.path).map_err(|error| SdkError::Internal(error.to_string()))?;
        let baseline = self.base_version().await?;
        let mut seed = None;
        if observed.is_none() {
            let version = baseline.as_ref().ok_or_else(|| SdkError::Internal("copy-up requires an observed ETag".into()))?;
            if truncate != Some(0) {
                let mut lease = overlay.create_seed().map_err(|error| SdkError::Internal(error.to_string()))?;
                self.shared.copy_to(&self.path, version, lease.file_mut()).await?;
                seed = Some(lease);
            }
        }
        let result = overlay.edit(&self.path, seed.as_ref().map(|lease| lease.file()), baseline, &self.content_type, offset, data, truncate)
            .map_err(|error| SdkError::Internal(error.to_string()));
        let cleanup = seed.map(|lease| lease.finish()).transpose()
            .map_err(|error| SdkError::Internal(error.to_string()));
        if result.is_err() {
            if let Err(error) = &cleanup { eprintln!("seed cleanup retained after edit failure: {error}"); }
        }
        result?;
        cleanup?;
        Ok(())
    }

    /// Drops any clean-body windows for this path. Called on every mutation so a
    /// stale remote window can never be served after the version moves; the
    /// dirty/baseline overlay itself is never stored in the clean cache.
    fn invalidate_clean(&self) {
        if let Some(clean) = &self.clean {
            if let Err(error) = clean.invalidate_path(&self.path) {
                eprintln!("clean cache invalidation retained for {}: {error}", self.path);
            }
        }
    }

    async fn base_version(&self) -> SdkResult<Option<String>> {
        if let Some(overlay) = &self.overlay {
            if let Some(base) = overlay.first_baseline(&self.path).map_err(|error| SdkError::Internal(error.to_string()))? {
                return Ok(base);
            }
        }
        Ok(self.version.lock().await.clone())
    }

}

#[async_trait]
impl File for PodFile {
    async fn pread(&self, offset: u64, size: u64) -> SdkResult<Vec<u8>> {
        if let Some(overlay) = &self.overlay {
            if let Some(data) = overlay.read_range(&self.path, offset, size).map_err(|error| SdkError::Internal(error.to_string()))? {
                return Ok(data);
            }
        }
        if size == 0 {
            return Ok(Vec::new());
        }
        if let Some(clean) = &self.clean {
            return self.cached_pread(clean, offset, size).await;
        }
        let (data, _ignored) = self.shared.get_range(&self.path, offset, size).await?;
        Ok(data)
    }

    async fn pwrite(&self, offset: u64, data: &[u8]) -> SdkResult<()> {
        if !self.writable {
            return Err(SdkError::Fs(FsError::InvalidPath));
        }
        if self.overlay.is_some() { return self.edit_overlay(Some(offset), data, None).await; }
        self.invalidate_clean();
        let mut buffer = self.load_full().await?;
        let required = offset as usize + data.len();
        if buffer.len() < required {
            buffer.resize(required, 0);
        }
        buffer[offset as usize..required].copy_from_slice(data);
        let version = self.version.lock().await.clone();
        let new_version = self.shared.put(&self.path, buffer, false, version.as_deref(), &self.content_type).await?;
        *self.version.lock().await = new_version;
        Ok(())
    }

    async fn truncate(&self, size: u64) -> SdkResult<()> {
        if !self.writable {
            return Err(SdkError::Fs(FsError::InvalidPath));
        }
        if self.overlay.is_some() { return self.edit_overlay(None, &[], Some(size)).await; }
        self.invalidate_clean();
        let mut buffer = self.load_full().await?;
        buffer.resize(size as usize, 0);
        let version = self.version.lock().await.clone();
        let new_version = self.shared.put(&self.path, buffer, false, version.as_deref(), &self.content_type).await?;
        *self.version.lock().await = new_version;
        Ok(())
    }

    async fn fsync(&self) -> SdkResult<()> {
        if let Some(overlay) = &self.overlay {
            overlay.fsync().map_err(|error| SdkError::Internal(error.to_string()))?;
        }
        Ok(())
    }

    async fn fstat(&self) -> SdkResult<Stats> {
        if let Some(overlay) = &self.overlay {
            if let Some((size, _, is_dir)) = overlay.stat(&self.path).map_err(|error| SdkError::Internal(error.to_string()))? {
                return Ok(Stats {
                    ino: ROOT_INO + 1,
                    mode: if is_dir { DEFAULT_DIR_MODE } else { DEFAULT_FILE_MODE },
                    nlink: 1,
                    uid: 0,
                    gid: 0,
                    size: size as i64,
                    atime: 0,
                    mtime: 0,
                    ctime: 0,
                    atime_nsec: 0,
                    mtime_nsec: 0,
                    ctime_nsec: 0,
                    rdev: 0,
                });
            }
        }
        let info = self.shared.head(&self.path).await?.ok_or(SdkError::Fs(FsError::NotFound))?;
        Ok(Stats {
            ino: ROOT_INO + 1,
            mode: if info.is_dir { DEFAULT_DIR_MODE } else { DEFAULT_FILE_MODE },
            nlink: 1,
            uid: 0,
            gid: 0,
            size: info.size as i64,
            atime: 0,
            mtime: 0,
            ctime: 0,
            atime_nsec: 0,
            mtime_nsec: 0,
            ctime_nsec: 0,
            rdev: 0,
        })
    }
}

const _: u32 = S_IFREG | S_IFDIR;

#[cfg(test)]
mod range_stream_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};

    async fn range_response(headers: &str, body: &[u8], offset: u64, size: u64) -> SdkResult<(Vec<u8>, bool)> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}/", listener.local_addr().unwrap());
        let headers = headers.to_owned();
        let body = body.to_vec();
        let producer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            stream.write_all(headers.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        });
        let result = PodClient::new(&root, None).unwrap().get_range("file", offset, size).await;
        producer.join().unwrap();
        result
    }

    #[tokio::test]
    async fn active_http_copy_seed_survives_reopen_and_cancellation_cleans_it() {
        struct SessionDir(std::path::PathBuf);
        impl Drop for SessionDir {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = SessionDir(std::path::PathBuf::from("../../.test-data/agentfs-http-seed")
            .join(format!("{}-{nonce}", std::process::id())));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}/", listener.local_addr().unwrap());
        let overlay = Arc::new(SessionOverlay::open(&dir.0, &root, "alice").unwrap());
        let manifest = std::fs::read(dir.0.join("session.json")).unwrap();
        let (release, blocked) = std::sync::mpsc::channel();
        let producer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 131072\r\nETag: \"baseline\"\r\nConnection: close\r\n\r\n").unwrap();
            let block = [b'x'; 64 * 1024];
            stream.write_all(&block).unwrap();
            // A channel, rather than timing, holds the HTTP tail until the
            // owner has been cancelled and joined. Cancellation may close TCP.
            let _ = blocked.recv();
            let _ = stream.write_all(&block);
        });
        let (created, seed_path) = tokio::sync::oneshot::channel();
        let owner_overlay = overlay.clone();
        let client = PodClient::new(&root, None).unwrap();
        let owner = tokio::spawn(async move {
            let mut lease = owner_overlay.create_seed().map_err(|error| SdkError::Internal(error.to_string()))?;
            created.send(lease.path().to_owned()).unwrap();
            client.copy_to("file", "\"baseline\"", lease.file_mut()).await
        });
        let seed = seed_path.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if std::fs::metadata(&seed).unwrap().len() >= 64 * 1024 { break; }
                tokio::task::yield_now().await;
            }
        }).await.expect("seed must contain the first actual HTTP body block");
        SessionOverlay::open(&dir.0, &root, "alice").unwrap();
        assert!(seed.exists(), "active HTTP owner must retain its seed");
        assert_eq!(std::fs::read(dir.0.join("session.json")).unwrap(), manifest);
        owner.abort();
        assert!(owner.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        producer.join().unwrap();
        assert!(!seed.exists(), "cancelled future must finish RAII seed cleanup");
        assert_eq!(std::fs::read(dir.0.join("session.json")).unwrap(), manifest);
        assert!(overlay.pending_paths().unwrap().is_empty());
        println!("actual HTTP seed first body=65536 bytes; future joined cancelled; producer joined closed");
    }

    #[tokio::test]
    async fn oversized_partial_body_is_rejected() {
        assert!(range_response("HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nConnection: close\r\n\r\n", b"abcde", 0, 2).await.is_err());
    }

    #[tokio::test]
    async fn ignored_range_discards_prefix_and_drains_tail_across_chunks() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}/", listener.local_addr().unwrap());
        const TOTAL: usize = 5 * 1024 * 1024;
        let producer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {TOTAL}\r\nConnection: close\r\n\r\n").unwrap();
            let mut block = [0; 64 * 1024];
            for base in (0..TOTAL).step_by(block.len()) {
                for (index, byte) in block.iter_mut().enumerate() { *byte = ((base + index) % 251) as u8; }
                stream.write_all(&block).unwrap();
            }
            TOTAL
        });
        let offset = 1024 * 1024 + 3;
        let result = PodClient::new(&root, None).unwrap().get_range("file", offset, 16).await;
        assert_eq!(producer.join().unwrap(), TOTAL);
        assert_eq!(result.unwrap(), ((offset..offset + 16).map(|index| (index % 251) as u8).collect(), true));
    }

    #[tokio::test]
    async fn range_forms_keep_offset_and_actual_length_checks() {
        for headers in [
            "HTTP/1.1 206 Partial Content\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Range: bytes 0-4/5\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        ] {
            assert!(range_response(headers, b"5\r\nabcde\r\n0\r\n\r\n", 0, 2).await.is_err());
        }
        assert_eq!(range_response("HTTP/1.1 200 OK\r\nContent-Range: bytes 3-4/8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n", b"de", 3, 2).await.unwrap(), (b"de".to_vec(), false));
        assert!(range_response("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 1-2/8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n", b"bc", 3, 2).await.is_err());
        for (offset, size, expected) in [(8, 2, b"".as_slice()), (u64::MAX, 0, b"".as_slice()), (0, 0, b"".as_slice()), (6, 9, b"gh".as_slice())] {
            assert_eq!(range_response("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n", b"abcdefgh", offset, size).await.unwrap(), (expected.to_vec(), true));
        }
    }

    #[tokio::test]
    async fn ignored_range_drains_tail_and_reports_truncation() {
        assert_eq!(range_response("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\n", b"abcdefgh", 3, 2).await.unwrap(), (b"de".to_vec(), true));
        assert!(range_response("HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n", b"abcdefgh", 3, 2).await.is_err());
    }

    /// A bounded, task-owned scripted HTTP server. It accepts on a nonblocking
    /// listener and serves one response per connection in order, so a missing
    /// request can never block the thread forever; Drop (and the explicit
    /// `join_owned`) stops and actually joins the owned thread.
    struct ScriptedServer {
        root: String,
        stop: std::sync::Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }
    impl ScriptedServer {
        fn start(responses: Vec<(String, Vec<u8>)>) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let root = format!("http://{}/", listener.local_addr().unwrap());
            let stop = std::sync::Arc::new(AtomicBool::new(false));
            let stop_thread = stop.clone();
            let handle = std::thread::spawn(move || {
                let mut index = 0usize;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                while index < responses.len() && !stop_thread.load(Ordering::SeqCst) {
                    if std::time::Instant::now() > deadline { break; }
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let (headers, body) = &responses[index];
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                            let mut request = [0; 4096];
                            let _ = stream.read(&mut request);
                            let _ = stream.write_all(headers.as_bytes());
                            let _ = stream.write_all(body);
                            let _ = stream.flush();
                            index += 1;
                        }
                        Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self { root, stop, handle: Some(handle) }
        }
        fn root(&self) -> &str { &self.root }
        fn join_owned(mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(handle) = self.handle.take() {
                handle.join().expect("scripted server thread must close");
            }
        }
    }
    impl Drop for ScriptedServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(handle) = self.handle.take() { let _ = handle.join(); }
        }
    }

    #[tokio::test]
    async fn copy_up_failure_diagnostics_preserve_errors_and_hide_secrets() {
        const CHILD: &str = "XPOD_COPY_UP_DIAGNOSTIC_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            use std::process::{Command, Stdio};
            fn run_child(stderr: Stdio) -> std::process::Output {
                let mut child = Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "pod_fs::range_stream_tests::copy_up_failure_diagnostics_preserve_errors_and_hide_secrets", "--nocapture"])
                    .env(CHILD, "1").stdout(Stdio::piped()).stderr(stderr).spawn().unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
                while child.try_wait().unwrap().is_none() {
                    if std::time::Instant::now() >= deadline {
                        child.kill().unwrap(); child.wait().unwrap();
                        panic!("owned diagnostic child exceeded its observation deadline");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                let output = child.wait_with_output().unwrap();
                assert!(output.status.success(), "owned child failed: {}", String::from_utf8_lossy(&output.stdout));
                output
            }
            let output = run_child(Stdio::piped());
            let stderr = String::from_utf8(output.stderr).unwrap();
            for secret in ["SECRET_PATH", "SECRET_BEARER", "SECRET_BODY", "SECRET_CAPABILITY", "PRIVATE_BODY_CONTENT"] {
                assert!(!stderr.contains(secret), "diagnostic disclosed a sensitive test marker");
            }
            let records: Vec<serde_json::Value> = stderr.lines().filter_map(|line| line.strip_prefix("agentfs-pod-copy-up: "))
                .map(|line| serde_json::from_str(line).unwrap()).collect();
            assert_eq!(records.len(), 4, "each failed operation emits once");
            assert_eq!(records.iter().map(|row| row["stage"].as_str().unwrap()).collect::<Vec<_>>(), ["send", "chunk", "write_all", "sync_all"]);
            for row in &records {
                assert!(row["elapsedMs"].is_number());
                assert!(row["bodyBytesReceived"].as_u64().unwrap() >= row["fullyWrittenChunkBytes"].as_u64().unwrap());
            }
            assert_eq!(records[0]["bodyBytesReceived"], 0);
            assert_eq!(records[1]["bodyBytesReceived"], records[1]["fullyWrittenChunkBytes"]);
            assert!((1..=20).contains(&records[2]["bodyBytesReceived"].as_u64().unwrap())); assert_eq!(records[2]["fullyWrittenChunkBytes"], 0);
            assert!(records[2]["cause"]["errno"].is_number());
            assert_eq!(records[3]["bodyBytesReceived"], 20); assert_eq!(records[3]["fullyWrittenChunkBytes"], 20);
            // A closed diagnostic sink must not panic or replace any SDK error.
            let (reader, writer) = std::os::unix::net::UnixStream::pair().unwrap();
            drop(reader);
            let writer: std::os::fd::OwnedFd = writer.into();
            run_child(Stdio::from(writer));
            return;
        }
        use std::io::Write;
        let directory = std::path::PathBuf::from("../../.test-data/agentfs-copy-up-diagnostics")
            .join(format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("SECRET_PATH");
        let mut output = std::fs::File::create(&target).unwrap();
        let malformed = ("THIS_IS_NOT_HTTP\r\n\r\n".to_string(), Vec::new());
        let server = ScriptedServer::start(vec![malformed.clone(), malformed]);
        let mut client = PodClient::new(server.root(), Some("SECRET_BEARER".into())).unwrap();
        client.capability = Some("SECRET_CAPABILITY".into());
        let original = client.send(Method::GET, client.resource_url("SECRET_PATH").unwrap(), HeaderMap::new(), None).await.unwrap_err();
        let observed = client.copy_to("SECRET_PATH", "\"v1\"", &mut output).await.unwrap_err();
        assert_eq!(format!("{observed:?}"), format!("{original:?}")); server.join_owned();

        let truncated = ("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n".to_string(), b"SECRET_BODY".to_vec());
        let server = ScriptedServer::start(vec![truncated.clone(), truncated]);
        let client = PodClient::new(server.root(), None).unwrap();
        let mut response = client.send(Method::GET, client.resource_url("SECRET_PATH").unwrap(), HeaderMap::new(), None).await.unwrap();
        let original = loop { match response.chunk().await { Ok(Some(_)) => (), Ok(None) => panic!("truncated body unexpectedly closed cleanly"), Err(error) => break SdkError::Internal(error.to_string()) } };
        let observed = client.copy_to("SECRET_PATH", "\"v1\"", &mut output).await.unwrap_err();
        assert_eq!(format!("{observed:?}"), format!("{original:?}")); server.join_owned();

        let complete = ("HTTP/1.1 200 OK\r\nContent-Length: 20\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n".to_string(), b"PRIVATE_BODY_CONTENT".to_vec());
        let server = ScriptedServer::start(vec![complete.clone(), complete]);
        let client = PodClient::new(server.root(), None).unwrap();
        let mut read_only = std::fs::File::open(&target).unwrap();
        let original = SdkError::Internal(read_only.write_all(b"x").unwrap_err().to_string());
        let observed = client.copy_to("SECRET_PATH", "\"v1\"", &mut read_only).await.unwrap_err();
        assert_eq!(format!("{observed:?}"), format!("{original:?}"));
        let mut null = std::fs::OpenOptions::new().write(true).open("/dev/null").unwrap();
        let original = SdkError::Internal(null.sync_all().unwrap_err().to_string());
        let observed = client.copy_to("SECRET_PATH", "\"v1\"", &mut null).await.unwrap_err();
        assert_eq!(format!("{observed:?}"), format!("{original:?}")); server.join_owned();
        drop(output); drop(read_only); drop(null); std::fs::remove_dir_all(directory).unwrap();
    }

    async fn conditional_response(headers: &str, body: &[u8], offset: u64, size: u64) -> SdkResult<RangeFetch> {
        let server = ScriptedServer::start(vec![(headers.to_string(), body.to_vec())]);
        let result = PodClient::new(server.root(), None).unwrap().get_range_conditional("file", offset, size, None).await;
        server.join_owned();
        result
    }

    #[tokio::test]
    async fn only_a_complete_206_content_range_is_range_proven() {
        // Valid 206 with a complete, legal Content-Range.
        let good = conditional_response(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 3-4/8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n",
            b"de", 3, 2,
        ).await.unwrap();
        assert_eq!((good.ranged, good.range_ignored, good.bytes), (true, false, b"de".to_vec()));

        // 206 without Content-Range: never range-proven.
        let no_cr = conditional_response(
            "HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nConnection: close\r\n\r\n",
            b"de", 3, 2,
        ).await.unwrap();
        assert_eq!((no_cr.ranged, no_cr.range_ignored), (false, false));

        // 200 with a fake Content-Range: preserved rangeIgnored semantics, never proven.
        let fake = conditional_response(
            "HTTP/1.1 200 OK\r\nContent-Range: bytes 3-4/8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n",
            b"de", 3, 2,
        ).await.unwrap();
        assert_eq!((fake.ranged, fake.range_ignored, fake.bytes), (false, false, b"de".to_vec()));

        // 206 whose claimed span (4) does not equal the received body (2).
        let short = conditional_response(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 3-6/8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n",
            b"de", 3, 2,
        ).await.unwrap();
        assert_eq!(short.ranged, false, "claimed span must equal received bytes");

        // 206 declaring a start that is not the requested offset is an error.
        assert!(conditional_response(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 1-2/8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n",
            b"bc", 3, 2,
        ).await.is_err());

        // 206 with total 0 cannot prove range/total legality.
        let zero = conditional_response(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 3-4/0\r\nContent-Length: 2\r\nConnection: close\r\n\r\n",
            b"de", 3, 2,
        ).await.unwrap();
        assert_eq!(zero.ranged, false);
    }

    #[tokio::test]
    async fn clamped_416_retry_that_hits_412_reports_precondition_failed() {
        // First request (bytes=2-101) gets 416 with the real total; the clamped
        // retry (bytes=2-7) then loses the race and answers 412.
        let server = ScriptedServer::start(vec![
            ("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(), Vec::new()),
            ("HTTP/1.1 412 Precondition Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(), Vec::new()),
        ]);
        let fetch = PodClient::new(server.root(), None).unwrap()
            .get_range_conditional("file", 2, 100, Some("\"v1\"")).await.unwrap();
        server.join_owned();
        assert!(fetch.precondition_failed, "clamped 416 retry 412 must report a precondition failure");
        assert!(!fetch.ranged);

        // An offset at/after the real total is a normal EOF, not a retry.
        let eof = conditional_response(
            "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            b"", 8, 4,
        ).await.unwrap();
        assert_eq!((eof.precondition_failed, eof.ranged, eof.bytes), (false, false, Vec::new()));
    }
}

#[cfg(test)]
mod clean_cache_integration_tests {
    use super::*;
    use crate::clean_cache::CleanBodyCache;
    use crate::fixture::FixturePod;
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering as AtomicOrdering};

    // Canonical remote authority. The transport is still the loopback fixture,
    // which models the real HTTPS-canonical-via-loopback-proxy deployment.
    const REMOTE_ROOT: &str = "https://node.example/alice/";

    struct CleanDir(PathBuf);
    impl CleanDir {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = PathBuf::from("../../.test-data/agentfs-clean-cache")
                .join(format!("{}-{nonce}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for CleanDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    async fn open_handle(fs: &PodHttpFileSystem, name: &str, flags: i32) -> agentfs_sdk::BoxedFile {
        let stats = fs.lookup(ROOT_INO, name).await.unwrap().unwrap();
        fs.open(stats.ino, flags).await.unwrap()
    }

    fn counted(pod: &FixturePod, method: &str) -> usize {
        pod.log().iter().filter(|entry| entry.method == method).count()
    }

    #[tokio::test]
    async fn second_remote_read_avoids_body_get_while_head_present() {
        let pod = FixturePod::start(vec![("data.bin".into(), "ABCDEFGHIJKLMNOPQRSTUVWX".into())]).unwrap();
        let dir = CleanDir::new();
        let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("t".into()), 0, 0, None, Some(clean.clone())).unwrap();
        let handle = open_handle(&fs, "data.bin", libc::O_RDONLY).await;

        pod.reset_log();
        assert_eq!(handle.pread(0, 4).await.unwrap(), b"ABCD".to_vec());
        assert_eq!(counted(&pod, "GET"), 1, "first clean read must fetch one bounded window");
        assert_eq!(counted(&pod, "HEAD"), 1, "first clean read must revalidate with a live HEAD");

        pod.reset_log();
        assert_eq!(handle.pread(0, 4).await.unwrap(), b"ABCD".to_vec());
        assert_eq!(counted(&pod, "GET"), 0, "cached read must not transfer a body");
        assert_eq!(counted(&pod, "HEAD"), 1, "cached read must still revalidate with a live HEAD");
        assert_eq!(clean.stats().unwrap().1, 1);
    }

    #[tokio::test]
    async fn weak_etag_bypasses_and_is_never_cached() {
        let pod = FixturePod::start(vec![("w.bin".into(), "WEAKBODY".into())]).unwrap();
        pod.set_etag("w.bin", "W/\"v1\"");
        let dir = CleanDir::new();
        let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("t".into()), 0, 0, None, Some(clean.clone())).unwrap();
        let handle = open_handle(&fs, "w.bin", libc::O_RDONLY).await;

        assert_eq!(handle.pread(0, 4).await.unwrap(), b"WEAK".to_vec());
        pod.reset_log();
        assert_eq!(handle.pread(0, 4).await.unwrap(), b"WEAK".to_vec());
        assert_eq!(counted(&pod, "GET"), 1, "weak ETag must bypass the cache and refetch");
        assert_eq!(clean.stats().unwrap().1, 0, "weak ETag must never be cached");
    }

    #[tokio::test]
    async fn empty_etag_bypasses_and_is_never_cached() {
        let pod = FixturePod::start(vec![("m.bin".into(), "MISSINGETAG".into())]).unwrap();
        pod.set_etag("m.bin", "");
        let dir = CleanDir::new();
        let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("t".into()), 0, 0, None, Some(clean.clone())).unwrap();
        let handle = open_handle(&fs, "m.bin", libc::O_RDONLY).await;

        assert_eq!(handle.pread(0, 4).await.unwrap(), b"MISS".to_vec());
        pod.reset_log();
        assert_eq!(handle.pread(0, 4).await.unwrap(), b"MISS".to_vec());
        assert_eq!(counted(&pod, "GET"), 1, "missing/empty ETag must bypass the cache");
        assert_eq!(clean.stats().unwrap().1, 0);
    }

    #[tokio::test]
    async fn etag_race_412_reacquires_current_version_once() {
        let pod = FixturePod::start(vec![("race.bin".into(), "OLDBODY0".into())]).unwrap();
        let dir = CleanDir::new();
        let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("t".into()), 0, 0, None, Some(clean.clone())).unwrap();
        let handle = open_handle(&fs, "race.bin", libc::O_RDONLY).await;

        // The next GET mutates the resource before If-Match is evaluated, so the
        // conditional fetch observed the old version and gets a strict 412.
        pod.change_next_get("race.bin", "NEWBODY1");
        pod.reset_log();
        assert_eq!(handle.pread(0, 8).await.unwrap(), b"NEWBODY1".to_vec());
        assert!(counted(&pod, "GET") <= 2, "at most one bounded fetch after reacquire");

        // The current version is cached; the next read is a pure hit.
        pod.reset_log();
        assert_eq!(handle.pread(0, 8).await.unwrap(), b"NEWBODY1".to_vec());
        assert_eq!(counted(&pod, "GET"), 0);
        assert_eq!(counted(&pod, "HEAD"), 1);
    }

    #[tokio::test]
    async fn truncated_range_response_is_not_cached() {
        let pod = FixturePod::start(vec![("trunc.bin".into(), "TRUNCATED_BODY".into())]).unwrap();
        let dir = CleanDir::new();
        let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("t".into()), 0, 0, None, Some(clean.clone())).unwrap();
        let handle = open_handle(&fs, "trunc.bin", libc::O_RDONLY).await;

        pod.drop_next_read_body();
        assert!(handle.pread(0, 5).await.is_err(), "a truncated body must surface as an error");
        assert_eq!(clean.stats().unwrap().1, 0, "a truncated response must never be cached");
        assert_eq!(handle.pread(0, 5).await.unwrap(), b"TRUNC".to_vec());
        assert_eq!(clean.stats().unwrap().1, 1);
    }

    #[tokio::test]
    async fn restart_serves_persisted_hit_only_after_fresh_head() {
        let pod = FixturePod::start(vec![("persist.bin".into(), "PERSISTED_BODY".into())]).unwrap();
        let dir = CleanDir::new();
        {
            let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
            let fs = PodHttpFileSystem::new(&pod.pod_root, Some("t".into()), 0, 0, None, Some(clean)).unwrap();
            let handle = open_handle(&fs, "persist.bin", libc::O_RDONLY).await;
            pod.reset_log();
            assert_eq!(handle.pread(0, 4).await.unwrap(), b"PERS".to_vec());
            assert_eq!(counted(&pod, "GET"), 1);
        }
        // Fresh open (process restart): the persisted window is reused, but only
        // after a live HEAD revalidation.
        let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("t".into()), 0, 0, None, Some(clean)).unwrap();
        let handle = open_handle(&fs, "persist.bin", libc::O_RDONLY).await;
        pod.reset_log();
        assert_eq!(handle.pread(0, 4).await.unwrap(), b"PERS".to_vec());
        assert_eq!(counted(&pod, "GET"), 0, "persisted hit must not refetch a body");
        assert_eq!(counted(&pod, "HEAD"), 1, "persisted hit must revalidate with a live HEAD");
    }

    #[tokio::test]
    async fn dirty_overlay_edit_is_never_cached_and_remote_untouched() {
        let pod = FixturePod::start(vec![("dirty.bin".into(), "REMOTE_BASE".into())]).unwrap();
        let dir = CleanDir::new();
        let overlay = Arc::new(SessionOverlay::open(&dir.0, REMOTE_ROOT, "alice").unwrap());
        let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
        let fs = PodHttpFileSystem::new(&pod.pod_root, Some("t".into()), 0, 0, Some(overlay.clone()), Some(clean.clone())).unwrap();
        let handle = open_handle(&fs, "dirty.bin", libc::O_RDWR).await;

        handle.pwrite(0, b"LOCAL_EDIT").await.unwrap();
        assert_eq!(clean.stats().unwrap(), (0, 0), "a dirty edit must never populate the clean cache");
        assert_eq!(handle.pread(0, 10).await.unwrap(), b"LOCAL_EDIT".to_vec());
        assert_eq!(clean.stats().unwrap(), (0, 0), "dirty reads bypass the clean cache");
        assert_eq!(overlay.first_baseline("dirty.bin").unwrap(), Some(Some("\"v1\"".to_string())));
        assert_eq!(pod.body("dirty.bin").as_deref(), Some("REMOTE_BASE"), "remote stays untouched until commit");
    }

    #[tokio::test]
    async fn identity_and_canonical_pod_are_isolated_and_loopback_has_no_directory() {
        let dir = CleanDir::new();
        CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap();
        assert!(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "bob").is_err(), "another identity is rejected");
        assert!(CleanBodyCache::open(&dir.0, "https://node.example/bob/", "alice").is_err(), "another Pod is rejected");
        let local = CleanDir::new();
        assert!(CleanBodyCache::open(&local.0, "http://127.0.0.1:3000/alice/", "alice").unwrap().is_none());
        assert!(!local.0.join("clean-v1").exists(), "loopback-canonical Local must create no cache directory");
    }

    /// Minimal stateful Pod surface for the denial path: mode 0 serves a strong
    /// Owned, bounded stateful Pod surface: mode 0 serves a strong ETag and a
    /// 4-byte range, mode 1 answers every request with 403. The nonblocking
    /// listener plus `join_owned`/Drop guarantee the thread actually closes.
    struct ScriptedModePod {
        root: String,
        mode: Arc<AtomicU8>,
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }
    impl ScriptedModePod {
        fn start() -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let root = format!("http://127.0.0.1:{port}/pod/");
            let mode = Arc::new(AtomicU8::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let mode_thread = mode.clone();
            let stop_thread = stop.clone();
            let handle = std::thread::spawn(move || {
                while !stop_thread.load(AtomicOrdering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let current = mode_thread.load(AtomicOrdering::SeqCst);
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                            let mut reader = BufReader::new(stream.try_clone().unwrap());
                            let mut request_line = String::new();
                            if reader.read_line(&mut request_line).unwrap_or(0) == 0 { continue; }
                            let method = request_line.split_whitespace().next().unwrap_or("GET").to_string();
                            loop {
                                let mut header = String::new();
                                if reader.read_line(&mut header).unwrap_or(0) == 0 { break; }
                                if header.trim_end_matches(['\r', '\n']).is_empty() { break; }
                            }
                            if current == 1 {
                                let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                                continue;
                            }
                            if method == "HEAD" {
                                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 11\r\netag: \"v1\"\r\naccept-ranges: bytes\r\nconnection: close\r\n\r\n");
                            } else if method == "GET" {
                                let _ = stream.write_all(b"HTTP/1.1 206 Partial Content\r\ncontent-length: 4\r\netag: \"v1\"\r\ncontent-range: bytes 0-3/11\r\nconnection: close\r\n\r\n");
                                let _ = stream.write_all(b"BODY");
                            }
                        }
                        Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self { root, mode, stop, handle: Some(handle) }
        }
        fn root(&self) -> &str { &self.root }
        fn set_mode(&self, value: u8) { self.mode.store(value, AtomicOrdering::SeqCst); }
        fn join_owned(mut self) {
            self.stop.store(true, AtomicOrdering::SeqCst);
            if let Some(handle) = self.handle.take() {
                handle.join().expect("scripted mode server thread must close");
            }
        }
    }
    impl Drop for ScriptedModePod {
        fn drop(&mut self) {
            self.stop.store(true, AtomicOrdering::SeqCst);
            if let Some(handle) = self.handle.take() { let _ = handle.join(); }
        }
    }

    #[tokio::test]
    async fn denied_head_invalidates_and_never_serves_a_cached_body() {
        let pod = ScriptedModePod::start();
        let dir = CleanDir::new();
        let clean = Arc::new(CleanBodyCache::open(&dir.0, REMOTE_ROOT, "alice").unwrap().unwrap());
        let file = PodFile::new(
            Arc::new(PodClient::new(pod.root(), None).unwrap()),
            None,
            Some(clean.clone()),
            "x.bin".into(),
            Some("\"v1\"".into()),
            false,
            "application/octet-stream".into(),
        );

        assert_eq!(file.pread(0, 4).await.unwrap(), b"BODY".to_vec());
        assert_eq!(clean.stats().unwrap().1, 1, "the clean body is cached");

        pod.set_mode(1);
        assert!(file.pread(0, 4).await.is_err(), "a denied HEAD must surface the live error");
        assert_eq!(clean.stats().unwrap().1, 0, "a denied HEAD must invalidate the cached window");

        pod.set_mode(0);
        assert_eq!(file.pread(0, 4).await.unwrap(), b"BODY".to_vec(), "the old body is gone; a fresh fetch is required");
        pod.join_owned();
    }
}
