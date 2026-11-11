#!/usr/bin/env node
/**
 * @fileoverview faa-aircraft-registry-mcp-server entry point. Wires the registry
 * service (the on-disk FAA SQLite mirror) in setup(), registers the read-only
 * tools and the registration resource, and — under HTTP transport — schedules a
 * daily mirror refresh aligned to the FAA's nightly re-release. teardown()
 * releases both again on shutdown. The index is never built on startup;
 * mirror:init runs out-of-band (locally or in a one-shot container against the
 * persistent mirror volume).
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { scheduleDailyRefresh, teardownServer } from './lifecycle.js';
import { allResourceDefinitions } from './mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initRegistryService } from './services/registry/registry-service.js';

const serverConfig = getServerConfig();

await createApp({
  name: 'faa-aircraft-registry-mcp-server',
  title: 'faa-aircraft-registry-mcp-server',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  skills: 'skills',
  /**
   * Every tool is a single-shot read over the local index — no `ctx.requestInput`,
   * no `ctx.state`, nothing carried between calls. Declared here rather than left
   * to the deployment so the posture travels with the source; `MCP_SESSION_MODE`
   * still wins when it carries a meaningful value.
   */
  sessionMode: 'stateless',
  instructions:
    'Look up the offline US civil aircraft registry. Use faa_lookup_registration for an active N-number, or faa_get_registration_status for its current state and cancellation history. Find registrations by make/model token prefixes, exact manufacturer/model code or serial number, state, aircraft type, or Mode S. Discover manufacturer/model codes with faa_search_aircraft_types and get their specs with faa_get_aircraft_type. Coded fields include the raw FAA code and any known label. By default, owner details and personal builder names are withheld, and owner-name search is disabled. The operator must initialize the registry mirror before queries can succeed.',
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

  async setup(core) {
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
      await scheduleDailyRefresh();
    }
  },

  teardown: teardownServer,
});
