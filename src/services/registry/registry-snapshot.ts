/**
 * @fileoverview Pin FAA readiness, source date, and request reads to a SQLite snapshot.
 * @module services/registry/registry-snapshot
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { REGISTRATION_TABLE, REGISTRY_GENERATION_TABLE } from './schema.js';

/** Source metadata read from the generation behind the query results. */
export interface RegistrySnapshot {
  dataAsOf?: string;
}

/** Check availability and perform synchronous reads in a single deferred transaction. */
export function withRegistrySnapshot<T>(
  handle: SqliteHandle,
  read: (snapshot: RegistrySnapshot) => T,
): T {
  return handle.transaction(() => {
    const marker = handle
      .prepare<{ loading: number; data_as_of: string | null }>(
        `SELECT loading, data_as_of FROM ${REGISTRY_GENERATION_TABLE} WHERE id = 1`,
      )
      .get();
    if (marker?.loading === 1) {
      throw serviceUnavailable(
        'The FAA registry index is loading. Retry after the rebuild completes.',
        { reason: 'mirror_loading', retryable: true },
      );
    }
    // The same durable completion marker used by Mirror.ready(), read here
    // synchronously to keep legacy readiness inside the SQLite snapshot.
    if (
      !marker &&
      !handle
        .prepare('SELECT 1 FROM mirror_sync_state WHERE id = 1 AND completed_at IS NOT NULL')
        .get()
    ) {
      throw serviceUnavailable(
        'The FAA registry index has not been built yet. Run the mirror:init script to download and index the registry before querying.',
        { reason: 'mirror_not_ready' },
      );
    }
    if (!handle.prepare(`SELECT 1 FROM ${REGISTRATION_TABLE} LIMIT 1`).get()) {
      throw serviceUnavailable(
        'The FAA registry index is present but empty — a rebuild was likely interrupted before it finished loading. Re-run the mirror:init (or mirror:refresh) script to rebuild the index.',
        { reason: 'mirror_empty' },
      );
    }
    return read(marker?.data_as_of ? { dataAsOf: marker.data_as_of } : {});
  });
}
