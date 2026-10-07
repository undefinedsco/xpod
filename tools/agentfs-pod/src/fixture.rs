//! Minimal in-process Pod HTTP fixture used by `selftest` and integration
//! tests. It records per-resource method usage so tests can prove readdir does
//! not fetch bodies and that Range reads only transfer the requested slice.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct AccessLogEntry {
    pub method: String,
    pub path: String,
    pub range: Option<String>,
    pub response_bytes: usize,
}

struct StoredFile {
    data: Vec<u8>,
    version: u64,
    content_type: String,
    is_dir: bool,
    response_link: Option<String>,
    etag_override: Option<String>,
}

impl StoredFile {
    fn etag(&self) -> String {
        self.etag_override.clone().unwrap_or_else(|| format!("\"v{}\"", self.version))
    }
    fn link_header(&self) -> String {
        let value = self.response_link.as_deref().unwrap_or(if self.is_dir {
            "<http://www.w3.org/ns/ldp#BasicContainer>; rel=\"type\""
        } else { "" });
        if value.is_empty() { String::new() } else { format!("link: {value}\r\n") }
    }
}

#[derive(Default)]
struct State {
    files: HashMap<String, StoredFile>,
    log: Vec<AccessLogEntry>,
    drop_next_mutation_receipt: bool,
    drop_receipt_method: Option<String>,
    #[cfg(test)]
    change_next_get: Option<(String, String)>,
    #[cfg(test)]
    drop_next_read_body: bool,
}

pub struct FixturePod {
    pub origin: String,
    pub pod_root: String,
    state: Arc<Mutex<State>>,
    next_version: Arc<AtomicU64>,
    shutdown: Arc<Mutex<bool>>,
}

impl FixturePod {
    pub fn start(files: Vec<(String, String)>) -> std::io::Result<Self> {
        let state = Arc::new(Mutex::new(State::default()));
        {
            let mut guard = state.lock().unwrap();
            for (path, content) in files {
                guard.files.insert(path, StoredFile { data: content.into_bytes(), version: 1, content_type: "text/plain".into(), is_dir: false, response_link: None, etag_override: None });
            }
        }
        let next_version = Arc::new(AtomicU64::new(2));
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let origin = format!("http://127.0.0.1:{port}");
        let pod_root = format!("{origin}/pod/");
        let shutdown = Arc::new(Mutex::new(false));

        let state_for_thread = state.clone();
        let versions_for_thread = next_version.clone();
        let shutdown_for_thread = shutdown.clone();
        std::thread::spawn(move || {
            loop {
                if *shutdown_for_thread.lock().unwrap() {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let state = state_for_thread.clone();
                        let versions = versions_for_thread.clone();
                        std::thread::spawn(move || {
                            if let Err(error) = handle(stream, state, versions) {
                                #[cfg(test)]
                                eprintln!("fixture connection: {error:?}");
                                #[cfg(not(test))]
                                let _ = error;
                            }
                        });
                    }
                    Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self { origin, pod_root, state, next_version, shutdown })
    }

    pub fn log(&self) -> Vec<AccessLogEntry> {
        self.state.lock().unwrap().log.clone()
    }

    pub fn reset_log(&self) {
        self.state.lock().unwrap().log.clear();
    }

    pub fn mutate(&self, path: &str, content: &str) {
        let version = self.next_version.fetch_add(1, Ordering::SeqCst);
        self.state
            .lock()
            .unwrap()
            .files
            .insert(path.to_string(), StoredFile { data: content.as_bytes().to_vec(), version, content_type: "text/plain".into(), is_dir: false, response_link: None, etag_override: None });
    }

    #[cfg(test)]
    pub fn drop_next_mutation_receipt(&self) {
        self.state.lock().unwrap().drop_next_mutation_receipt = true;
    }

    #[cfg(test)]
    pub fn set_resource_link(&self, path: &str, link: &str) {
        self.state.lock().unwrap().files.get_mut(path).unwrap().response_link = Some(link.into());
    }

    #[cfg(test)]
    pub fn set_etag(&self, path: &str, etag: &str) {
        self.state.lock().unwrap().files.get_mut(path).unwrap().etag_override = Some(etag.into());
    }

    #[cfg(test)]
    pub fn change_next_get(&self, path: &str, content: &str) {
        self.state.lock().unwrap().change_next_get = Some((path.into(), content.into()));
    }

    #[cfg(test)]
    pub fn drop_next_read_body(&self) { self.state.lock().unwrap().drop_next_read_body = true; }

    #[cfg(test)]
    pub fn drop_next_delete_receipt(&self) {
        let mut state = self.state.lock().unwrap();
        state.drop_next_mutation_receipt = true;
        state.drop_receipt_method = Some("DELETE".into());
    }

    pub fn body(&self, path: &str) -> Option<String> {
        self.state.lock().unwrap().files.get(path).map(|file| String::from_utf8_lossy(&file.data).to_string())
    }

    pub fn version(&self, path: &str) -> Option<u64> {
        self.state.lock().unwrap().files.get(path).map(|file| file.version)
    }
}

impl Drop for FixturePod {
    fn drop(&mut self) {
        *self.shutdown.lock().unwrap() = true;
    }
}

fn handle(mut stream: TcpStream, state: Arc<Mutex<State>>, versions: Arc<AtomicU64>) -> std::io::Result<()> {
    // BSD/macOS accepted sockets inherit the listener's nonblocking mode.
    // This per-connection thread uses blocking BufRead/read_exact, so reset it
    // explicitly before parsing; otherwise a split request spuriously closes.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET").to_string();
    let target = parts.next().unwrap_or("/").to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body)?;
    }

