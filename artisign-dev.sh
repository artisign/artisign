#!/bin/sh
# Runs Artisign from this checkout instead of the globally installed `artisign`.
# With the default ARTISIGN_HOME both use ~/.artisign/ and the same port, so
# `start` first stops the one running there. Project dirs are resolved against
# the caller's cwd.
set -e

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cli="$root/dist/cli/index.js"

case "${1:-}" in
  start)
    shift
    npm run build --prefix "$root"
    node "$cli" stop
    node "$cli" start "$@"
    # A connected `artisign mcp` bridge of the installed version can respawn its
    # daemon between stop and start; `start` then just reports it as running.
    pid=$(node "$cli" status | sed -n 's/.*(pid \([0-9]*\),.*/\1/p')
    if ! ps -o command= -p "$pid" | grep -qF "$cli"; then
      echo "the running Artisign is not this checkout's build — close the AI tools connected to the installed one, then retry" >&2
      exit 1
    fi
    ;;
  stop | status)
    if [ ! -f "$cli" ]; then
      echo "not built yet — run: $0 start" >&2
      exit 1
    fi
    node "$cli" "$1"
    ;;
  *)
    echo "usage: $0 start [--port N] [--no-open] [dir...] | stop | status" >&2
    exit 1
    ;;
esac
