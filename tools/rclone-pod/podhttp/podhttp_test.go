package podhttp

import (
	"context"
	"errors"
	"io"
	"net/url"
	"strings"
	"testing"
	"time"

	"xpod/rclone-pod/podfixture"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config/configmap"
	"github.com/rclone/rclone/fs/object"
	"github.com/rclone/rclone/fs/operations"
)

func newTestFs(t *testing.T, fx *podfixture.Fixture) *Fs {
	t.Helper()
	m := configmap.Simple{
		"url":           fx.BaseURL(),
		"metadata_path": podfixture.MetadataPath,
	}
	got, err := NewFs(context.Background(), "pod", "", m)
	if err != nil {
		t.Fatalf("NewFs: %v", err)
	}
	return got.(*Fs)
}

func staticInfo(remote string, size int64, f fs.Info) fs.ObjectInfo {
	return object.NewStaticObjectInfo(remote, time.Now(), size, true, nil, f)
}

func resourceGets(fx *podfixture.Fixture) int {
	n := 0
	for _, r := range fx.Requests() {
		if r.Method == "GET" && !strings.HasPrefix(r.Path, podfixture.MetadataPath) {
			n++
		}
	}
	return n
}

func TestNewFsFileRootReturnsErrorIsFile(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("aaa"), "text/plain")
	fx.PutFile("/sub/b.txt", []byte("bbb"), "text/plain")
	m := configmap.Simple{"url": fx.BaseURL(), "metadata_path": podfixture.MetadataPath}

	fileFs, err := NewFs(context.Background(), "pod", "a.txt", m)
	if !errors.Is(err, fs.ErrorIsFile) {
		t.Fatalf("file root: expected fs.ErrorIsFile, got %v", err)
	}
	if fileFs.Root() != "" {
		t.Fatalf("file root: Fs root = %q, want parent \"\"", fileFs.Root())
	}
	if _, err := fileFs.(*Fs).NewObject(context.Background(), "a.txt"); err != nil {
		t.Fatalf("file root: NewObject via parent Fs failed: %v", err)
	}
	subFileFs, err := NewFs(context.Background(), "pod", "sub/b.txt", m)
	if !errors.Is(err, fs.ErrorIsFile) || subFileFs.Root() != "sub" {
		t.Fatalf("nested file root: got root %q err %v, want sub/ErrorIsFile", subFileFs.Root(), err)
	}
	if _, err := subFileFs.(*Fs).NewObject(context.Background(), "b.txt"); err != nil {
		t.Fatalf("nested file root: NewObject failed: %v", err)
	}
	dirFs, err := NewFs(context.Background(), "pod", "sub", m)
	if err != nil {
		t.Fatalf("dir root: unexpected error %v", err)
	}
	if dirFs.Root() != "sub" {
		t.Fatalf("dir root: Fs root = %q, want sub", dirFs.Root())
	}
}

func TestListIsMetadataOnlyAndDirect(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("aaa"), "text/plain")
	fx.PutFile("/sub/b.txt", []byte("bbb"), "text/plain")
	fx.PutFile("/sub/deep/c.txt", []byte("ccc"), "text/plain")
	f := newTestFs(t, fx)

	entries, err := f.List(context.Background(), "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 direct children, got %d: %v", len(entries), entries)
	}
	names := map[string]string{}
	for _, e := range entries {
		kind := "file"
		if _, isDir := e.(fs.Directory); isDir {
			kind = "dir"
		}
		names[e.Remote()] = kind
	}
	if names["a.txt"] != "file" || names["sub"] != "dir" {
		t.Fatalf("unexpected direct children: %v", names)
	}
	if got := resourceGets(fx); got != 0 {
		t.Fatalf("metadata listing fetched %d resource bodies, want 0", got)
	}
}

func TestListRootCanonicalAndPathPrefixNoTrailingSlash(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/sub/b.txt", []byte("bbb"), "text/plain")
	f := newTestFs(t, fx)

	if _, err := f.List(context.Background(), "sub"); err != nil {
		t.Fatalf("List: %v", err)
	}
	found := false
	for _, r := range fx.Requests() {
		if !strings.HasPrefix(r.Path, podfixture.MetadataPath) {
			continue
		}
		q, _ := url.ParseQuery(r.Query)
		if q.Get("root") != fx.BaseURL() {
			t.Fatalf("list root = %q, want canonical %q", q.Get("root"), fx.BaseURL())
		}
		if q.Get("pathPrefix") != "sub" {
			t.Fatalf("list pathPrefix = %q, want \"sub\" (no trailing slash)", q.Get("pathPrefix"))
		}
		found = true
	}
	if !found {
		t.Fatal("no list request recorded")
	}
}

