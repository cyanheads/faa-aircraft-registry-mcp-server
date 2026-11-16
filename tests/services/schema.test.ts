/**
 * @fileoverview Mirror-schema tests. Covers the auxiliary-table migration
 * against the framework's own runner rather than the hand-applied path the
 * fixture builder uses: the runner applies `up()` on a freshly created database
 * as well as on upgrade, so the reference/status tables and the aircraft_ref FTS
 * index must exist the moment a cold mirror opens.
 * @module tests/services/schema.test
 */

import { type SqliteHandle, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, describe, expect, it } from 'vitest';
import { visibleManufacturer } from '@/services/registry/registry-search.js';
import { withRegistrySnapshot } from '@/services/registry/registry-snapshot.js';
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

  it('preserves v1 rows and leaves their new fields unknown until a rebuild', async () => {
    const path = tempDbPath();
    const spec = registrationStoreSpec(path);
    const legacy = sqliteMirrorStore({
      ...spec,
      version: 1,
      migrations: spec.migrations?.filter((migration) => migration.version === 1) ?? [],
    });
    const old = await legacy.raw();
    old.exec(`
      INSERT INTO aircraft_ref (code, mfr, builder_cert_code) VALUES ('2072714', 'LEGACY NAME', '1');
      INSERT INTO registration (n_number, serial_number, mfr_mdl_code) VALUES ('12345', '00Ab-C', '2072714');
      INSERT INTO dereg (n_number, cancel_date) VALUES ('12345', '2026-01-01');
      UPDATE mirror_sync_state SET status = 'complete', completed_at = '2026-11-09T00:00:00Z' WHERE id = 1;
    `);
    await legacy.close();

    store = sqliteMirrorStore(spec);
    const handle = await store.raw();
    expect(withRegistrySnapshot(handle, (snapshot) => snapshot)).toEqual({});
    expect(handle.prepare('SELECT mfr, manufacturer_redacted FROM aircraft_ref').get()).toEqual({
      mfr: 'LEGACY NAME',
      manufacturer_redacted: null,
    });
    expect(handle.prepare('SELECT cancel_date, export_country, year_mfr FROM dereg').get()).toEqual(
      {
        cancel_date: '2026-01-01',
        export_country: null,
        year_mfr: null,
      },
    );
    expect(
      handle
        .prepare('SELECT serial_number FROM registration WHERE serial_number = ? COLLATE NOCASE')
        .get('00ab-c'),
    ).toEqual({
      serial_number: '00Ab-C',
    });
    expect(
      handle
        .prepare<{ detail: string }>(
          'EXPLAIN QUERY PLAN SELECT n_number FROM registration WHERE serial_number = ? COLLATE NOCASE',
        )
        .get('00ab-c')?.detail,
    ).toContain('idx_registration_serial_nocase');
  });

  it('pins date, readiness and row queries while another connection commits a replacement', async () => {
    const spec = registrationStoreSpec(tempDbPath());
    store = sqliteMirrorStore(spec);
    const reader = await store.raw();
    const writerStore = sqliteMirrorStore(spec);
    try {
      const writer = await writerStore.raw();
      writer.exec(`
        INSERT INTO registration(n_number) VALUES ('11111');
        INSERT INTO registry_generation VALUES (1, 'fixture', 1, 0, '2026-11-09');
      `);
      const readRows = () => reader.prepare('SELECT n_number FROM registration').all();
      const old = withRegistrySnapshot(reader, (snapshot) => {
        writer.transaction(() => {
          writer.exec(`
            DELETE FROM registration;
            INSERT INTO registration(n_number) VALUES ('22222'), ('33333');
            UPDATE registry_generation SET data_as_of = '2026-11-10';
          `);
        }, 'immediate');
        return { ...snapshot, rows: readRows() };
      });
      expect(old).toEqual({ dataAsOf: '2026-11-09', rows: [{ n_number: '11111' }] });
      expect(
        withRegistrySnapshot(reader, (snapshot) => ({ ...snapshot, rows: readRows() })),
      ).toEqual({
        dataAsOf: '2026-11-10',
        rows: [{ n_number: '22222' }, { n_number: '33333' }],
      });
    } finally {
      await writerStore.close();
    }
  });

  it('upgrades a stamped cold v1 store whose auxiliary tables were never created', async () => {
    const spec = registrationStoreSpec(tempDbPath());
    const oldStore = sqliteMirrorStore({ ...spec, version: 1, migrations: [] });
    await oldStore.raw();
    await oldStore.close();

    store = sqliteMirrorStore(spec);
    const handle = await store.raw();
    expect(handle.prepare('SELECT manufacturer_redacted FROM aircraft_ref').all()).toEqual([]);
    expect(() => withRegistrySnapshot(handle, () => undefined)).toThrow(
      expect.objectContaining({ data: { reason: 'mirror_not_ready' } }),
    );
  });
});

