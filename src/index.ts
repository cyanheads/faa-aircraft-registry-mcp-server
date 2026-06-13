#!/usr/bin/env node
/**
 * @fileoverview faa-aircraft-registry-mcp-server entry point. Wires the registry
 * service (the on-disk FAA SQLite mirror) in setup(), registers the read-only
 * tools and the registration resource, and — under HTTP transport — schedules a
 * daily mirror refresh aligned to the FAA's nightly re-release. The index is
 * never built on startup; mirror:init runs out-of-band (Docker build / one-shot).
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { logger, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from './config/server-config.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { getRegistryService, initRegistryService } from './services/registry/registry-service.js';

const serverConfig = getServerConfig();

/**
 * Daily refresh cron. The FAA re-releases the ZIP at 11:30 PM Central; running a
 * little after that (06:00 UTC) picks up the new file. Five-field cron, server
 * local time as node-cron sees it — the exact minute is not load-bearing because
 * the corpus is queried far more than it changes.
 */
const REFRESH_CRON = '0 6 * * *';

await createApp({
  name: 'faa-aircraft-registry-mcp-server',
  title: 'faa-aircraft-registry-mcp-server',
  websiteUrl: 'https://github.com/cyanheads/faa-aircraft-registry-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  instructions:
    'Offline, keyless lookup of the US civil aircraft registry (the FAA Releasable Aircraft Database, indexed locally as SQLite + FTS5). Decode an N-number with faa_lookup_registration ("N12345" or "12345" both work); resolve active/deregistered/reserved status with faa_get_registration_status; search by owner/make-model/state/type/Mode S with faa_search_registrations; decode and discover manufacturer-model codes with faa_get_aircraft_type and faa_search_aircraft_types. Coded fields surface both the raw FAA code and the decoded label. Owner name and address are REDACTED by default (FAA_REDACT_OWNER_PII); when redacted, owner-name search is disabled and payloads carry ownerRedacted: true. The index must be built once via the mirror:init script before queries succeed.',
  landing: {
    requireAuth: false,
    tagline:
      'Offline US civil aircraft registry — decode an N-number to aircraft, engine, status, and owner; search by owner, type, or state.',
    repoRoot: 'https://github.com/cyanheads/faa-aircraft-registry-mcp-server',
    links: [
      {
        label: 'FAA Aircraft Registry',
        href: 'https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry',
        external: true,
      },
      {
        label: 'Releasable Aircraft Database',
        href: 'https://registry.faa.gov/database/ReleasableAircraft.zip',
        external: true,
      },
    ],
  },

  setup(core) {
    initRegistryService({
      redactOwnerPii: serverConfig.redactOwnerPii,
      mirrorPath: serverConfig.mirrorPath,
      databaseUrl: serverConfig.databaseUrl,
    });

    /**
     * Schedule the daily refresh only under HTTP transport — a long-lived server
     * process owns the cron. stdio operators run mirror:refresh out-of-band, so
     * scheduling there would attach a cron to a short-lived process.
     */
    if (core.config.mcpTransportType === 'http') {
      void scheduleDailyRefresh();
    }
  },
});

/** Register and start the daily mirror refresh job. */
async function scheduleDailyRefresh(): Promise<void> {
  await schedulerService.schedule(
    'faa-registry-refresh',
    REFRESH_CRON,
    async (jobCtx) => {
      logger.info('Starting scheduled FAA registry refresh', jobCtx);
      const result = await getRegistryService().mirrorInstance.runSync({ mode: 'refresh' });
      logger.info(`Scheduled FAA registry refresh complete: ${result.total} records`, jobCtx);
    },
    'Daily full rebuild of the FAA registry index from the latest Releasable Aircraft Database ZIP.',
  );
  schedulerService.start('faa-registry-refresh');
}
