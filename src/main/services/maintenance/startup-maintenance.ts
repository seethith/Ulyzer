import { createLogger } from '../../utils/logger';
import { AgentRunStateRepository } from '../db/repositories/agent-run-state.repo';

const log = createLogger('StartupMaintenance');

// Keep completed runs for a week (handy for inspection), and drop anything not
// touched in a month — by then a crashed/abandoned run won't be resumed.
const COMPLETED_RETENTION_DAYS = 7;
const STALE_RETENTION_DAYS = 30;

/**
 * Best-effort local housekeeping run once at launch. It only touches the local DB,
 * never blocks startup, and swallows its own errors — startup must not depend on it.
 */
export function runStartupMaintenance(): void {
  try {
    const runStates = new AgentRunStateRepository();
    // 1) Fix interrupted runs: a run still 'running' at startup crashed last session.
    const interrupted = runStates.reconcileInterrupted();
    // 2) Cleanup: bound the resume table.
    const prunedCompleted = runStates.pruneCompleted(COMPLETED_RETENTION_DAYS);
    const prunedStale = runStates.pruneOlderThan(STALE_RETENTION_DAYS);
    if (interrupted > 0 || prunedCompleted > 0 || prunedStale > 0) {
      log.info('run-state maintenance', { interrupted, prunedCompleted, prunedStale });
    }
  } catch (err) {
    log.warn('startup maintenance failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