func TestListPaginatesThroughNextCursor(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	for _, name := range []string{"f1", "f2", "f3", "f4", "f5"} {
		fx.PutFile("/"+name, []byte(name), "text/plain")
	}
	fx.SetPageCap(2)
	f := newTestFs(t, fx)

	entries, err := f.List(context.Background(), "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 5 {
		t.Fatalf("expected 5 entries across pages, got %d", len(entries))
	}
	if n := fx.CountMethod("GET", podfixture.MetadataPath); n < 3 {
		t.Fatalf("expected >=3 paginated list requests, got %d", n)
	}
}

func TestIncompleteListingIsRefused(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("aaa"), "text/plain")
	fx.SetIncompleteDir("/")
	f := newTestFs(t, fx)

	_, err := f.List(context.Background(), "")
	if !errors.Is(err, ErrIncompleteListing) {
		t.Fatalf("expected ErrIncompleteListing, got %v", err)
	}
}

func TestNewObjectMetadata(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	etag := fx.PutFile("/a.txt", []byte("hello"), "text/plain")
	fx.PutFile("/sub/b.txt", []byte("bbb"), "text/plain")
	f := newTestFs(t, fx)

	obj, err := f.NewObject(context.Background(), "a.txt")
	if err != nil {
		t.Fatalf("NewObject: %v", err)
	}
	if obj.Size() != 5 {
		t.Fatalf("size = %d, want 5", obj.Size())
	}
	pod := obj.(*Object)
	if pod.ETag() != etag {
		t.Fatalf("etag = %q, want %q", pod.ETag(), etag)
	}
	if pod.MimeType(context.Background()) != "text/plain" {
		t.Fatalf("mime = %q", pod.MimeType(context.Background()))
	}
	if _, err := f.NewObject(context.Background(), "sub"); !errors.Is(err, fs.ErrorIsDir) {
		t.Fatalf("expected ErrorIsDir for container, got %v", err)
	}
	if _, err := f.NewObject(context.Background(), "missing"); !errors.Is(err, fs.ErrorObjectNotFound) {
		t.Fatalf("expected ErrorObjectNotFound, got %v", err)
	}
	if got := resourceGets(fx); got != 0 {
		t.Fatalf("NewObject fetched %d bodies, want 0", got)
	}
}

func TestRangeReadTransfersOnlySlice(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("0123456789"), "text/plain")
	f := newTestFs(t, fx)

	obj, err := f.NewObject(context.Background(), "a.txt")
	if err != nil {
		t.Fatalf("NewObject: %v", err)
	}
	rc, err := obj.Open(context.Background(), &fs.RangeOption{Start: 2, End: 5})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = rc.Close() }()
	data, _ := io.ReadAll(rc)
	if string(data) != "2345" {
		t.Fatalf("range read = %q, want \"2345\"", string(data))
	}
	for _, r := range fx.Requests() {
		if r.Method == "GET" && r.Path == "/a.txt" {
			if r.Range != "bytes=2-5" {
				t.Fatalf("Range header = %q, want bytes=2-5", r.Range)
			}
			if r.SentBytes != 4 {
				t.Fatalf("transferred %d bytes, want 4", r.SentBytes)
			}
			return
		}
	}
	t.Fatal("no GET request for /a.txt recorded")
}

func TestRangeFallbackWhenServerIgnoresRange(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("0123456789"), "text/plain")
	fx.SetIgnoreRange(true)
	f := newTestFs(t, fx)

	obj, err := f.NewObject(context.Background(), "a.txt")
	if err != nil {
		t.Fatalf("NewObject: %v", err)
	}
	rc, err := obj.Open(context.Background(), &fs.RangeOption{Start: 6, End: 8})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() { _ = rc.Close() }()
	data, _ := io.ReadAll(rc)
	if string(data) != "678" {
		t.Fatalf("sliced fallback = %q, want \"678\"", string(data))
	}
}

