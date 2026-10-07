// Command xpod-rclone is a fixed-version rclone v1.75.1 build with the
// experimental `podhttp` backend registered. It is a build fixture for the
// engine-selection study; it is not the production CLI and carries no support
// commitment.
package main

import (
	// rclone core command (provides cmd.Main).
	"github.com/rclone/rclone/cmd"

	// Backends used by the study. Only `local` (for fixture staging) and our
	// own `podhttp` are registered, keeping the build focused.
	_ "github.com/rclone/rclone/backend/local"

	// Commands exercised by the reproducible experiments.
	_ "github.com/rclone/rclone/cmd/cat"
	_ "github.com/rclone/rclone/cmd/copyto"
	_ "github.com/rclone/rclone/cmd/delete"
	_ "github.com/rclone/rclone/cmd/deletefile"
	_ "github.com/rclone/rclone/cmd/ls"
	_ "github.com/rclone/rclone/cmd/lsjson"
	_ "github.com/rclone/rclone/cmd/mkdir"
	_ "github.com/rclone/rclone/cmd/mount"
	_ "github.com/rclone/rclone/cmd/moveto"
	_ "github.com/rclone/rclone/cmd/nfsmount"
	_ "github.com/rclone/rclone/cmd/rmdir"
	_ "github.com/rclone/rclone/cmd/version"

	// The candidate backend under study.
	_ "xpod/rclone-pod/podhttp"
)

func main() {
	cmd.Main()
}
