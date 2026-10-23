#!/bin/sh
# Runs Artisign from this checkout instead of the globally installed `artisign`.
# Both share ~/.artisign/ and port 4711, so `start` first stops whichever one is
# running. Project dirs are resolved against the caller's cwd.
set -e

root=$(cd "$(dirname "$0")" && pwd)
cli="$root/dist/cli/index.js"

case "${1:-}" in
  start)
    shift
    npm run build --prefix "$root"
    node "$cli" stop
    node "$cli" start "$@"
    ;;
  stop)
    node "$cli" stop
    ;;
  status)
    node "$cli" status
    ;;
  *)
    echo "usage: $0 start [--port N] [--no-open] [dir...] | stop | status" >&2
    exit 1
    ;;
esac
