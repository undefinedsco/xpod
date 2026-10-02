// Package podfixture is an in-process HTTP server used by the reproducible
// rclone backend experiments. It faithfully implements the two contracts the
// `podhttp` backend depends on:
//
//   - the Agent Directory `list` endpoint (canonical same-origin root, no
//     trailing slash in pathPrefix, nextCursor pagination, complete coverage);
//   - LDP-style resource semantics (HEAD metadata, HTTP Range GET, conditional
//     PUT/DELETE with ETag baselines).
//
// It emulates the CSS Pod surface for study purposes; it is not the real CSS
// and it is not part of any production image.
package podfixture

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MetadataPath is the Agent Directory sidecar path.
const MetadataPath = "/-/agent-directory"

// Recorded is one HTTP request observed by the fixture.
type Recorded struct {
	Method      string `json:"method"`
	Path        string `json:"path"`
	Query       string `json:"query,omitempty"`
	IfMatch     string `json:"ifMatch,omitempty"`
	IfNoneMatch string `json:"ifNoneMatch,omitempty"`
	Range       string `json:"range,omitempty"`
	Status      int    `json:"status"`
	SentBytes   int    `json:"sentBytes"`
}

type node struct {
	data    []byte
	etag    string
	modTime time.Time
	isDir   bool
	ctype   string
}

// Fixture is the running HTTP fixture.
type Fixture struct {
	mu             sync.Mutex
	logMu          sync.Mutex
	nodes          map[string]*node
	log            []Recorded
	version        int
	pageCap        int
	incompleteDirs map[string]bool
	ignoreRange    bool
	noEtag         bool
	rejectIfMatch  bool
	server         *httptest.Server
	httpServer     *http.Server
	fixedBase      string
}

// New starts a fixture server on a random loopback port.
func New() *Fixture {
	f := &Fixture{
		nodes:          map[string]*node{},
		incompleteDirs: map[string]bool{},
	}
	f.nodes["/"] = &node{isDir: true, modTime: time.Now()}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

// NewOn starts a fixture server bound to a specific address (e.g. "0.0.0.0:8080").
func NewOn(addr string) (*Fixture, error) {
	f := &Fixture{
		nodes:          map[string]*node{},
		incompleteDirs: map[string]bool{},
	}
	f.nodes["/"] = &node{isDir: true, modTime: time.Now()}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	f.httpServer = &http.Server{Handler: http.HandlerFunc(f.serve)}
	go func() { _ = f.httpServer.Serve(ln) }()
	f.fixedBase = "http://" + ln.Addr().String() + "/"
	return f, nil
}

// Close shuts the fixture down.
func (f *Fixture) Close() {
	if f.server != nil {
		f.server.Close()
	}
	if f.httpServer != nil {
		_ = f.httpServer.Close()
	}
}

// BaseURL returns the fixture container root URL ending in '/'.
func (f *Fixture) BaseURL() string {
	if f.fixedBase != "" {
		return f.fixedBase
	}
	return f.server.URL + "/"
}

// ServerURL returns the fixture origin.
func (f *Fixture) ServerURL() string {
	if f.fixedBase != "" {
		return strings.TrimSuffix(f.fixedBase, "/")
	}
	return f.server.URL
}

// SetPageCap forces a server-side page size so pagination is exercised.
func (f *Fixture) SetPageCap(n int) { f.mu.Lock(); f.pageCap = n; f.mu.Unlock() }

// SetIncompleteDir forces complete=false for a directory key (e.g. "/").
func (f *Fixture) SetIncompleteDir(dir string) {
	f.mu.Lock()
	f.incompleteDirs[dir] = true
	f.mu.Unlock()
}

// SetIgnoreRange makes GET always return 200 with the full body.
func (f *Fixture) SetIgnoreRange(v bool) { f.mu.Lock(); f.ignoreRange = v; f.mu.Unlock() }

// SetNoEtag hides the ETag header on resource metadata responses.
func (f *Fixture) SetNoEtag(v bool) { f.mu.Lock(); f.noEtag = v; f.mu.Unlock() }

// SetRejectIfMatch makes every If-Match PUT fail with 412 (simulates a writer
// that always wins the race).
func (f *Fixture) SetRejectIfMatch(v bool) { f.mu.Lock(); f.rejectIfMatch = v; f.mu.Unlock() }

func (f *Fixture) nextEtag() string {
	f.version++
	return fmt.Sprintf("\"v%d\"", f.version)
}

func (f *Fixture) ensureDir(key string) {
	if !strings.HasSuffix(key, "/") {
		key += "/"
	}
	if _, ok := f.nodes[key]; ok {
		return
	}
	parent := path.Dir(strings.TrimSuffix(key, "/"))
	if parent != "/" && parent != "." {
		f.ensureDir(parent)
	}
	if _, ok := f.nodes["/"]; !ok {
		f.nodes["/"] = &node{isDir: true, modTime: time.Now()}
	}
	f.nodes[key] = &node{isDir: true, modTime: time.Now()}
}

// PutFile unconditionally creates or replaces a file (fixture-side).
func (f *Fixture) PutFile(p string, data []byte, ctype string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.putFileLocked(p, data, ctype)
}

func (f *Fixture) putFileLocked(p string, data []byte, ctype string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	f.ensureDir(path.Dir(p))
	n := &node{data: data, etag: f.nextEtag(), modTime: time.Now(), ctype: ctype}
	f.nodes[p] = n
	return n.etag
}

// DeleteFile removes a file (fixture-side, unconditional).
func (f *Fixture) DeleteFile(p string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.nodes, p)
}