func TestPutCreateUsesIfNoneMatch(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	f := newTestFs(t, fx)

	if _, err := f.Put(context.Background(), strings.NewReader("new"), staticInfo("a.txt", 3, f)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if got, _ := fx.Read("/a.txt"); got != "new" {
		t.Fatalf("content = %q, want new", got)
	}
	for _, r := range fx.Requests() {
		if r.Method == "PUT" && r.Path == "/a.txt" {
			if r.IfNoneMatch != "*" {
				t.Fatalf("create PUT If-None-Match = %q, want *", r.IfNoneMatch)
			}
			return
		}
	}
	t.Fatal("no PUT recorded")
}

// TestPutOverExistingIsConditional covers editor atomic-save, where rclone calls
// Put (not Update) over an existing target. Put must re-read the version and
// overwrite with If-Match, never unconditionally.
func TestPutOverExistingIsConditional(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("existing"), "text/plain")
	f := newTestFs(t, fx)

	if _, err := f.Put(context.Background(), strings.NewReader("new"), staticInfo("a.txt", 3, f)); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if got, _ := fx.Read("/a.txt"); got != "new" {
		t.Fatalf("content = %q, want new", got)
	}
	sawCreate, sawConditional := false, false
	for _, r := range fx.Requests() {
		if r.Method != "PUT" || r.Path != "/a.txt" {
			continue
		}
		if r.IfNoneMatch == "*" {
			sawCreate = true
		}
		if r.IfMatch != "" {
			sawConditional = true
		}
	}
	if !sawCreate || !sawConditional {
		t.Fatalf("expected create attempt then conditional overwrite; sawCreate=%v sawConditional=%v", sawCreate, sawConditional)
	}
}

func TestPutOverExistingConflictPreserves(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("existing"), "text/plain")
	fx.SetRejectIfMatch(true)
	f := newTestFs(t, fx)

	_, err := f.Put(context.Background(), strings.NewReader("new"), staticInfo("a.txt", 3, f))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
	if got, _ := fx.Read("/a.txt"); got != "existing" {
		t.Fatalf("existing content was overwritten: %q", got)
	}
}

func TestConditionalOverwriteStaleIsRefused(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("orig"), "text/plain")
	f := newTestFs(t, fx)
	obj, err := f.NewObject(context.Background(), "a.txt")
	if err != nil {
		t.Fatalf("NewObject: %v", err)
	}
	fx.PutFile("/a.txt", []byte("external"), "text/plain") // another client writes

	err = obj.Update(context.Background(), strings.NewReader("mine"), staticInfo("a.txt", 4, f))
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
	if got, _ := fx.Read("/a.txt"); got != "external" {
		t.Fatalf("stale overwrite clobbered remote: %q", got)
	}
	for _, r := range fx.Requests() {
		if r.Method == "PUT" && r.Path == "/a.txt" {
			if r.IfMatch == "" {
				t.Fatalf("overwrite PUT had no If-Match baseline")
			}
			return
		}
	}
	t.Fatal("no PUT recorded")
}

func TestDeleteWithoutBaselineIsRefused(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("data"), "text/plain")
	fx.SetNoEtag(true)
	f := newTestFs(t, fx)
	obj := &Object{fs: f, remote: "a.txt", url: f.resourceURL("a.txt")}

	err := obj.Remove(context.Background())
	if !errors.Is(err, ErrNoBaseline) {
		t.Fatalf("expected ErrNoBaseline, got %v", err)
	}
	if fx.CountMethod("DELETE", "/a.txt") != 0 {
		t.Fatal("unconditional DELETE was sent")
	}
	if _, ok := fx.Read("/a.txt"); !ok {
		t.Fatal("file disappeared despite refused delete")
	}
}

