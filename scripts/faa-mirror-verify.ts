#!/usr/bin/env bun
/**
 * @fileoverview mirror:verify — report the FAA registry index health: readiness,
 * sync status, last completion, record count, and a SQLite integrity check.
 * Exits non-zero when the mirror is not ready or integrity fails, so it can gate
 * a deployment or a post-build smoke check.
 * @module scripts/faa-mirror-verify
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getMirror } from './_mirror-context.js';

const mirror = getMirror();
const status = await mirror.status();

logger.info(
  `FAA registry mirror status: ready=${status.ready}, status=${status.status}, total=${status.total ?? 0}, completedAt=${status.completedAt ?? 'never'}`,
);
if (status.error) logger.warning(`Last sync error: ${status.error}`);

if (!status.ready) {
  logger.error('Mirror is NOT ready — run mirror:init to build the index.');
  await mirror.close();
  process.exit(1);
}

const integrity = await mirror.store.integrityCheck();
if (!integrity.ok) {
  logger.error(`SQLite integrity check FAILED: ${integrity.results.join('; ')}`);
  await mirror.close();
  process.exit(1);
}

logger.info('FAA registry mirror integrity check passed.');
await mirror.close();
process.exit(0);