// Read returns a file body.
func (f *Fixture) Read(p string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.nodes[p]
	if !ok || n.isDir {
		return "", false
	}
	return string(n.data), true
}

// EtagOf returns a file's current ETag.
func (f *Fixture) EtagOf(p string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if n, ok := f.nodes[p]; ok {
		return n.etag
	}
	return ""
}

// Requests returns a copy of the recorded request log.
func (f *Fixture) Requests() []Recorded {
	f.logMu.Lock()
	defer f.logMu.Unlock()
	out := make([]Recorded, len(f.log))
	copy(out, f.log)
	return out
}

// CountMethod counts requests by method and path substring.
func (f *Fixture) CountMethod(method, substr string) int {
	n := 0
	for _, r := range f.Requests() {
		if r.Method == method && strings.Contains(r.Path, substr) {
			n++
		}
	}
	return n
}

// LoadDir seeds the fixture from a local directory tree.
func (f *Fixture) LoadDir(root string) error {
	return filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		ctype := "application/octet-stream"
		switch strings.ToLower(filepath.Ext(p)) {
		case ".txt", ".md":
			ctype = "text/plain"
		case ".json":
			ctype = "application/json"
		case ".ttl":
			ctype = "text/turtle"
		}
		f.PutFile("/"+filepath.ToSlash(rel), data, ctype)
		return nil
	})
}

func (f *Fixture) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasPrefix(r.URL.Path, "/-/fixture/"):
		f.serveControl(w, r)
	case strings.HasPrefix(r.URL.Path, MetadataPath):
		f.serveList(w, r)
	default:
		f.serveResource(w, r)
	}
}

func (f *Fixture) serveControl(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/-/fixture/log":
		body, _ := json.Marshal(f.Requests())
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	case "/-/fixture/mutate":
		p := r.URL.Query().Get("path")
		data := r.URL.Query().Get("data")
		etag := f.PutFile(p, []byte(data), "text/plain")
		w.Header().Set("ETag", etag)
		_, _ = w.Write([]byte(etag))
	case "/-/fixture/etag":
		_, _ = w.Write([]byte(f.EtagOf(r.URL.Query().Get("path"))))
	case "/-/fixture/read":
		v, ok := f.Read(r.URL.Query().Get("path"))
		if !ok {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(v))
	default:
		http.Error(w, "unknown fixture endpoint", http.StatusNotFound)
	}
}

func (f *Fixture) record(r *http.Request, status, sent int) {
	f.logMu.Lock()
	defer f.logMu.Unlock()
	f.log = append(f.log, Recorded{
		Method:      r.Method,
		Path:        r.URL.Path,
		Query:       r.URL.RawQuery,
		IfMatch:     r.Header.Get("If-Match"),
		IfNoneMatch: r.Header.Get("If-None-Match"),
		Range:       r.Header.Get("Range"),
		Status:      status,
		SentBytes:   sent,
	})
}

