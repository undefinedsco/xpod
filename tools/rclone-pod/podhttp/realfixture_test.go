package podhttp

import (
	"context"
	"os"
	"testing"

	"github.com/rclone/rclone/fs/config/configmap"
)

// TestRealAgentDirectoryHandlerList runs the Go backend's List() against the
// real TypeScript AgentDirectoryHttpHandler fixture (not the Go emulation). It
// is skipped unless XPOD_REAL_FIXTURE_URL is set by the launcher script, which
// starts the real handler and passes its podRoot.
func TestRealAgentDirectoryHandlerList(t *testing.T) {
	base := os.Getenv("XPOD_REAL_FIXTURE_URL")
	if base == "" {
		t.Skip("XPOD_REAL_FIXTURE_URL not set; run tools/rclone-pod/scripts/real-handler-contract.mjs")
	}
	m := configmap.Simple{"url": base, "metadata_path": "/-/agent-directory"}
	got, err := NewFs(context.Background(), "pod", "", m)
	if err != nil {
		t.Fatalf("NewFs: %v", err)
	}
	f := got.(*Fs)

	entries, err := f.List(context.Background(), "")
	if err != nil {
		t.Fatalf("List root: %v", err)
	}
	names := map[string]string{}
	for _, e := range entries {
		kind := "file"
		if _, isDir := e.(interface{ Items() int64 }); isDir {
			kind = "dir"
		}
		names[e.Remote()] = kind
	}
	if names["alpha.txt"] != "file" {
		t.Fatalf("expected file alpha.txt in real handler listing, got %v", names)
	}
	if names["sub"] != "dir" {
		t.Fatalf("expected dir sub in real handler listing, got %v", names)
	}
	for name := range names {
		if name == "secret.txt" || name == "denied/secret.txt" {
			t.Fatalf("denied resource leaked into listing: %v", names)
		}
	}
	// The denied child must not appear when scoping into its container.
	deniedEntries, err := f.List(context.Background(), "denied")
	if err != nil {
		t.Fatalf("List denied: %v", err)
	}
	if len(deniedEntries) != 0 {
		t.Fatalf("denied child leaked via pathPrefix: %v", deniedEntries)
	}

	// pathPrefix scoping must return the sub-directory's children and use the
	// canonical same-origin root.
	subEntries, err := f.List(context.Background(), "sub")
	if err != nil {
		t.Fatalf("List sub: %v", err)
	}
	foundBeta := false
	for _, e := range subEntries {
		if e.Remote() == "sub/beta.txt" {
			foundBeta = true
		}
	}
	if !foundBeta {
		t.Fatalf("expected sub/beta.txt via pathPrefix listing, got %v", subEntries)
	}
}
