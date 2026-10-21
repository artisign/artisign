#!/usr/bin/env node
import { dispatch } from "./dispatch.js";
import { abortUpdateCheck } from "./update-notice.js";

dispatch(process.argv.slice(2), process.argv[1] ?? "")
  .then((code) => {
    // `start` may have set exitCode itself (daemon did not come up); do not overwrite it with 0.
    if (code !== 0) process.exitCode = code;
    abortUpdateCheck(); // a still-pending update check must not hold the process open
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
