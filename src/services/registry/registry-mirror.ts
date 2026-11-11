/**
 * @fileoverview Bind FAA rebuilds to the same SQLite lease used by the mirror runner.
 * @module services/registry/registry-mirror
 */

import {
  defineMirror,
  type Mirror,
  type SyncLease,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { createFaaIngester } from './ingest.js';
import { registrationStoreSpec } from './schema.js';

/** Build the shared read store and the lease-fenced FAA sync entry point. */
export function createRegistryMirror(options: { mirrorPath: string; databaseUrl: string }): Mirror {
  const store = sqliteMirrorStore(registrationStoreSpec(options.mirrorPath));
  const leases = store.syncLease;
  if (!leases) throw new Error('FAA rebuilds require a SQLite mirror sync lease.');
  // defineMirror serializes runSync calls on this instance before claiming.
  // Only the runner sees this claim wrapper. Other instances have their own closure.
  let claimedLease: SyncLease | undefined;
  const mirror = defineMirror({
    name: 'faa-registry',
    store: {
      ...store,
      syncLease: {
        ...leases,
        async claim(owner, ttlMs) {
          claimedLease = await leases.claim(owner, ttlMs);
          return claimedLease;
        },
      },
    },
    sync(ctx) {
      if (!claimedLease) throw new Error('FAA rebuild started without its SQLite sync lease.');
      return createFaaIngester(() => store.raw(), options.databaseUrl, claimedLease)(ctx);
    },
  });
  return { ...mirror, store };
}
