/**
 * @fileoverview Shared bootstrap for the mirror lifecycle CLI scripts
 * (faa-mirror-init / faa-mirror-refresh / faa-mirror-verify). Constructs the
 * registry service from the environment and hands back the underlying mirror —
 * no MCP transport, no tool registration. Imported by the three named scripts, so
 * it must travel with them in the npm tarball and the Docker image.
 * @module scripts/_mirror-context
 */

import type { Mirror } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { initRegistryService } from '@/services/registry/registry-service.js';

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
