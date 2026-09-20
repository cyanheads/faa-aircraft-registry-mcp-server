/**
 * @fileoverview Mirror-schema tests. Covers the auxiliary-table migration
 * against the framework's own runner rather than the hand-applied path the
 * fixture builder uses: the runner applies `up()` on a freshly created database
 * as well as on upgrade, so the reference/status tables and the aircraft_ref FTS
 * index must exist the moment a cold mirror opens.
 * @module tests/services/schema.test
 */

import { sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AIRCRAFT_REF_FTS,
  AIRCRAFT_REF_TABLE,
  DEREG_TABLE,
  ENGINE_REF_TABLE,
  REGISTRATION_TABLE,
  RESERVED_TABLE,
  registrationStoreSpec,
} from '@/services/registry/schema.js';
import { tempDbPath } from '../fixtures/build-fixture-db.js';

/** Table/index names present in `sqlite_master` after a fresh open. */
async function objectNames(store: ReturnType<typeof sqliteMirrorStore>): Promise<Set<string>> {
  const handle = await store.raw();
  const rows = handle
    .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`)
    .all();
  return new Set(rows.map((row) => row.name));
}

describe('auxiliaryTablesMigration — fresh-database build', () => {
  let store: ReturnType<typeof sqliteMirrorStore> | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
  });

  it('creates every auxiliary table and index on a database that never existed', async () => {
    store = sqliteMirrorStore(registrationStoreSpec(tempDbPath()));
    const names = await objectNames(store);

    // The MirrorService primary table comes from the declarative spec…
    expect(names).toContain(REGISTRATION_TABLE);
    // …and everything below exists only because the migration ran on creation.
    for (const table of [AIRCRAFT_REF_TABLE, ENGINE_REF_TABLE, DEREG_TABLE, RESERVED_TABLE]) {
      expect(names).toContain(table);
    }
    expect(names).toContain(AIRCRAFT_REF_FTS);
    for (const index of [
      'idx_aircraft_ref_type',
      'idx_aircraft_ref_category',
      'idx_dereg_n_number',
      'idx_reserved_n_number',
    ]) {
      expect(names).toContain(index);
    }
  });

  it('leaves the auxiliary tables queryable and empty, not merely declared', async () => {
    store = sqliteMirrorStore(registrationStoreSpec(tempDbPath()));
    const handle = await store.raw();

    for (const table of [AIRCRAFT_REF_TABLE, ENGINE_REF_TABLE, DEREG_TABLE, RESERVED_TABLE]) {
      const row = handle.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get();
      expect(row?.n).toBe(0);
    }
    // The FTS5 virtual table is created inside the runner's transaction — prove
    // it is a working index, not just a name in sqlite_master.
    handle
      .prepare(`INSERT INTO ${AIRCRAFT_REF_FTS} (code, mfr, model) VALUES (?, ?, ?)`)
      .run('2072714', 'CESSNA', '172S');
    const hit = handle
      .prepare<{ code: string }>(
        `SELECT code FROM ${AIRCRAFT_REF_FTS} WHERE ${AIRCRAFT_REF_FTS} MATCH ?`,
      )
      .get('cessna');
    expect(hit?.code).toBe('2072714');
  });

  it('is idempotent — a second open of the same database re-runs nothing and still holds data', async () => {
    const path = tempDbPath();
    const first = sqliteMirrorStore(registrationStoreSpec(path));
    const firstHandle = await first.raw();
    firstHandle
      .prepare(`INSERT INTO ${ENGINE_REF_TABLE} (code, mfr, model) VALUES (?, ?, ?)`)
      .run('41514', 'LYCOMING', 'IO-360-L2A');
    await first.close();

    store = sqliteMirrorStore(registrationStoreSpec(path));
    const handle = await store.raw();
    const row = handle
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM ${ENGINE_REF_TABLE}`)
      .get();
    expect(row?.n).toBe(1);
  });
});
