#!/usr/bin/env bun
/**
 * @fileoverview mirror:init — full out-of-band build of the FAA registry index.
 * Downloads the Releasable Aircraft Database ZIP, parses the MASTER parts +
 * reference/status files, pre-joins, and writes the SQLite index. Idempotent and
 * resumable: re-running after an interrupt continues from the persisted state.
 * Run at Docker image build or as a one-shot job — never on server startup.
 * @module scripts/faa-mirror-init
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getMirror } from './_mirror-context.js';

const mirror = getMirror();
logger.info('Starting FAA registry mirror init (full build)');

// A full FAA build is well under an hour; cap the run so a hung download aborts.
const result = await mirror.runSync({ mode: 'init', signal: AbortSignal.timeout(3_600_000) });

logger.info(
  `FAA registry mirror init complete: ${result.recordsApplied} records applied across ${result.pagesFetched} pages (total ${result.total}).`,
);
await mirror.close();
process.exit(0);
