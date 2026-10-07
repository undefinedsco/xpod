// Package podhttp implements a minimal rclone backend for the Xpod Pod HTTP
// surface: metadata enumeration through the authenticated Agent Directory
// sidecar (`/-/agent-directory/list`) and content access through the plain
// resource URLs (GET/HEAD with HTTP Range, conditional PUT/DELETE).
//
// Design constraints (see docs/xpod-cli-engine-selection.md):
//   - The Pod is the content authority. No persistent clean-body cache lives
//     in this backend; objects carry only metadata (size, modtime, ETag).
//   - Listing is metadata only and never fetches file bodies.
//   - Reads use HTTP Range and only transfer the requested slice.
//   - Writes are conditional: create uses `If-None-Match: *`, overwrite and
//     delete use `If-Match: <ETag>`. A missing baseline refuses the write
//     instead of falling back to an unconditional one.
//   - `Move`/`Copy` are deliberately NOT implemented. That forces rclone's
//     rename path through conditional Update + conditional Remove instead of
//     `operations.Move`'s unconditional `DeleteFile(destination)`.
package podhttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/config/configstruct"
	"github.com/rclone/rclone/fs/hash"
	"github.com/rclone/rclone/fs/object"
)

const (
	defaultMetadataPath = "/-/agent-directory"
	defaultListLimit    = 1000
	maxListPages        = 500
	maxJSONBytes        = 32 << 20
)

// Errors surfaced to rclone callers.
var (
	// ErrConflict is returned for HTTP 409/412 (stale or missing baseline).
	ErrConflict = errors.New("podhttp: resource version conflict")
	// ErrNoBaseline is returned when a conditional write has no ETag baseline.
	ErrNoBaseline = errors.New("podhttp: refusing unconditional write without a version baseline")
	// ErrIncompleteListing is returned when the server reports incomplete scan
	// coverage, so a partial directory view is never presented as complete.
	ErrIncompleteListing = errors.New("podhttp: directory listing coverage is incomplete")
)

// Options describes the backend configuration.
type Options struct {
	URL          string      `config:"url"`
	Token        string      `config:"token"`
	MetadataPath string      `config:"metadata_path"`
	Timeout      fs.Duration `config:"timeout"`
}

func init() {
	fs.Register(&fs.RegInfo{
		Name:        "podhttp",
		Description: "Xpod Pod over authenticated HTTP (agent-directory listing + conditional resource writes)",
		NewFs:       NewFs,
		Options: fs.Options{
			{
				Name:     "url",
				Help:     "Pod container URL that is the mount root. Must be an absolute same-origin URL ending in '/'.",
				Required: true,
			},
			{
				Name:     "token",
				Help:     "Prototype bearer token. NOT a production auth path; production must inject the CLI's existing authenticated request pipeline.",
				Default:  "",
				Advanced: true,
			},
			{
				Name:     "metadata_path",
				Help:     "Agent Directory sidecar path used for metadata-only enumeration.",
				Default:  defaultMetadataPath,
				Advanced: true,
			},
			{
				Name:     "timeout",
				Help:     "HTTP request timeout.",
				Default:  fs.Duration(30 * time.Second),
				Advanced: true,
			},
		},
	})
}

// Fs represents the Pod root.
type Fs struct {
	name     string
	root     string
	opt      Options
	features *fs.Features
	client   *http.Client
	base     string // canonical container URL ending in '/'
	origin   string // server origin URL ending in '/' (sidecar lives here, not under the container)
}

// Object represents a Pod resource.
type Object struct {
	fs      *Fs
	remote  string
	url     string
	size    int64
	modTime time.Time
	etag    string
	mime    string
}

// entry is one direct child produced from the metadata listing.
type entry struct {
	name   string // name relative to the listed directory
	remote string // path relative to the Fs root
	isDir  bool
	size   int64
	mime   string
}

