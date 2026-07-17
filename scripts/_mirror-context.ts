/**
 * @fileoverview Shared bootstrap for the mirror lifecycle CLI scripts
 * (faa-mirror-init / faa-mirror-refresh / faa-mirror-verify). Constructs the
 * registry service from the environment and hands back the underlying mirror —
 * no MCP transport, no tool registration — and initializes the framework logger
 * so the scripts' status/progress output is actually emitted. Imported by the
 * three named scripts, so it must travel with them in the npm tarball and the
 * Docker image.
 * @module scripts/_mirror-context
 */

import type { Mirror } from '@cyanheads/mcp-ts-core/mirror';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { initRegistryService } from '@/services/registry/registry-service.js';

/**
 * Initialize the framework logger for a standalone CLI run. The lifecycle scripts
 * bypass `createApp()` — which owns logger init in the server path — so without
 * this every `logger.*` call in the scripts and the ingester is silently dropped:
 * `Logger.log()` returns early until `initialize()` resolves. Call once, before
 * any logging, at the top of each script.
 */
export async function initCliLogging(): Promise<void> {
  await logger.initialize();
}

/** Build the registry service from env config and return its mirror instance. */
export function getMirror(): Mirror {
  const config = getServerConfig();
  const service = initRegistryService({
    redactOwnerPii: config.redactOwnerPii,
    mirrorPath: config.mirrorPath,
    databaseUrl: config.databaseUrl,
  });
  return service.mirrorInstance;
}
