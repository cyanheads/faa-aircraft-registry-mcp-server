/**
 * @fileoverview Verifies the mirror lifecycle CLI bootstrap initializes the
 * framework logger. The three scripts (mirror:init/refresh/verify) bypass
 * createApp(), which owns logger init in the server path, so without an explicit
 * initialize() every logger.* call — script status plus the ingester's progress —
 * is silently dropped (Logger.log() returns early until initialized). Guards
 * issue #8.
 * @module tests/scripts/mirror-context
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { initCliLogging } from '../../scripts/_mirror-context.js';

describe('mirror CLI bootstrap — logging (issue #8)', () => {
  afterEach(async () => {
    if (logger.isInitialized()) await logger.close();
  });

  it('initializes the framework logger so script and ingest output is emitted', async () => {
    // Force the uninitialized state first, so the pass proves initCliLogging did
    // the work — not that an earlier import had already initialized the singleton.
    if (logger.isInitialized()) await logger.close();
    expect(logger.isInitialized()).toBe(false);

    await initCliLogging();

    expect(logger.isInitialized()).toBe(true);
  });
});