    let (raw_path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), Some(query.to_string())),
        None => (target.clone(), None),
    };

    let response = route(&method, &raw_path, query.as_deref(), &headers, &body, &state, &versions);

    if matches!(method.as_str(), "PUT" | "DELETE") && (200..300).contains(&response.status) {
        let mut guard = state.lock().unwrap();
        if guard.drop_next_mutation_receipt && guard.drop_receipt_method.as_deref().is_none_or(|expected| expected == method) {
            guard.drop_next_mutation_receipt = false;
            guard.drop_receipt_method = None;
            return Ok(());
        }
    }

    let length_header = if response.extra_headers.to_ascii_lowercase().contains("content-length:") {
        String::new()
    } else { format!("content-length: {}\r\n", response.body.len()) };
    let header = format!(
        "HTTP/1.1 {} {}\r\nconnection: close\r\n{}{}\r\n",
        response.status,
        response.reason,
        length_header,
        response.extra_headers
    );
    stream.write_all(header.as_bytes())?;
    #[cfg(test)]
    if method == "GET" && (200..300).contains(&response.status) {
        let mut guard = state.lock().unwrap();
        if guard.drop_next_read_body {
            guard.drop_next_read_body = false;
            stream.write_all(&response.body[..response.body.len().min(1)])?;
            return Ok(());
        }
    }
    if method != "HEAD" {
        stream.write_all(&response.body)?;
    }
    stream.flush()?;
    Ok(())
}

struct Response {
    status: u16,
    reason: &'static str,
    body: Vec<u8>,
    extra_headers: String,
}

