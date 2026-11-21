/** The loopback shutdown endpoint (`artisign stop` on Windows) and the header carrying the per-start token from `daemon.lock`. */
export const SHUTDOWN_PATH = "/api/daemon/shutdown";
export const SHUTDOWN_TOKEN_HEADER = "x-artisign-shutdown-token";