// listResponse mirrors the Agent Directory `list` payload (subset we consume).
type listResponse struct {
	Root       string      `json:"root"`
	Entries    []listEntry `json:"entries"`
	Truncated  bool        `json:"truncated"`
	Complete   bool        `json:"complete"`
	Scanned    int         `json:"scanned"`
	NextCursor string      `json:"nextCursor,omitempty"`
}

type listEntry struct {
	Path        string `json:"path"`
	URL         string `json:"url"`
	Type        string `json:"type"`
	ContentType string `json:"contentType,omitempty"`
	Size        *int64 `json:"size,omitempty"`
}

// NewFs constructs an Fs from the config map and the rclone root.
func NewFs(ctx context.Context, name, root string, m configmap.Mapper) (fs.Fs, error) {
	opt := new(Options)
	if err := configstruct.Set(m, opt); err != nil {
		return nil, err
	}
	if opt.URL == "" {
		return nil, errors.New("podhttp: option 'url' is required")
	}
	parsed, err := url.Parse(opt.URL)
	if err != nil {
		return nil, fmt.Errorf("podhttp: invalid url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("podhttp: url must be http(s), got %q", parsed.Scheme)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return nil, errors.New("podhttp: url must not carry query, fragment or userinfo")
	}
	if !strings.HasSuffix(parsed.Path, "/") {
		parsed.Path += "/"
	}
	originBase := parsed.String()
	// The Agent Directory sidecar is addressed from the server origin, matching
	// `new URL('/-/agent-directory/...', baseUrl)` in the production client: an
	// absolute sidecar path overrides any container path prefix.
	sidecarOrigin := parsed.Scheme + "://" + parsed.Host + "/"
	root = strings.Trim(root, "/")
	base := originBase
	if root != "" {
		base += encodePath(root) + "/"
	}
	timeout := time.Duration(opt.Timeout)
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if opt.MetadataPath == "" {
		opt.MetadataPath = defaultMetadataPath
	}
	opt.MetadataPath = "/" + strings.Trim(opt.MetadataPath, "/")

	f := &Fs{
		name:   name,
		root:   root,
		opt:    *opt,
		client: &http.Client{Timeout: timeout},
		base:   base,
		origin: sidecarOrigin,
	}
	f.features = (&fs.Features{}).Fill(ctx, f)

	// rclone requires NewFs to return fs.ErrorIsFile with an Fs pointing at the
	// parent when the given root is actually an object, otherwise file-level
	// commands (`cat`, `copyto`, `deletefile`, `moveto`) treat the object as a
	// directory and fail.
	if root != "" {
		probe := &Fs{name: name, root: "", opt: f.opt, client: f.client, base: originBase, origin: sidecarOrigin}
		parent := path.Dir(root)
		if parent == "." {
			parent = ""
		}
		if children, err := probe.listDirect(ctx, parent); err == nil {
			for _, c := range children {
				if c.name == path.Base(root) && !c.isDir {
					parentBase := originBase
					if parent != "" {
						parentBase += encodePath(parent) + "/"
					}
					f.base = parentBase
					f.root = parent
					return f, fs.ErrorIsFile
				}
			}
		}
	}
	return f, nil
}

// Name returns the remote name.
func (f *Fs) Name() string { return f.name }

// Root returns the remote root.
func (f *Fs) Root() string { return f.root }

// String describes the Fs.
func (f *Fs) String() string { return fmt.Sprintf("Pod HTTP root '%s'", f.base) }

// Precision returns the modtime precision. Nanoseconds forces dirty writeback
// comparisons to see a difference rather than skipping the conditional PUT.
func (f *Fs) Precision() time.Duration { return time.Nanosecond }

// Hashes reports that no content hash is available from the Pod surface.
func (f *Fs) Hashes() hash.Set { return hash.Set(hash.None) }

// Features returns the optional features.
func (f *Fs) Features() *fs.Features { return f.features }

// --- path helpers ---

func encodePath(remote string) string {
	parts := strings.Split(remote, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

func (f *Fs) resourceURL(remote string) string {
	if remote == "" {
		return f.base
	}
	return f.base + encodePath(remote)
}

func (f *Fs) containerURL(remote string) string {
	if remote == "" {
		return f.base
	}
	return f.base + encodePath(remote) + "/"
}

// --- metadata listing ---

// listDirect returns the direct children of dir (relative to the Fs root).
//
// It pages through nextCursor and refuses to return a partial view: a
// truncated page without a cursor or `complete:false` becomes an error.
func (f *Fs) listDirect(ctx context.Context, dir string) ([]entry, error) {
	scopeRoot := f.base
	pathPrefix := strings.Trim(dir, "/")

	var out []entry
	cursor := ""
	seen := map[string]bool{}
	for page := 0; ; page++ {
		if page > maxListPages {
			return nil, fmt.Errorf("%w: exceeded %d pages", ErrIncompleteListing, maxListPages)
		}
		resp, err := f.fetchList(ctx, scopeRoot, pathPrefix, cursor)
		if err != nil {
			return nil, err
		}
		for _, e := range resp.Entries {
			rel := strings.TrimPrefix(e.Path, "/")
			name, ok := directChildName(pathPrefix, rel)
			if !ok {
				// Scope selector is prefix based, so it can match siblings with
				// a shared prefix (e.g. "sub" matches "subx"). Drop non-children.
				continue
			}
			isDir := e.Type == "container" || strings.HasSuffix(rel, "/")
			child := entry{
				name:   name,
				remote: path.Join(dir, name),
				isDir:  isDir,
				mime:   e.ContentType,
			}
			if e.Size != nil {
				child.size = *e.Size
			}
			key := child.remote
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, child)
		}
		if !resp.Complete {
			return nil, fmt.Errorf("%w: server reported complete=false for %q", ErrIncompleteListing, dir)
		}
		if resp.Truncated {
			if resp.NextCursor == "" {
				return nil, fmt.Errorf("%w: truncated page without nextCursor for %q", ErrIncompleteListing, dir)
			}
			cursor = resp.NextCursor
			continue
		}
		return out, nil
	}
}

// directChildName returns the child name of rel if rel is a direct child of
// parent (a relative path without trailing slash), else ok=false.
func directChildName(parent, rel string) (string, bool) {
	rel = strings.TrimSuffix(rel, "/")
	if parent != "" {
		if !strings.HasPrefix(rel, parent+"/") {
			return "", false
		}
		rel = strings.TrimPrefix(rel, parent+"/")
	}
	if rel == "" || strings.Contains(rel, "/") {
		return "", false
	}
	return rel, true
}

func (f *Fs) fetchList(ctx context.Context, scopeRoot, pathPrefix, cursor string) (*listResponse, error) {
	// The Agent Directory sidecar is mounted at the server origin (absolute
	// path), independent of the container scope passed in `root`.
	target := strings.TrimSuffix(f.origin, "/") + f.opt.MetadataPath + "/list"
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("root", scopeRoot)
	if pathPrefix != "" {
		q.Set("pathPrefix", pathPrefix)
	}
	q.Set("limit", strconv.Itoa(defaultListLimit))
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	f.applyAuth(req)
	req.Header.Set("Accept", "application/json")

	res, err := f.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return nil, fmt.Errorf("podhttp: list %s: HTTP %d: %s", u.String(), res.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload listResponse
	dec := json.NewDecoder(io.LimitReader(res.Body, maxJSONBytes))
	if err := dec.Decode(&payload); err != nil {
		return nil, fmt.Errorf("podhttp: decode list response: %w", err)
	}
	return &payload, nil
}

// --- Fs interface ---

// List returns the direct children of dir.
func (f *Fs) List(ctx context.Context, dir string) (fs.DirEntries, error) {
	dir = strings.Trim(dir, "/")
	children, err := f.listDirect(ctx, dir)
	if err != nil {
		return nil, err
	}
	entries := make(fs.DirEntries, 0, len(children))
	for _, c := range children {
		if c.isDir {
			entries = append(entries, fs.NewDir(c.remote, time.Time{}))
			continue
		}
		entries = append(entries, f.objectFromEntry(c))
	}
	return entries, nil
}

func (f *Fs) objectFromEntry(c entry) *Object {
	return &Object{
		fs:     f,
		remote: c.remote,
		url:    f.resourceURL(c.remote),
		size:   c.size,
		mime:   c.mime,
	}
}

// NewObject finds the object at remote. Returns fs.ErrorIsDir for containers.
func (f *Fs) NewObject(ctx context.Context, remote string) (fs.Object, error) {
	remote = strings.Trim(remote, "/")
	if remote == "" {
		return nil, fs.ErrorIsDir
	}
	parent := path.Dir(remote)
	if parent == "." {
		parent = ""
	}
	name := path.Base(remote)
	children, err := f.listDirect(ctx, parent)
	if err != nil {
		return nil, err
	}
	for _, c := range children {
		if c.name != name {
			continue
		}
		if c.isDir {
			return nil, fs.ErrorIsDir
		}
		obj := f.objectFromEntry(c)
		if err := obj.head(ctx); err != nil {
			return nil, err
		}
		return obj, nil
	}
	return nil, fs.ErrorObjectNotFound
}

// Put creates a new object, or conditionally overwrites an existing one.
//
// It first attempts `If-None-Match: *` (create). If the target already exists it
// re-reads the current ETag via HEAD and retries with `If-Match`. Both branches
// use a version condition; a missing version refuses the write rather than
// clobbering. This is required for editor atomic-save, where rclone's VFS may
// call Put (not Update) after renaming a temp file over an existing target.
func (f *Fs) Put(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) (fs.Object, error) {
	remote := strings.Trim(src.Remote(), "/")
	data, err := io.ReadAll(in)
	if err != nil {
		return nil, err
	}
	obj := &Object{fs: f, remote: remote, url: f.resourceURL(remote), size: int64(len(data)), mime: fs.MimeType(ctx, src)}

	res, err := f.putOnce(ctx, obj, data, "*")
	if err != nil {
		return nil, err
	}
	if res.StatusCode == http.StatusPreconditionFailed || res.StatusCode == http.StatusConflict {
		_ = res.Body.Close()
		// Target exists (or changed). Re-read the current version and retry
		// conditionally; never fall back to an unconditional write.
		if headErr := obj.head(ctx); headErr != nil {
			if errors.Is(headErr, fs.ErrorObjectNotFound) {
				return nil, fmt.Errorf("%w: create raced deletion for %s", ErrConflict, remote)
			}
			return nil, headErr
		}
		if obj.etag == "" {
			return nil, fmt.Errorf("%w: %s", ErrNoBaseline, remote)
		}
		res, err = f.putOnce(ctx, obj, data, obj.etag)
		if err != nil {
			return nil, err
		}
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusPreconditionFailed || res.StatusCode == http.StatusConflict:
		return nil, fmt.Errorf("%w: write %s", ErrConflict, remote)
	case res.StatusCode >= 200 && res.StatusCode < 300:
		obj.captureEtag(res)
		if err := obj.head(ctx); err != nil {
			return nil, err
		}
		return obj, nil
	default:
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return nil, fmt.Errorf("podhttp: PUT %s: HTTP %d: %s", remote, res.StatusCode, strings.TrimSpace(string(body)))
	}
}

// putOnce issues a single PUT with the given validator: "*" for create-only, or
// an ETag for If-Match.
func (f *Fs) putOnce(ctx context.Context, obj *Object, data []byte, validator string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, obj.url, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	f.applyAuth(req)
	req.Header.Set("Content-Type", obj.mime)
	if validator == "*" {
		req.Header.Set("If-None-Match", "*")
	} else {
		req.Header.Set("If-Match", validator)
	}
	return f.client.Do(req)
}

// Copy implements server-side copy as a read + conditional write. It is
// deliberately provided while Move is not: rclone's VFS treats a backend with
// neither Move nor Copy as unable to rename at all, but a backend WITH Move
// triggers operations.Move's unconditional `DeleteFile(destination)` before the
// move. Providing Copy (and not Move) routes renames through
// conditional Copy(dst.Update) + conditional DeleteFile(src).
func (f *Fs) Copy(ctx context.Context, src fs.Object, remote string) (fs.Object, error) {
	srcObj, ok := src.(*Object)
	if !ok {
		return nil, fs.ErrorCantCopy
	}
	rc, err := srcObj.Open(ctx)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(rc)
	_ = rc.Close()
	if readErr != nil {
		return nil, readErr
	}
	info := object.NewStaticObjectInfo(remote, src.ModTime(ctx), int64(len(data)), true, nil, f)

	dst, err := f.NewObject(ctx, remote)
	switch {
	case errors.Is(err, fs.ErrorObjectNotFound):
		return f.Put(ctx, bytes.NewReader(data), info)
	case err != nil:
		return nil, err
	}
	dstObj := dst.(*Object)
	if err := dstObj.Update(ctx, bytes.NewReader(data), info); err != nil {
		return nil, err
	}
	return dstObj, nil
}

// Mkdir is best-effort: the Agent Directory protocol has no container-create
// verb. A PUT with an LDP container Link header is attempted; an "already
// exists" response is accepted.
func (f *Fs) Mkdir(ctx context.Context, dir string) error {
	dir = strings.Trim(dir, "/")
	if dir == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, f.containerURL(dir), nil)
	if err != nil {
		return err
	}
	f.applyAuth(req)
	req.Header.Set("Content-Type", "text/turtle")
	req.Header.Set("Link", `<http://www.w3.org/ns/ldp#Container>; rel="type"`)
	req.Header.Set("If-None-Match", "*")
	res, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	switch res.StatusCode {
	case http.StatusCreated, http.StatusNoContent, http.StatusOK,
		http.StatusMethodNotAllowed, http.StatusConflict, http.StatusPreconditionFailed:
		return nil
	default:
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("podhttp: MKCOL %s: HTTP %d: %s", dir, res.StatusCode, strings.TrimSpace(string(body)))
	}
}

// Rmdir deletes a container. This surface has no version baseline for
// containers, so the delete is inherently unconditional; recorded as a gap.
func (f *Fs) Rmdir(ctx context.Context, dir string) error {
	dir = strings.Trim(dir, "/")
	if dir == "" {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, f.containerURL(dir), nil)
	if err != nil {
		return err
	}
	f.applyAuth(req)
	res, err := f.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusNotFound:
		return fs.ErrorDirNotFound
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return nil
	default:
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("podhttp: RMDIR %s: HTTP %d: %s", dir, res.StatusCode, strings.TrimSpace(string(body)))
	}
}

func (f *Fs) applyAuth(req *http.Request) {
	if f.opt.Token != "" {
		req.Header.Set("Authorization", "Bearer "+f.opt.Token)
	}
}

// --- Object interface ---

func (o *Object) captureEtag(res *http.Response) {
	if etag := res.Header.Get("ETag"); etag != "" {
		o.etag = etag
	}
	if ct := res.Header.Get("Content-Type"); ct != "" {
		o.mime = ct
	}
}

// head refreshes metadata from a HEAD request (never the body).
func (o *Object) head(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, o.url, nil)
	if err != nil {
		return err
	}
	o.fs.applyAuth(req)
	res, err := o.fs.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusNotFound {
		return fs.ErrorObjectNotFound
	}
	if res.StatusCode >= 400 {
		return fmt.Errorf("podhttp: HEAD %s: HTTP %d", o.remote, res.StatusCode)
	}
	if cl := res.Header.Get("Content-Length"); cl != "" {
		if n, perr := strconv.ParseInt(cl, 10, 64); perr == nil {
			o.size = n
		}
	}
	if lm := res.Header.Get("Last-Modified"); lm != "" {
		if t, perr := http.ParseTime(lm); perr == nil {
			o.modTime = t
		}
	}
	o.captureEtag(res)
	if o.mime == "" {
		o.mime = res.Header.Get("Content-Type")
	}
	return nil
}