fn route(
    method: &str,
    path: &str,
    query: Option<&str>,
    headers: &HashMap<String, String>,
    body: &[u8],
    state: &Arc<Mutex<State>>,
    versions: &Arc<AtomicU64>,
) -> Response {
    if path.ends_with("/-/agent-directory/list") {
        let prefix = query
            .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("pathPrefix=")))
            .map(|value| percent_decode(value))
            .unwrap_or_default();
        let guard = state.lock().unwrap();
        let mut entries: Vec<String> = guard
            .files
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .map(|(key, file)| {
                format!(
                    "{{\"path\":\"{}\",\"type\":\"file\",\"size\":{}}}",
                    key, file.data.len()
                )
            })
            .collect();
        entries.sort();
        let payload = format!("{{\"entries\":[{}],\"complete\":true}}", entries.join(","));
        return Response {
            status: 200,
            reason: "OK",
            body: payload.into_bytes(),
            extra_headers: "content-type: application/json\r\n".to_string(),
        };
    }

    let relative = percent_decode(path.strip_prefix("/pod/").unwrap_or(path));
    let version = versions.load(Ordering::SeqCst);
    let mut guard = state.lock().unwrap();

    match method {
        "HEAD" => {
            guard.log.push(AccessLogEntry { method: method.to_string(), path: path.to_string(), range: None, response_bytes: 0 });
            match guard.files.get(&relative) {
                Some(file) => Response {
                    status: 200,
                    reason: "OK",
                    body: Vec::new(),
                    extra_headers: format!(
                        "content-length: {}\r\netag: {}\r\ncontent-type: {}\r\naccept-ranges: bytes\r\n{}",
                        file.data.len(),
                        file.etag(),
                        file.content_type,
                        file.link_header(),
                    ),
                },
                None => Response { status: 404, reason: "Not Found", body: Vec::new(), extra_headers: String::new() },
            }
        }
        "GET" => {
            #[cfg(test)]
            if let Some((target, content)) = guard.change_next_get.take() {
                if target == relative {
                    let file = guard.files.get_mut(&relative).unwrap();
                    file.data = content.into_bytes();
                    file.version = versions.fetch_add(1, Ordering::SeqCst);
                } else { guard.change_next_get = Some((target, content)); }
            }
            if let Some(expected) = headers.get("if-match") {
                if guard.files.get(&relative).map(StoredFile::etag).as_ref() != Some(expected) {
                    return Response { status: 412, reason: "Precondition Failed", body: Vec::new(), extra_headers: String::new() };
                }
            }
            let range = headers.get("range").cloned();
            let prepared = guard.files.get(&relative).map(|file| {
                let data = &file.data;
                let (slice, extra) = if let Some(range) = range.as_deref() {
                    let bounds = range.strip_prefix("bytes=").unwrap_or("");
                    let mut pieces = bounds.split('-');
                    let start: usize = pieces.next().and_then(|value| value.parse().ok()).unwrap_or(0);
                    let end: usize = pieces
                        .next()
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(data.len().saturating_sub(1));
                    let end = end.min(data.len().saturating_sub(1));
                    let slice = data.get(start..=end).unwrap_or_default().to_vec();
                    (slice, format!("content-range: bytes {}-{}/{}\r\n", start, end, data.len()))
                } else {
                    (data.clone(), String::new())
                };
                (slice, extra, file.etag(), file.content_type.clone(), file.link_header())
            });
            let Some((slice, extra, version, content_type, link)) = prepared else {
                guard.log.push(AccessLogEntry { method: method.to_string(), path: path.to_string(), range, response_bytes: 0 });
                return Response { status: 404, reason: "Not Found", body: Vec::new(), extra_headers: String::new() };
            };
            let status = if range.is_some() { 206 } else { 200 };
            guard.log.push(AccessLogEntry { method: method.to_string(), path: path.to_string(), range, response_bytes: slice.len() });
            Response {
                status,
                reason: if status == 206 { "Partial Content" } else { "OK" },
                body: slice,
                extra_headers: format!("etag: {version}\r\ncontent-type: {content_type}\r\n{extra}{link}"),
            }
        }
        "PUT" => {
            let exists = guard.files.contains_key(&relative);
            if headers.get("if-none-match").map(String::as_str) == Some("*") && exists {
                guard.log.push(AccessLogEntry { method: method.to_string(), path: path.to_string(), range: None, response_bytes: 0 });
                return Response { status: 412, reason: "Precondition Failed", body: Vec::new(), extra_headers: String::new() };
            }
            if let Some(if_match) = headers.get("if-match") {
                let current = guard.files.get(&relative).map(|file| format!("\"v{}\"", file.version));
                if current.as_deref() != Some(if_match.as_str()) {
                    guard.log.push(AccessLogEntry { method: method.to_string(), path: path.to_string(), range: None, response_bytes: 0 });
                    return Response { status: 412, reason: "Precondition Failed", body: Vec::new(), extra_headers: String::new() };
                }
            }
            let new_version = versions.fetch_add(1, Ordering::SeqCst);
            let _ = version;
            guard.files.insert(relative.clone(), StoredFile {
                data: body.to_vec(), version: new_version,
                content_type: headers.get("content-type").cloned().unwrap_or_else(|| "application/octet-stream".into()),
                is_dir: headers.get("link").is_some_and(|link| link.contains("#BasicContainer>")),
                response_link: None,
                etag_override: None,
            });
            guard.log.push(AccessLogEntry { method: method.to_string(), path: path.to_string(), range: None, response_bytes: 0 });
            Response {
                status: if exists { 200 } else { 201 },
                reason: if exists { "OK" } else { "Created" },
                body: Vec::new(),
                extra_headers: format!("etag: \"v{new_version}\"\r\n"),
            }
        }
        "DELETE" => {
            if let Some(if_match) = headers.get("if-match") {
                let current = guard.files.get(&relative).map(|file| format!("\"v{}\"", file.version));
                if current.as_deref() != Some(if_match.as_str()) {
                    guard.log.push(AccessLogEntry { method: method.to_string(), path: path.to_string(), range: None, response_bytes: 0 });
                    return Response { status: 412, reason: "Precondition Failed", body: Vec::new(), extra_headers: String::new() };
                }
            }
            let removed = guard.files.remove(&relative).is_some();
            guard.log.push(AccessLogEntry { method: method.to_string(), path: path.to_string(), range: None, response_bytes: 0 });
            Response {
                status: if removed { 204 } else { 404 },
                reason: if removed { "No Content" } else { "Not Found" },
                body: Vec::new(),
                extra_headers: String::new(),
            }
        }
        _ => Response { status: 405, reason: "Method Not Allowed", body: Vec::new(), extra_headers: String::new() },
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_request_is_parsed_on_an_inherited_nonblocking_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        // The first fragment deliberately has no line terminator.
        client.write_all(b"HEAD /pod/missing HTTP/1.1").unwrap();
        let (stream, _) = listener.accept().unwrap();
        stream.set_nonblocking(true).unwrap();
        let thread = std::thread::spawn(move || handle(stream,
            Arc::new(Mutex::new(State::default())), Arc::new(AtomicU64::new(1))));
        std::thread::sleep(std::time::Duration::from_millis(50));
        client.write_all(b"\r\nHost: localhost\r\n\r\n").unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        thread.join().unwrap().unwrap();
        assert!(response.starts_with("HTTP/1.1 404 Not Found\r\n"), "{response}");
    }
}
