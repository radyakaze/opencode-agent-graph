/**
 * Tunable constants used across the dashboard server, plugin, and state.
 * Centralized here so the values are named, greppable, and tweakable in one place.
 */

/** Max bytes accepted by the `/events` POST endpoint. */
export const MAX_EVENT_BODY_BYTES = 256_000

/** How long without a heartbeat before a process is considered stale. */
export const STALE_PROCESS_CUTOFF_MS = 10_000

/** Heartbeat / stale-cleanup tick interval. */
export const STALE_TICK_INTERVAL_MS = 3_000

/** Heartbeat interval for this plugin process to the graph server. */
export const HEARTBEAT_INTERVAL_MS = 3_000

/** Minimum delay between attempts to elect ourselves as the active server. */
export const ELECTION_THROTTLE_MS = 2_000

/** Timeout for health checks and outbound POSTs to the graph server. */
export const FETCH_TIMEOUT_MS = 500

/** Default dashboard host when none is configured. */
export const DEFAULT_HOST = '127.0.0.1'

/** Default dashboard port when none is configured. */
export const DEFAULT_PORT = 8818

/** Maximum valid TCP port. */
export const MAX_PORT = 65_536
