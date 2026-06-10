// Nextron dev config.
//
// Without this, nextron computes `retries = startupDelay / 500` for its
// waitForPort check, and the default startupDelay is 0 → 0 retries → it gives up
// before `next dev` has bound the port and prints
//   "Failed to start renderer process with port 8888 in 0ms"
// so the Electron window never launches. A non-zero startupDelay gives the
// renderer time to come up (30000ms / 500 = 60 retries, ~30s budget).
export default {
  startupDelay: 30000,
}