// Fs returns the parent Fs.
func (o *Object) Fs() fs.Info { return o.fs }

// String returns a description.
func (o *Object) String() string { return o.remote }

// Remote returns the path relative to the Fs root.
func (o *Object) Remote() string { return o.remote }

// ModTime returns the modification time.
func (o *Object) ModTime(ctx context.Context) time.Time { return o.modTime }

// Size returns the object size.
func (o *Object) Size() int64 { return o.size }

// MimeType returns the content type if known.
func (o *Object) MimeType(ctx context.Context) string { return o.mime }

// ETag returns the Pod version token used for conditional writes.
func (o *Object) ETag() string { return o.etag }

// Hash is unsupported (no content checksum on the Pod surface).
func (o *Object) Hash(ctx context.Context, t hash.Type) (string, error) {
	return "", hash.ErrUnsupported
}

// Storable reports the object is storable.
func (o *Object) Storable() bool { return true }

// SetModTime is a no-op: the Pod surface has no cheap modtime write and the
// backend does not use modtime as a version token.
func (o *Object) SetModTime(ctx context.Context, modTime time.Time) error {
	o.modTime = modTime
	return nil
}

// Open reads the object, honouring OpenOption ranges.
func (o *Object) Open(ctx context.Context, options ...fs.OpenOption) (io.ReadCloser, error) {
	var offset, limit int64 = 0, -1
	for _, option := range options {
		switch x := option.(type) {
		case *fs.RangeOption:
			offset, limit = x.Decode(o.size)
		case *fs.SeekOption:
			offset = x.Offset
		default:
			if option.Mandatory() {
				fs.Logf(o, "podhttp: unsupported mandatory open option: %v", option)
			}
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.url, nil)
	if err != nil {
		return nil, err
	}
	o.fs.applyAuth(req)
	if offset > 0 || limit >= 0 {
		end := ""
		if limit >= 0 {
			end = strconv.FormatInt(offset+limit-1, 10)
		}
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%s", offset, end))
	}
	res, err := o.fs.client.Do(req)
	if err != nil {
		return nil, err
	}
	switch {
	case res.StatusCode == http.StatusNotFound:
		_ = res.Body.Close()
		return nil, fs.ErrorObjectNotFound
	case res.StatusCode == http.StatusPartialContent:
		if err := validateContentRange(res.Header.Get("Content-Range"), offset); err != nil {
			_ = res.Body.Close()
			return nil, err
		}
		return res.Body, nil
	case res.StatusCode >= 200 && res.StatusCode < 300:
		// Server ignored Range: emulate the slice locally without buffering more
		// than the request needs.
		if offset == 0 && limit < 0 {
			return res.Body, nil
		}
		return newSlicedReader(res.Body, offset, limit), nil
	default:
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()
		return nil, fmt.Errorf("podhttp: GET %s: HTTP %d: %s", o.remote, res.StatusCode, strings.TrimSpace(string(body)))
	}
}

func validateContentRange(header string, offset int64) error {
	if header == "" {
		return nil
	}
	header = strings.TrimSpace(header)
	if !strings.HasPrefix(header, "bytes ") {
		return fmt.Errorf("podhttp: unexpected Content-Range %q", header)
	}
	spec := strings.TrimPrefix(header, "bytes ")
	dash := strings.IndexByte(spec, '-')
	slash := strings.IndexByte(spec, '/')
	if dash <= 0 || slash <= dash {
		return fmt.Errorf("podhttp: malformed Content-Range %q", header)
	}
	start, err := strconv.ParseInt(spec[:dash], 10, 64)
	if err != nil {
		return fmt.Errorf("podhttp: malformed Content-Range %q", header)
	}
	if start != offset {
		return fmt.Errorf("podhttp: Range response started at %d, requested %d", start, offset)
	}
	return nil
}

// ensureBaseline refreshes a missing ETag via HEAD so that listing-sourced or
// VFS-sourced objects can still perform a conditional write. It never turns a
// missing version into an unconditional write.
func (o *Object) ensureBaseline(ctx context.Context) error {
	if o.etag != "" {
		return nil
	}
	return o.head(ctx)
}

// Update overwrites the object conditionally with If-Match.
func (o *Object) Update(ctx context.Context, in io.Reader, src fs.ObjectInfo, options ...fs.OpenOption) error {
	if err := o.ensureBaseline(ctx); err != nil {
		return err
	}
	if o.etag == "" {
		return fmt.Errorf("%w: %s", ErrNoBaseline, o.remote)
	}
	data, err := io.ReadAll(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, o.url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	o.fs.applyAuth(req)
	req.Header.Set("Content-Type", fs.MimeType(ctx, src))
	req.Header.Set("If-Match", o.etag)
	res, err := o.fs.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusPreconditionFailed || res.StatusCode == http.StatusConflict:
		return fmt.Errorf("%w: overwrite %s", ErrConflict, o.remote)
	case res.StatusCode >= 200 && res.StatusCode < 300:
		o.size = int64(len(data))
		o.captureEtag(res)
		return o.head(ctx)
	default:
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("podhttp: PUT %s: HTTP %d: %s", o.remote, res.StatusCode, strings.TrimSpace(string(body)))
	}
}

// Remove deletes the object conditionally with If-Match.
func (o *Object) Remove(ctx context.Context) error {
	if err := o.ensureBaseline(ctx); err != nil {
		return err
	}
	if o.etag == "" {
		return fmt.Errorf("%w: %s", ErrNoBaseline, o.remote)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, o.url, nil)
	if err != nil {
		return err
	}
	o.fs.applyAuth(req)
	req.Header.Set("If-Match", o.etag)
	res, err := o.fs.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusNotFound:
		return fs.ErrorObjectNotFound
	case res.StatusCode == http.StatusPreconditionFailed || res.StatusCode == http.StatusConflict:
		return fmt.Errorf("%w: delete %s", ErrConflict, o.remote)
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return nil
	default:
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return fmt.Errorf("podhttp: DELETE %s: HTTP %d: %s", o.remote, res.StatusCode, strings.TrimSpace(string(body)))
	}
}

