// Command xpod-pod-fixture starts the in-process Pod HTTP fixture for the
// reproducible rclone experiments. It prints BASE_URL to stdout and serves
// until interrupted. Control endpoints live under /-/fixture/.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"xpod/rclone-pod/podfixture"
)

func main() {
	dir := flag.String("dir", "", "optional directory tree to seed into the fixture")
	pageCap := flag.Int("page-cap", 0, "force a server-side list page size (0 = server default)")
	incomplete := flag.String("incomplete", "", "directory key to force complete=false (e.g. /)")
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	flag.Parse()

	fx, err := podfixture.NewOn(*addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen: %v\n", err)
		os.Exit(1)
	}
	defer fx.Close()
	if *pageCap > 0 {
		fx.SetPageCap(*pageCap)
	}
	if *incomplete != "" {
		fx.SetIncompleteDir(*incomplete)
	}
	if *dir != "" {
		if err := fx.LoadDir(*dir); err != nil {
			fmt.Fprintf(os.Stderr, "load dir: %v\n", err)
			os.Exit(1)
		}
	}

	fmt.Printf("BASE_URL=%s\n", fx.BaseURL())
	fmt.Println("READY")
	_ = os.Stdout.Sync()

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
}
