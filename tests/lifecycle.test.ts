/**
 * @fileoverview Shutdown-hook tests. `createApp({ teardown })` is the only thing
 * that releases what `setup()` allocated — the daily refresh cron and the open
 * SQLite handle behind the registry service — so both releases are asserted
 * here, along with the ordering that keeps a cron tick off a closed database.
 * @module tests/lifecycle.test
 */

import { schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { REFRESH_JOB_ID, scheduleDailyRefresh, teardownServer } from '@/lifecycle.js';
import {
  getRegistryService,
  initRegistryService,
  resetRegistryService,
} from '@/services/registry/registry-service.js';
import { buildFixtureDb, tempDbPath } from './fixtures/build-fixture-db.js';

/** Point the service singleton at a fresh fixture DB, as `setup()` does. */
async function initService(): Promise<void> {
  resetRegistryService();
  const path = tempDbPath();
  await buildFixtureDb(path);
  initRegistryService({
    redactOwnerPii: true,
    mirrorPath: path,
    databaseUrl: 'https://example.invalid/never-downloaded.zip',
  });
}

/** True when the refresh job is registered with the scheduler singleton. */
const jobRegistered = (): boolean =>
  schedulerService.listJobs().some((job) => job.id === REFRESH_JOB_ID);

afterEach(() => {
  if (jobRegistered()) schedulerService.remove(REFRESH_JOB_ID);
  resetRegistryService();
});

describe('teardownServer', () => {
  it('removes the daily refresh job the HTTP transport scheduled', async () => {
    await initService();
    await scheduleDailyRefresh();
    expect(jobRegistered()).toBe(true);

    await teardownServer();

    expect(jobRegistered()).toBe(false);
  });

  it('closes the mirror handle, so the open SQLite file is released', async () => {
    await initService();
    const handle = await getRegistryService().mirrorInstance.raw();
    // The handle is live before teardown — this is the baseline the next
    // assertion is a change from, not an incidental check.
    expect(handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM registration').get()?.n).toBe(
      4,
    );

    await teardownServer();

    expect(() =>
      handle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM registration').get(),
    ).toThrow();
  });

  it('is a no-op on the job under stdio, where no cron was ever scheduled', async () => {
    await initService();
    expect(jobRegistered()).toBe(false);

    // schedulerService.remove() throws NotFound on an unregistered id; teardown
    // must reach the mirror close regardless.
    await expect(teardownServer()).resolves.toBeUndefined();
    expect(jobRegistered()).toBe(false);
  });

  it('removes the job before closing the mirror the job would sync', async () => {
    await initService();
    await scheduleDailyRefresh();
    const order: string[] = [];

    const mirror = getRegistryService().mirrorInstance;
    const realClose = mirror.close.bind(mirror);
    mirror.close = async () => {
      order.push(`job-registered:${jobRegistered()}`);
      order.push('close');
      await realClose();
    };

    await teardownServer();

    // The cron's tick calls runSync() against this handle — it must already be
    // gone by the time close() runs, because the framework's own
    // schedulerService.destroyAll() does not run until after this hook returns.
    expect(order).toEqual(['job-registered:false', 'close']);
  });
});
