#!/usr/bin/env node
/**
 * @fileoverview mirror:verify — report the FAA registry index health: readiness,
 * sync status, last completion, record count, and a SQLite integrity check.
 * Exits non-zero when the mirror is not ready or integrity fails, so it can gate
 * a deployment or a post-build smoke check.
 * @module cli/faa-mirror-verify
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { withRegistrySnapshot } from '@/services/registry/registry-snapshot.js';
import { getMirror, initCliLogging } from './_mirror-context.js';

await initCliLogging();
const context = requestContextService.createRequestContext({ operation: 'mirror:verify' });
const mirror = getMirror();
const status = await mirror.status();
const recordCount = await mirror.store.count();

logger.info(
  `FAA registry mirror status: ready=${status.ready}, status=${status.status}, records=${recordCount}, total=${status.total ?? 0}, completedAt=${status.completedAt ?? 'never'}`,
);
if (status.error) logger.warning(`Last sync error: ${status.error}`);

try {
  withRegistrySnapshot(await mirror.raw(), () => undefined);
} catch (error) {
  const reason = error instanceof McpError ? error.data?.reason : undefined;
  switch (reason) {
    case 'mirror_not_ready':
      logger.error('Mirror is NOT ready — run mirror:init to build the index.', context);
      break;
    case 'mirror_empty':
      logger.error(
        'Mirror reports ready but the registration table is EMPTY. Re-run mirror:init (or mirror:refresh) to rebuild the index.',
        context,
      );
      break;
    case 'mirror_loading':
      logger.error(
        'Mirror is loading — wait for the rebuild, or re-run mirror:refresh if it was interrupted.',
        context,
      );
      break;
    default:
      throw error;
  }
  await mirror.close();
  process.exit(1);
}

const integrity = await mirror.store.integrityCheck();
if (!integrity.ok) {
  logger.error(`SQLite integrity check FAILED: ${integrity.results.join('; ')}`, context);
  await mirror.close();
  process.exit(1);
}

logger.info('FAA registry mirror integrity check passed.');
await mirror.close();
process.exit(0);
