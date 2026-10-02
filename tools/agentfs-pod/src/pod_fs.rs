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
            PodHttpFileSystem::new(&pod.pod_root, None, 0, 0, None).unwrap(),
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
        let mut headers = HeaderMap::new();
        headers.insert(IF_MATCH, HeaderValue::from_str(baseline).map_err(|error| SdkError::Internal(error.to_string()))?);
        let mut response = self.send(Method::GET, self.resource_url(path)?, headers, None).await?;
        if response.status() != StatusCode::OK || response.headers().get(ETAG).and_then(|v| v.to_str().ok()) != Some(baseline) {
            return Err(SdkError::Internal("lower content changed during copy-up".into()));
        }
        while let Some(chunk) = response.chunk().await.map_err(|error| SdkError::Internal(error.to_string()))? {
            output.write_all(&chunk).map_err(|error| SdkError::Internal(error.to_string()))?;
        }
        output.sync_all().map_err(|error| SdkError::Internal(error.to_string()))
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
        let url = self.resource_url(path)?;
        let request_range = |end: u64| {
            let mut headers = HeaderMap::new();
            headers.insert(RANGE, HeaderValue::from_str(&format!("bytes={offset}-{end}")).unwrap());
            headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
            headers
        };
        let response = self
            .send(Method::GET, url.clone(), request_range(offset + size.saturating_sub(1)), None)
            .await?;
        // A strict server answers 416 when the requested end crosses EOF. Only
        // an offset at/after the resource total is a normal EOF; otherwise clamp
        // to the real size and retry.
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
                return Ok((Vec::new(), false));
            }
            self.send(Method::GET, url, request_range(total.saturating_sub(1)), None).await?
        } else {
            response
        };
        if response.status() == StatusCode::NOT_FOUND {
            return Err(SdkError::Fs(FsError::NotFound));
        }
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
            // A read entirely past EOF is a normal short read, not an error.
            return Ok((Vec::new(), false));
        }
        if !response.status().is_success() {
            return Err(SdkError::Internal(format!("range GET {path} failed: {}", response.status())));
        }
        let partial = response.status() == StatusCode::PARTIAL_CONTENT;
        let content_range = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .await
            .map_err(|error| SdkError::Internal(format!("reading range of {path} failed: {error}")))?;
        if partial || content_range.is_some() {
            if let Some(content_range) = &content_range {
                let start = content_range
                    .strip_prefix("bytes ")
                    .and_then(|value| value.split('-').next())
                    .and_then(|value| value.parse::<u64>().ok());
                if start != Some(offset) {
                    return Err(SdkError::Internal(format!(
                        "range response for {path} started at {start:?}, expected {offset}"
                    )));
                }
            }
            return Ok((bytes.to_vec(), false));
        }
        let start = offset as usize;
        let end = (offset + size) as usize;
        let slice = bytes.get(start..end.min(bytes.len())).unwrap_or_default().to_vec();
        Ok((slice, true))
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
}

impl PodHttpFileSystem {
    pub fn new(
        base: &str,
        token: Option<String>,
        uid: u32,
        gid: u32,
        overlay: Option<Arc<SessionOverlay>>,
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
            path,
            version,
            writable,
            "application/octet-stream".to_string(),
        )) as BoxedFile)
    }

    async fn mkdir(&self, parent_ino: i64, name: &str, _mode: u32, _uid: u32, _gid: u32) -> SdkResult<Stats> {
        let parent = self.path_for(parent_ino).await?;
        let child = Self::child_path(&parent, name)?;
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
                let file = PodFile::new(self.shared.clone(), self.overlay.clone(), source.clone(), from_base.clone(), true, "application/octet-stream".into());
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
    path: String,
    content_type: String,
    writable: bool,
    version: Mutex<Option<String>>,
}

impl PodFile {
    fn new(
        shared: Arc<PodClient>,
        overlay: Option<Arc<SessionOverlay>>,
        path: String,
        version: Option<String>,
        writable: bool,
        content_type: String,
    ) -> Self {
        Self { shared, overlay, path, content_type, writable, version: Mutex::new(version) }
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
        let overlay = self.overlay.as_ref().unwrap();
        let observed = overlay.first_baseline(&self.path).map_err(|error| SdkError::Internal(error.to_string()))?;
        let baseline = self.base_version().await?;
        let mut seed = None;
        if observed.is_none() {
            let version = baseline.as_ref().ok_or_else(|| SdkError::Internal("copy-up requires an observed ETag".into()))?;
            if truncate != Some(0) {
                let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
                let location = overlay.dir().join(format!("seed-{}-{suffix}", std::process::id()));
                let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(&location)
                    .map_err(|error| SdkError::Internal(error.to_string()))?;
                let copied = self.shared.copy_to(&self.path, version, &mut file).await;
                if let Err(error) = copied { let _ = std::fs::remove_file(&location); return Err(error); }
                seed = Some(location);
            }
        }
        let result = overlay.edit(&self.path, seed.as_deref(), baseline, &self.content_type, offset, data, truncate)
            .map_err(|error| SdkError::Internal(error.to_string()));
        if let Some(seed) = seed { let _ = std::fs::remove_file(seed); }
        result
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
        let (data, _ignored) = self.shared.get_range(&self.path, offset, size).await?;
        Ok(data)
    }

    async fn pwrite(&self, offset: u64, data: &[u8]) -> SdkResult<()> {
        if !self.writable {
            return Err(SdkError::Fs(FsError::InvalidPath));
        }
        if self.overlay.is_some() { return self.edit_overlay(Some(offset), data, None).await; }
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