func (f *Fixture) serveList(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if strings.TrimPrefix(r.URL.Path, MetadataPath) != "/list" {
		http.Error(w, `{"error":true}`, http.StatusNotFound)
		return
	}
	q := r.URL.Query()
	rawRoot := q.Get("root")
	rootURL, err := url.Parse(rawRoot)
	if err != nil || rootURL.Scheme == "" || rootURL.Host == "" {
		f.jsonError(w, http.StatusBadRequest, "root must be absolute")
		return
	}
	if rootURL.Host != r.Host {
		f.jsonError(w, http.StatusForbidden, "root must be same origin")
		return
	}
	if !strings.HasSuffix(rootURL.Path, "/") {
		f.jsonError(w, http.StatusBadRequest, "root must end with /")
		return
	}
	pathPrefix := q.Get("pathPrefix")
	if strings.HasSuffix(pathPrefix, "/") || strings.Contains(pathPrefix, "//") {
		f.jsonError(w, http.StatusBadRequest, "pathPrefix must not have trailing slash")
		return
	}
	limit := 1000
	if v := q.Get("limit"); v != "" {
		if n, e := strconv.Atoi(v); e == nil && n > 0 {
			limit = n
		}
	}
	if f.pageCap > 0 && f.pageCap < limit {
		limit = f.pageCap
	}
	offset := 0
	if c := q.Get("cursor"); c != "" {
		if b, e := base64.RawURLEncoding.DecodeString(c); e == nil {
			var cur struct{ Offset int }
			_ = json.Unmarshal(b, &cur)
			offset = cur.Offset
		}
	}

	rootKey := rootURL.Path
	type item struct {
		Path        string `json:"path"`
		URL         string `json:"url"`
		Type        string `json:"type"`
		ContentType string `json:"contentType,omitempty"`
		Size        *int64 `json:"size,omitempty"`
	}
	var items []item
	for key, n := range f.nodes {
		if !strings.HasPrefix(key, rootKey) || key == rootKey {
			continue
		}
		relative := strings.TrimPrefix(key, rootKey)
		if pathPrefix != "" && !strings.HasPrefix(relative, pathPrefix) {
			continue
		}
		it := item{Path: relative, URL: f.ServerURL() + key, Type: "file"}
		if n.isDir {
			it.Type = "container"
		} else {
			size := int64(len(n.data))
			it.Size = &size
			if n.ctype != "" {
				it.ContentType = n.ctype
			}
		}
		items = append(items, it)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Path < items[j].Path })

	page := items
	truncated := false
	nextCursor := ""
	if offset < len(items) {
		end := offset + limit
		if end > len(items) {
			end = len(items)
		}
		page = items[offset:end]
		if end < len(items) {
			truncated = true
			b, _ := json.Marshal(struct{ Offset int }{end})
			nextCursor = base64.RawURLEncoding.EncodeToString(b)
		}
	} else {
		page = nil
	}
	complete := !f.incompleteDirs[rootKey]
	payload := map[string]any{
		"root":      rawRoot,
		"entries":   page,
		"truncated": truncated,
		"complete":  complete,
		"scanned":   len(page),
	}
	if nextCursor != "" {
		payload["nextCursor"] = nextCursor
	}
	body, _ := json.Marshal(payload)
	f.record(r, http.StatusOK, len(body))
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

