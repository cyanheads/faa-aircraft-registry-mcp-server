/**
 * @fileoverview Startup and shutdown helpers wired into `createApp()`'s `setup`
 * and `teardown` hooks. Owns the daily mirror-refresh cron (HTTP transport only)
 * and the release of everything `setup()` allocated: the cron job and the open
 * SQLite handle behind the registry service.
 * @module lifecycle
 */

import { logger, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getRegistryService } from './services/registry/registry-service.js';

/** Scheduler job id for the daily mirror refresh. */
export const REFRESH_JOB_ID = 'faa-registry-refresh';

/**
 * Daily refresh cron. The FAA re-releases the ZIP at 11:30 PM Central; running a
 * little after that (06:00 UTC) picks up the new file. Five-field cron, server
 * local time as node-cron sees it — the exact minute is not load-bearing because
 * the corpus is queried far more than it changes.
 */
export const REFRESH_CRON = '0 6 * * *';

/** Register and start the daily mirror refresh job. */
export async function scheduleDailyRefresh(): Promise<void> {
  await schedulerService.schedule(
    REFRESH_JOB_ID,
    REFRESH_CRON,
    async (jobCtx) => {
      logger.info('Starting scheduled FAA registry refresh', jobCtx);
      const result = await getRegistryService().mirrorInstance.runSync({ mode: 'refresh' });
      logger.info(`Scheduled FAA registry refresh complete: ${result.total} records`, jobCtx);
    },
    'Daily full rebuild of the FAA registry index from the latest Releasable Aircraft Database ZIP.',
  );
  schedulerService.start(REFRESH_JOB_ID);
}

/**
 * Release what `setup()` allocated. Order is load-bearing: the refresh job is
 * removed before the mirror closes, because its tick calls `runSync` against
 * that same handle. The framework's own `schedulerService.destroyAll()` runs
 * only *after* this hook, so leaving the job registered would leave a window
 * in which a tick fires against a closed database.
 *
 * The job lookup is a presence check, not a guard against an impossible state:
 * stdio never schedules the cron at all, and `scheduleDailyRefresh()` is
 * fire-and-forget under HTTP, so a fast shutdown can arrive before it has
 * registered. `schedulerService.remove()` throws `NotFound` in both cases.
 */
export async function teardownServer(): Promise<void> {
  if (schedulerService.listJobs().some((job) => job.id === REFRESH_JOB_ID)) {
    schedulerService.remove(REFRESH_JOB_ID);
  }
  await getRegistryService().mirrorInstance.close();
}
