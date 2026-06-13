#!/usr/bin/env bun
/**
 * @fileoverview mirror:refresh — rebuild the FAA registry index from the latest
 * Releasable Aircraft Database ZIP. The FAA daily release is a full snapshot, so
 * a refresh performs a full rebuild; the index stays transactionally queryable
 * throughout. Run out-of-band for stdio deployments (the HTTP server schedules
 * this on a daily cron itself).
 * @module scripts/faa-mirror-refresh
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getMirror } from './_mirror-context.js';

const mirror = getMirror();
logger.info('Starting FAA registry mirror refresh');

const result = await mirror.runSync({ mode: 'refresh', signal: AbortSignal.timeout(3_600_000) });

logger.info(
  `FAA registry mirror refresh complete: ${result.recordsApplied} records applied (total ${result.total}).`,
);
await mirror.close();
process.exit(0);