func (f *Fixture) serveResource(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := r.URL.Path
	n, exists := f.nodes[key]
	switch r.Method {
	case http.MethodHead:
		if !exists || n.isDir {
			f.record(r, http.StatusNotFound, 0)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.writeFileHeaders(w, n)
		f.record(r, http.StatusOK, 0)
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		if !exists || n.isDir {
			f.record(r, http.StatusNotFound, 0)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		f.serveGet(w, r, n)
	case http.MethodPut:
		f.servePut(w, r, key)
	case http.MethodDelete:
		f.serveDelete(w, r, key, n, exists)
	default:
		f.record(r, http.StatusMethodNotAllowed, 0)
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (f *Fixture) writeFileHeaders(w http.ResponseWriter, n *node) {
	w.Header().Set("Content-Length", strconv.Itoa(len(n.data)))
	if !f.noEtag {
		w.Header().Set("ETag", n.etag)
	}
	w.Header().Set("Last-Modified", n.modTime.UTC().Format(http.TimeFormat))
	if n.ctype != "" {
		w.Header().Set("Content-Type", n.ctype)
	}
}

func (f *Fixture) serveGet(w http.ResponseWriter, r *http.Request, n *node) {
	total := len(n.data)
	if rng := r.Header.Get("Range"); rng != "" && !f.ignoreRange {
		if start, end, ok := parseRange(rng, total); ok {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
			w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
			w.Header().Set("ETag", n.etag)
			w.WriteHeader(http.StatusPartialContent)
			written, _ := w.Write(n.data[start : end+1])
			f.record(r, http.StatusPartialContent, written)
			return
		}
	}
	w.Header().Set("Content-Length", strconv.Itoa(total))
	w.Header().Set("ETag", n.etag)
	w.WriteHeader(http.StatusOK)
	written, _ := w.Write(n.data)
	f.record(r, http.StatusOK, written)
}

func parseRange(header string, total int) (int, int, bool) {
	header = strings.TrimSpace(header)
	if !strings.HasPrefix(header, "bytes=") {
		return 0, 0, false
	}
	parts := strings.SplitN(strings.TrimPrefix(header, "bytes="), "-", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	start, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	end := total - 1
	if parts[1] != "" {
		if e, err := strconv.Atoi(parts[1]); err == nil {
			end = e
		}
	}
	if start < 0 {
		start = 0
	}
	if start > end || start >= total {
		return 0, 0, false
	}
	if end >= total {
		end = total - 1
	}
	return start, end, true
}

func (f *Fixture) servePut(w http.ResponseWriter, r *http.Request, key string) {
	body, _ := io.ReadAll(r.Body)
	if strings.HasSuffix(key, "/") {
		_, existed := f.nodes[key]
		f.ensureDir(key)
		status := http.StatusCreated
		if existed {
			status = http.StatusNoContent
		}
		f.record(r, status, len(body))
		w.WriteHeader(status)
		return
	}
	if r.Header.Get("If-None-Match") == "" && r.Header.Get("If-Match") == "" {
		f.record(r, http.StatusBadRequest, len(body))
		http.Error(w, "fixture: unconditional PUT rejected", http.StatusBadRequest)
		return
	}
	existing, exists := f.nodes[key]
	if inm := r.Header.Get("If-None-Match"); inm == "*" {
		if exists {
			f.record(r, http.StatusPreconditionFailed, len(body))
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		etag := f.putFileLocked(key, body, r.Header.Get("Content-Type"))
		w.Header().Set("ETag", etag)
		f.record(r, http.StatusCreated, len(body))
		w.WriteHeader(http.StatusCreated)
		return
	}
	if im := r.Header.Get("If-Match"); im != "" {
		if f.rejectIfMatch || !exists || existing.isDir || existing.etag != im {
			f.record(r, http.StatusPreconditionFailed, len(body))
			w.WriteHeader(http.StatusPreconditionFailed)
			return
		}
		etag := f.putFileLocked(key, body, r.Header.Get("Content-Type"))
		w.Header().Set("ETag", etag)
		f.record(r, http.StatusNoContent, len(body))
		w.WriteHeader(http.StatusNoContent)
		return
	}
	f.record(r, http.StatusPreconditionRequired, len(body))
	w.WriteHeader(http.StatusPreconditionRequired)
}

func (f *Fixture) serveDelete(w http.ResponseWriter, r *http.Request, key string, n *node, exists bool) {
	if strings.HasSuffix(key, "/") {
		if !exists {
			f.record(r, http.StatusNotFound, 0)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if !f.dirEmptyLocked(key) {
			f.record(r, http.StatusConflict, 0)
			w.WriteHeader(http.StatusConflict)
			return
		}
		delete(f.nodes, key)
		f.record(r, http.StatusNoContent, 0)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Header.Get("If-Match") == "" {
		f.record(r, http.StatusBadRequest, 0)
		http.Error(w, "fixture: unconditional DELETE rejected", http.StatusBadRequest)
		return
	}
	if !exists {
		f.record(r, http.StatusNotFound, 0)
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if n.etag != r.Header.Get("If-Match") {
		f.record(r, http.StatusPreconditionFailed, 0)
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	delete(f.nodes, key)
	f.record(r, http.StatusNoContent, 0)
	w.WriteHeader(http.StatusNoContent)
}

func (f *Fixture) dirEmptyLocked(dir string) bool {
	for key := range f.nodes {
		if key == dir {
			continue
		}
		if strings.HasPrefix(key, dir) {
			return false
		}
	}
	return true
}

func (f *Fixture) jsonError(w http.ResponseWriter, status int, msg string) {
	body, _ := json.Marshal(map[string]any{"error": true, "code": "ERROR", "message": msg})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