describe('registration search-filter indexes on an existing store', () => {
  const filterColumns = new Set(['eng_mfr_mdl_code', 'airworthiness_class_code', 'year_mfr']);
  const filterIndexes = [
    'registration_eng_mfr_mdl_code_idx',
    'registration_airworthiness_class_code_idx',
    'registration_year_mfr_idx',
  ];
  const indexNames = (handle: SqliteHandle) =>
    handle
      .prepare<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all()
      .map(({ name }) => name);
  const schemaVersion = (handle: SqliteHandle) =>
    handle.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get()?.v;

  it('creates the engine, class and year indexes at the next open without a version change', async () => {
    const spec = registrationStoreSpec(tempDbPath());
    const older = sqliteMirrorStore({
      ...spec,
      indexes: (spec.indexes ?? []).filter(
        ({ columns }) => !columns.some((c) => filterColumns.has(c)),
      ),
    });
    const before = await older.raw();
    before.exec(`
      INSERT INTO registration (n_number, eng_mfr_mdl_code, airworthiness_class_code, year_mfr)
      VALUES ('12345', '01234', '4', 1975);
    `);
    const version = schemaVersion(before);
    expect(version).toBe(spec.version);
    for (const name of filterIndexes) expect(indexNames(before)).not.toContain(name);
    await older.close();

    const upgraded = sqliteMirrorStore(spec);
    try {
      const handle = await upgraded.raw();
      expect(indexNames(handle)).toEqual(expect.arrayContaining(filterIndexes));
      expect(schemaVersion(handle)).toBe(version);
      expect(
        handle
          .prepare('SELECT n_number FROM registration WHERE eng_mfr_mdl_code = ? AND year_mfr >= ?')
          .all('01234', 1975),
      ).toEqual([{ n_number: '12345' }]);
    } finally {
      await upgraded.close();
    }
  });
});

describe('builder classification reset on upgrade from version 2', () => {
  const classification = (handle: SqliteHandle) =>
    handle
      .prepare<{ code: string; flag: number | null; make: string | null }>(
        `SELECT code, manufacturer_redacted AS flag, ${visibleManufacturer('ref.mfr', true)} AS make
           FROM aircraft_ref AS ref ORDER BY code`,
      )
      .all();
  const version = (handle: SqliteHandle) =>
    handle.prepare<{ v: number }>('SELECT MAX(version) AS v FROM schema_version').get()?.v;

  it('withholds every non-type-certificated name a version 2 store classified', async () => {
    const spec = registrationStoreSpec(tempDbPath());
    const v2 = sqliteMirrorStore({
      ...spec,
      version: 2,
      migrations: spec.migrations?.filter((migration) => migration.version <= 2) ?? [],
    });
    const old = await v2.raw();
    old.exec(`
      INSERT INTO aircraft_ref (code, mfr, builder_cert_code, manufacturer_redacted) VALUES
        ('3230000', 'CERTIFIED MAKER', '0', 0),
        ('3230001', 'JOHN A SMITH', '1', 0),
        ('3230002', 'PUBLIC KIT WORKS', '2', 0),
        ('3230003', 'DOE JANE', '1', 1),
        ('3230004', 'UNCODED MAKER', NULL, NULL);
    `);
    expect(version(old)).toBe(2);
    await v2.close();

    const upgraded = sqliteMirrorStore(spec);
    try {
      const handle = await upgraded.raw();
      expect(version(handle)).toBe(3);
      expect(classification(handle)).toEqual([
        { code: '3230000', flag: 0, make: 'CERTIFIED MAKER' },
        { code: '3230001', flag: null, make: null },
        { code: '3230002', flag: null, make: null },
        { code: '3230003', flag: null, make: null },
        { code: '3230004', flag: null, make: null },
      ]);
    } finally {
      await upgraded.close();
    }
  });

  it('keeps a version 3 classification across reopen', async () => {
    const path = tempDbPath();
    const first = sqliteMirrorStore(registrationStoreSpec(path));
    (await first.raw()).exec(`
      INSERT INTO aircraft_ref (code, mfr, builder_cert_code, manufacturer_redacted)
      VALUES ('3230001', 'PUBLIC KIT WORKS', '1', 0);
    `);
    await first.close();

    const reopened = sqliteMirrorStore(registrationStoreSpec(path));
    try {
      expect(classification(await reopened.raw())).toEqual([
        { code: '3230001', flag: 0, make: 'PUBLIC KIT WORKS' },
      ]);
    } finally {
      await reopened.close();
    }
  });
});