// TestListingSourcedObjectRefreshesBaseline proves the fix for the VFS path:
// an object obtained from a metadata listing has no ETag, but Update refreshes
// it via HEAD and still writes conditionally.
func TestListingSourcedObjectRefreshesBaseline(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("orig"), "text/plain")
	f := newTestFs(t, fx)

	entries, err := f.List(context.Background(), "")
	if err != nil || len(entries) != 1 {
		t.Fatalf("List: %v entries=%v", err, entries)
	}
	obj := entries[0].(*Object)
	if obj.ETag() != "" {
		t.Fatalf("listing object unexpectedly carried ETag %q", obj.ETag())
	}
	if err := obj.Update(context.Background(), strings.NewReader("mine"), staticInfo("a.txt", 4, f)); err != nil {
		t.Fatalf("Update after baseline refresh: %v", err)
	}
	if got, _ := fx.Read("/a.txt"); got != "mine" {
		t.Fatalf("content = %q, want mine", got)
	}
	for _, r := range fx.Requests() {
		if r.Method == "PUT" && r.Path == "/a.txt" && r.IfMatch == "" {
			t.Fatal("refreshed overwrite had no If-Match baseline")
		}
	}
}

func TestConditionalDeleteSucceeds(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/a.txt", []byte("data"), "text/plain")
	f := newTestFs(t, fx)
	obj, _ := f.NewObject(context.Background(), "a.txt")

	if err := obj.Remove(context.Background()); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, ok := fx.Read("/a.txt"); ok {
		t.Fatal("file still present after conditional delete")
	}
	for _, r := range fx.Requests() {
		if r.Method == "DELETE" && r.Path == "/a.txt" && r.IfMatch == "" {
			t.Fatal("DELETE had no If-Match baseline")
		}
	}
}

// TestRenameOverExistingConflictPreservesBoth is the executable counterexample
// to the WebDAV path. WebDAV implements Move, so rclone's operations.Move calls
// DeleteFile(destination) before moving. Our backend implements Copy (not Move),
// so a rename routes through conditional Copy (dst.Update) + conditional
// DeleteFile(src). When the conditional destination write fails, both the
// destination and the source must be preserved.
func TestRenameOverExistingConflictPreservesBoth(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/temp", []byte("TEMP"), "text/plain")
	fx.PutFile("/doc", []byte("DOC"), "text/plain")
	fx.SetRejectIfMatch(true) // another writer always wins the conditional write

	f := newTestFs(t, fx)
	src, err := f.NewObject(context.Background(), "temp")
	if err != nil {
		t.Fatalf("NewObject temp: %v", err)
	}
	dst, err := f.NewObject(context.Background(), "doc")
	if err != nil {
		t.Fatalf("NewObject doc: %v", err)
	}

	if _, err := operations.Move(context.Background(), f, dst, "doc", src); err == nil {
		t.Fatal("expected conflict from destination conditional write")
	}
	if got, _ := fx.Read("/doc"); got != "DOC" {
		t.Fatalf("destination was destroyed/overwritten: %q", got)
	}
	if got, _ := fx.Read("/temp"); got != "TEMP" {
		t.Fatalf("source was deleted on failed rename: %q", got)
	}
	if n := fx.CountMethod("DELETE", "/"); n != 0 {
		t.Fatalf("a DELETE was issued during the failed rename (%d times)", n)
	}
}

func TestRenameOverExistingSucceedsWithoutPreDeletingDestination(t *testing.T) {
	fx := podfixture.New()
	defer fx.Close()
	fx.PutFile("/temp", []byte("TEMP-NEW"), "text/plain")
	fx.PutFile("/doc", []byte("DOC-OLD"), "text/plain")
	f := newTestFs(t, fx)

	src, _ := f.NewObject(context.Background(), "temp")
	dst, _ := f.NewObject(context.Background(), "doc")
	if _, err := operations.Move(context.Background(), f, dst, "doc", src); err != nil {
		t.Fatalf("Move: %v", err)
	}
	if got, _ := fx.Read("/doc"); got != "TEMP-NEW" {
		t.Fatalf("doc = %q, want TEMP-NEW", got)
	}
	if _, ok := fx.Read("/temp"); ok {
		t.Fatal("source temp should have been removed")
	}
	if n := fx.CountMethod("DELETE", "/doc"); n != 0 {
		t.Fatalf("destination was deleted %d time(s) before/without replacement", n)
	}
	conditionalPut := false
	for _, r := range fx.Requests() {
		if r.Method == "PUT" && r.Path == "/doc" && (r.IfMatch != "" || r.IfNoneMatch != "") {
			conditionalPut = true
		}
	}
	if !conditionalPut {
		t.Fatal("destination overwrite was not conditional")
	}
}