// slicedReader emulates an HTTP Range slice when the server ignored Range and
// returned the full body (HTTP 200).
type slicedReader struct {
	rc        io.ReadCloser
	skip      int64
	remaining int64 // -1 means until EOF
	discarded bool
}

func newSlicedReader(rc io.ReadCloser, offset, limit int64) io.ReadCloser {
	return &slicedReader{rc: rc, skip: offset, remaining: limit}
}

func (s *slicedReader) Read(p []byte) (int, error) {
	if !s.discarded {
		if s.skip > 0 {
			n, err := io.CopyN(io.Discard, s.rc, s.skip)
			s.skip -= n
			if err != nil {
				return 0, err
			}
		}
		s.discarded = true
	}
	if s.remaining == 0 {
		return 0, io.EOF
	}
	if s.remaining > 0 && int64(len(p)) > s.remaining {
		p = p[:s.remaining]
	}
	n, err := s.rc.Read(p)
	if s.remaining > 0 {
		s.remaining -= int64(n)
	}
	return n, err
}

func (s *slicedReader) Close() error { return s.rc.Close() }

// --- interface assertions ---

var (
	_ fs.Fs        = (*Fs)(nil)
	_ fs.Copier    = (*Fs)(nil)
	_ fs.Object    = (*Object)(nil)
	_ fs.MimeTyper = (*Object)(nil)
)
